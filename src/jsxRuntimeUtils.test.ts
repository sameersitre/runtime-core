/**
 * Tests for jsxRuntimeUtils — symbol identity, path normalization, callSiteId
 * hashing. Conventions follow the bolt vitest skills:
 *   - vitest-utility-function-tests: two-level describe (module → function),
 *     behaviour-grouped tests with multiple expects, `test.each` for
 *     parameterised rows.
 *   - vitest-default-dummy-data + vitest-faker-utilities: baselines in
 *     `.test.fixtures.ts`, builders in `.test.builders.ts`.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  FLOTRACE_SOURCE,
  JSX_RUNTIME_ACTIVE_KEY,
  normalizeJsxSourcePath,
  computeCallSiteId,
  recordCallSiteRender,
  getCallSiteRenders,
  getCallSiteRenderRate,
  clearCallSiteRenders,
  markJsxRuntimeActive,
  isJsxRuntimeActive,
  __resetJsxRuntimeAdoptionForTesting,
  __resetDuplicateKeyStateForTesting,
  detectInlineLiterals,
  computeCallSiteMetricsPayload,
  recordJsxKey,
  setDuplicateKeyEmitter,
  type DuplicateKeyEvent,
  type FlotraceJsxSource,
} from './jsxRuntimeUtils';
import { BUNDLER_PATH_STYLES } from './jsxRuntimeUtils.test.fixtures';
import { createJsxSourceArg } from './jsxRuntimeUtils.test.builders';

describe('jsxRuntimeUtils', () => {
  describe('FLOTRACE_SOURCE symbol', () => {
    test('uses Symbol.for registry so identity is global across module instances', () => {
      // Two independent lookups via the global registry must yield identical
      // symbols — load-bearing for the writer (dev runtime) + reader (walker)
      // to agree when both are bundled separately.
      expect(FLOTRACE_SOURCE).toBe(Symbol.for('flotrace.source'));
      expect(JSX_RUNTIME_ACTIVE_KEY).toBe(Symbol.for('flotrace.jsx-runtime-active'));
      // Different identifiers must not collide.
      expect(FLOTRACE_SOURCE).not.toBe(JSX_RUNTIME_ACTIVE_KEY);
    });

    test('is non-enumerable on a host object (does not appear in Object.keys)', () => {
      const props: Record<string | symbol, unknown> = { foo: 1, bar: 2 };
      props[FLOTRACE_SOURCE] = { fileName: 'x.tsx', lineNumber: 1, columnNumber: 1 };
      // Object.keys ignores symbol keys — required so React's unknown-prop
      // warning + DOM-attribute pipeline never sees it.
      expect(Object.keys(props)).toEqual(['foo', 'bar']);
      // JSON.stringify also skips it — no PII leak in serialised props.
      expect(JSON.parse(JSON.stringify(props))).toEqual({ foo: 1, bar: 2 });
      // But it IS accessible via the symbol.
      expect(props[FLOTRACE_SOURCE]).toBeDefined();
    });
  });

  describe('normalizeJsxSourcePath', () => {
    test.each(BUNDLER_PATH_STYLES)(
      'normalizes $label → canonical form',
      ({ raw, normalized }) => {
        expect(normalizeJsxSourcePath(raw)).toBe(normalized);
      },
    );

    test('is idempotent — calling twice produces the same result', () => {
      for (const { raw } of BUNDLER_PATH_STYLES) {
        const once = normalizeJsxSourcePath(raw);
        const twice = normalizeJsxSourcePath(once);
        expect(twice).toBe(once);
      }
    });

    test('leaves unknown prefixes untouched (Turbopack [project], etc.)', () => {
      // Turbopack's [project]/... style has no documented stable prefix; we
      // leave it alone rather than guess. Drive-letter rule still doesn't
      // match (starts with `[`).
      expect(normalizeJsxSourcePath('[project]/src/Foo.tsx')).toBe(
        '[project]/src/Foo.tsx',
      );
    });
  });

  describe('computeCallSiteId', () => {
    test('produces an 8-char lowercase hex string', () => {
      const id = computeCallSiteId(createJsxSourceArg());
      expect(id).toMatch(/^[0-9a-f]{8}$/);
    });

    test('is deterministic — same input produces same hash', () => {
      const a = computeCallSiteId(createJsxSourceArg());
      const b = computeCallSiteId(createJsxSourceArg());
      expect(a).toBe(b);
    });

    test('changes when line, column, or file change', () => {
      const base = computeCallSiteId(createJsxSourceArg());
      const diffLine = computeCallSiteId(createJsxSourceArg({ lineNumber: 43 }));
      const diffCol = computeCallSiteId(createJsxSourceArg({ columnNumber: 9 }));
      const diffFile = computeCallSiteId(
        createJsxSourceArg({ fileName: 'src/components/Footer.tsx' }),
      );
      expect(diffLine).not.toBe(base);
      expect(diffCol).not.toBe(base);
      expect(diffFile).not.toBe(base);
    });

    test('column matters — adjacent JSX on the same line gets distinct IDs', () => {
      // PRD-JSX-RUNTIME §13 Q2: <X /><Y /> on one line must be distinguishable.
      const x = computeCallSiteId(createJsxSourceArg({ columnNumber: 1 }));
      const y = computeCallSiteId(createJsxSourceArg({ columnNumber: 8 }));
      expect(x).not.toBe(y);
    });

    test('Vite-Windows and Webpack-Windows hash the same source line identically', () => {
      // Regression: the Windows-drive lowercase rule used to skip when Vite
      // emitted `file:///C:/...` (leading slash blocked the `^[a-zA-Z]:` regex
      // match), causing per-callsite metrics to fork between Vite-dev and a
      // Webpack-bundled production preview on the same machine.
      const viteWindows = computeCallSiteId({
        fileName: 'file:///C:/Users/foo/src/Foo.tsx',
        lineNumber: 10,
        columnNumber: 5,
      });
      const webpackWindowsAbs = computeCallSiteId({
        fileName: 'c:/Users/foo/src/Foo.tsx',
        lineNumber: 10,
        columnNumber: 5,
      });
      const uppercaseDrive = computeCallSiteId({
        fileName: 'C:/Users/foo/src/Foo.tsx',
        lineNumber: 10,
        columnNumber: 5,
      });
      expect(viteWindows).toBe(webpackWindowsAbs);
      expect(viteWindows).toBe(uppercaseDrive);
    });

    test('produces the same hash for the same source line across bundler path styles', () => {
      // Load-bearing: per-callsite metrics + HMR-stable watches break when the
      // same line of code hashes differently under Vite vs Webpack vs Turbopack.
      const ids = BUNDLER_PATH_STYLES
        // Filter out the Windows rows — they represent a different file path
        // (Windows drive vs absolute POSIX) and should NOT collide.
        .filter(({ raw }) => !/^[a-zA-Z]:[\\/]/.test(raw))
        // All non-Windows fixtures resolve to either `/abs/src/Foo.tsx` or
        // `src/Foo.tsx` — bucket by normalized output then assert each bucket
        // produces one hash.
        .reduce<Record<string, string[]>>((acc, { raw, normalized }) => {
          const id = computeCallSiteId({
            fileName: raw,
            lineNumber: 10,
            columnNumber: 5,
          });
          (acc[normalized] ??= []).push(id);
          return acc;
        }, {});

      for (const bucket of Object.values(ids)) {
        // Every entry in a bucket must have the same hash.
        const first = bucket[0];
        for (const id of bucket) {
          expect(id).toBe(first);
        }
      }
    });
  });

  describe('ring buffer — recordCallSiteRender / getCallSiteRenders', () => {
    // Ring buffer is module-scoped state; clear before each test to avoid
    // cross-test bleed.
    test('starts empty and appends in order', () => {
      clearCallSiteRenders();
      expect(getCallSiteRenders('abc')).toEqual([]);
      recordCallSiteRender('abc', 100);
      recordCallSiteRender('abc', 200);
      recordCallSiteRender('abc', 300);
      expect(getCallSiteRenders('abc')).toEqual([100, 200, 300]);
    });

    test('caps at 60 entries (FIFO eviction)', () => {
      clearCallSiteRenders();
      for (let i = 0; i < 200; i++) recordCallSiteRender('hot', i);
      const arr = getCallSiteRenders('hot');
      expect(arr.length).toBe(60);
      // Oldest entries evicted — last 60 retained (140..199).
      expect(arr[0]).toBe(140);
      expect(arr[arr.length - 1]).toBe(199);
    });

    test('tracks each callSiteId independently', () => {
      clearCallSiteRenders();
      recordCallSiteRender('a', 1);
      recordCallSiteRender('b', 2);
      recordCallSiteRender('a', 3);
      expect(getCallSiteRenders('a')).toEqual([1, 3]);
      expect(getCallSiteRenders('b')).toEqual([2]);
    });

    test('clearCallSiteRenders wipes all callSites', () => {
      recordCallSiteRender('x', 1);
      recordCallSiteRender('y', 2);
      clearCallSiteRenders();
      expect(getCallSiteRenders('x')).toEqual([]);
      expect(getCallSiteRenders('y')).toEqual([]);
    });
  });

  describe('getCallSiteRenderRate', () => {
    test('returns 0 for unknown callSite', () => {
      clearCallSiteRenders();
      expect(getCallSiteRenderRate('never-seen')).toBe(0);
    });

    test('returns renders-per-second over the window (inclusive of cutoff)', () => {
      clearCallSiteRenders();
      // 5 renders evenly across the last 5 seconds → 1/sec.
      const now = 10000;
      for (let i = 0; i < 5; i++) recordCallSiteRender('site', now - i * 1000);
      expect(getCallSiteRenderRate('site', 5000, now)).toBeCloseTo(1, 5);
    });

    test('excludes renders older than the window', () => {
      clearCallSiteRenders();
      const now = 10000;
      recordCallSiteRender('site', now - 6000); // outside 5s window
      recordCallSiteRender('site', now - 1000); // inside
      recordCallSiteRender('site', now - 500); // inside
      // 2 renders within 5s window → 0.4/sec.
      expect(getCallSiteRenderRate('site', 5000, now)).toBeCloseTo(0.4, 5);
    });

    test('returns 0 for a buffer with only out-of-window entries', () => {
      clearCallSiteRenders();
      recordCallSiteRender('cold', 100);
      // Window starts at 10000 - 5000 = 5000; the only entry (100) is older.
      expect(getCallSiteRenderRate('cold', 5000, 10000)).toBe(0);
    });
  });

  describe('adoption sentinel — markJsxRuntimeActive / isJsxRuntimeActive', () => {
    test('default state is inactive', () => {
      __resetJsxRuntimeAdoptionForTesting();
      expect(isJsxRuntimeActive()).toBe(false);
    });

    test('mark sets the global sentinel', () => {
      __resetJsxRuntimeAdoptionForTesting();
      markJsxRuntimeActive();
      expect(isJsxRuntimeActive()).toBe(true);
      // Sentinel must be reachable via the global Symbol.for registry — load-
      // bearing for the walker to detect adoption from a separately-bundled
      // copy of runtime-core.
      const fromGlobal = (globalThis as Record<symbol, unknown>)[
        Symbol.for('flotrace.jsx-runtime-active')
      ];
      expect(fromGlobal).toBe(true);
    });

    test('mark is idempotent — calling twice keeps it active', () => {
      __resetJsxRuntimeAdoptionForTesting();
      markJsxRuntimeActive();
      markJsxRuntimeActive();
      expect(isJsxRuntimeActive()).toBe(true);
    });

    test('reset helper restores inactive state (test-only)', () => {
      markJsxRuntimeActive();
      __resetJsxRuntimeAdoptionForTesting();
      expect(isJsxRuntimeActive()).toBe(false);
    });
  });

  describe('detectInlineLiterals', () => {
    test('returns undefined when no inline literals present', () => {
      expect(detectInlineLiterals({})).toBeUndefined();
      expect(detectInlineLiterals({ count: 5, title: 'Hi' })).toBeUndefined();
    });

    test('flags anonymous arrow functions as "fn"', () => {
      const onClick = () => undefined;
      // Anonymous arrows have an empty .name when not assigned to a const at
      // the call site. Force-empty here to model the JSX-time captured form.
      Object.defineProperty(onClick, 'name', { value: '' });
      expect(detectInlineLiterals({ onClick })).toEqual({ onClick: 'fn' });
    });

    test('does NOT flag named functions (useCallback / methods)', () => {
      // useCallback returns a function with the inner fn's name preserved.
      function handleClick() {}
      const named = handleClick;
      expect(detectInlineLiterals({ onClick: named })).toBeUndefined();
    });

    test('flags non-empty arrays as "arr"', () => {
      expect(detectInlineLiterals({ items: [1, 2, 3] })).toEqual({ items: 'arr' });
    });

    test('does NOT flag empty arrays (usually intentional defaults)', () => {
      expect(detectInlineLiterals({ items: [] })).toBeUndefined();
    });

    test('flags plain objects as "obj"', () => {
      expect(detectInlineLiterals({ style: { color: 'red' } })).toEqual({
        style: 'obj',
      });
    });

    test('flags null-prototype objects (Object.create(null))', () => {
      const bag = Object.create(null) as Record<string, unknown>;
      bag.foo = 1;
      expect(detectInlineLiterals({ data: bag })).toEqual({ data: 'obj' });
    });

    test('does NOT flag class instances (non-plain prototype)', () => {
      class Box {
        value = 1;
      }
      expect(detectInlineLiterals({ box: new Box() })).toBeUndefined();
    });

    test('does NOT flag elements that carry our own FLOTRACE_SOURCE marker', () => {
      // Defensive — same JSX runtime, nested element passed inline. The
      // marker presence is unambiguous proof it was processed by our jsxDEV.
      const element = { foo: 1, [FLOTRACE_SOURCE]: { fileName: 'x' } };
      expect(detectInlineLiterals({ child: element })).toBeUndefined();
    });

    test('does NOT flag React elements from another runtime ($$typeof marker)', () => {
      // Mixed-runtime codebase: file A uses our jsx-runtime, file B uses a
      // different jsxImportSource. An element from B passed as a prop to
      // A would NOT carry FLOTRACE_SOURCE but DOES carry $$typeof set to
      // one of React's element-type registry symbols. Without the $$typeof
      // skip, this would false-positive as an inline 'obj' literal.
      for (const typeOf of [
        Symbol.for('react.element'),
        Symbol.for('react.transitional.element'),
      ]) {
        const foreignElement = {
          $$typeof: typeOf,
          type: 'div',
          props: { children: 'hi' },
          key: null,
          ref: null,
        };
        expect(detectInlineLiterals({ child: foreignElement })).toBeUndefined();
      }
    });

    test('skips KNOWN_REACT_PROPS (key, ref, children, className)', () => {
      const noisyFn = () => undefined;
      Object.defineProperty(noisyFn, 'name', { value: '' });
      const props = {
        key: 'k',
        ref: noisyFn,
        children: [1, 2, 3],
        className: 'btn',
        onClick: noisyFn,
      };
      // Only `onClick` should be reported — every other key is in the skip set.
      expect(detectInlineLiterals(props)).toEqual({ onClick: 'fn' });
    });

    test('flags multiple inline literals in one props bag', () => {
      const anon = () => undefined;
      Object.defineProperty(anon, 'name', { value: '' });
      expect(
        detectInlineLiterals({
          onClick: anon,
          items: [1],
          style: { color: 'red' },
          title: 'static',
        }),
      ).toEqual({
        onClick: 'fn',
        items: 'arr',
        style: 'obj',
      });
    });
  });

  // ─── Phase 4: callSiteMetrics + duplicate-key emission ──────────────────

  describe('computeCallSiteMetricsPayload', () => {
    test('returns null when no callsite has recent activity', () => {
      clearCallSiteRenders();
      expect(computeCallSiteMetricsPayload(5000, 10000)).toBeNull();
    });

    test('returns null when all callsite buffers exist but every entry is outside the window', () => {
      clearCallSiteRenders();
      // Record at t=100, query at t=10000 with 5s window → cutoff=5000 → 100 < 5000.
      recordCallSiteRender('a', 100);
      recordCallSiteRender('b', 500);
      expect(computeCallSiteMetricsPayload(5000, 10000)).toBeNull();
    });

    test('emits one entry per callsite with non-zero activity (renders/sec value)', () => {
      clearCallSiteRenders();
      const now = 10000;
      // 5 renders evenly over the last 5s for "hot" → 1/sec
      for (let i = 0; i < 5; i++) recordCallSiteRender('hot', now - i * 1000);
      // 1 render at t=now for "warm" → 0.2/sec
      recordCallSiteRender('warm', now);
      // 1 render outside window for "cold" → 0/sec (excluded)
      recordCallSiteRender('cold', 100);
      const payload = computeCallSiteMetricsPayload(5000, now);
      expect(payload).not.toBeNull();
      expect(Object.keys(payload!)).toEqual(expect.arrayContaining(['hot', 'warm']));
      expect(Object.keys(payload!)).not.toContain('cold');
      expect(payload!.hot).toBeCloseTo(1, 5);
      expect(payload!.warm).toBeCloseTo(0.2, 5);
    });
  });

  describe('duplicate-key detection — recordJsxKey + microtask flush', () => {
    const SOURCE_A: FlotraceJsxSource = {
      fileName: 'src/List.tsx',
      lineNumber: 10,
      columnNumber: 8,
      callSiteId: 'aaaaaaaa',
    };
    const SOURCE_B: FlotraceJsxSource = {
      fileName: 'src/Other.tsx',
      lineNumber: 20,
      columnNumber: 4,
      callSiteId: 'bbbbbbbb',
    };

    test('emits ONE event per (callSiteId, key) pair when count ≥ 2', async () => {
      __resetDuplicateKeyStateForTesting();
      const emitter = vi.fn<(evt: DuplicateKeyEvent) => void>();
      setDuplicateKeyEmitter(emitter);

      // Two JSX calls at the SAME callsite with the SAME key — classic
      // `items.map(item => <Row key={item.id}/>)` where two items have the
      // same id.
      recordJsxKey(SOURCE_A, '42');
      recordJsxKey(SOURCE_A, '42');
      await Promise.resolve(); // drain microtask queue

      expect(emitter).toHaveBeenCalledTimes(1);
      expect(emitter).toHaveBeenCalledWith({
        callSiteId: 'aaaaaaaa',
        fileName: 'src/List.tsx',
        lineNumber: 10,
        columnNumber: 8,
        duplicateKey: '42',
        occurrences: 2,
      });
    });

    test('does NOT emit when a key appears only once per callsite', async () => {
      __resetDuplicateKeyStateForTesting();
      const emitter = vi.fn<(evt: DuplicateKeyEvent) => void>();
      setDuplicateKeyEmitter(emitter);

      recordJsxKey(SOURCE_A, '1');
      recordJsxKey(SOURCE_A, '2');
      recordJsxKey(SOURCE_A, '3');
      await Promise.resolve();

      expect(emitter).not.toHaveBeenCalled();
    });

    test('keeps batches distinct across separate microtask drains (commits)', async () => {
      __resetDuplicateKeyStateForTesting();
      const emitter = vi.fn<(evt: DuplicateKeyEvent) => void>();
      setDuplicateKeyEmitter(emitter);

      // First commit — 2 duplicates → emit once.
      recordJsxKey(SOURCE_A, '42');
      recordJsxKey(SOURCE_A, '42');
      await Promise.resolve();
      expect(emitter).toHaveBeenCalledTimes(1);

      emitter.mockClear();

      // Second commit — same key, but the new batch starts fresh. The
      // SECOND time a key is recorded in the new batch, count climbs to 2,
      // and emit fires again. If the batch leaked across commits, count
      // would already be 3+ → still emits, but with occurrences=4.
      recordJsxKey(SOURCE_A, '42');
      recordJsxKey(SOURCE_A, '42');
      await Promise.resolve();
      expect(emitter).toHaveBeenCalledTimes(1);
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({ occurrences: 2 }),
      );
    });

    test('coerces number + string keys to the same comparison value (matches React semantics)', async () => {
      __resetDuplicateKeyStateForTesting();
      const emitter = vi.fn<(evt: DuplicateKeyEvent) => void>();
      setDuplicateKeyEmitter(emitter);

      // React's reconciler coerces both to "1" — we mirror that so a mixed
      // <X key="1"/><X key={1}/> at the same call site detects as a dupe.
      recordJsxKey(SOURCE_A, '1');
      recordJsxKey(SOURCE_A, 1);
      await Promise.resolve();

      expect(emitter).toHaveBeenCalledTimes(1);
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({ duplicateKey: '1', occurrences: 2 }),
      );
    });

    test('does NOT emit for null or undefined keys (React treats those as "no key")', async () => {
      __resetDuplicateKeyStateForTesting();
      const emitter = vi.fn<(evt: DuplicateKeyEvent) => void>();
      setDuplicateKeyEmitter(emitter);

      recordJsxKey(SOURCE_A, null);
      recordJsxKey(SOURCE_A, undefined);
      recordJsxKey(SOURCE_A, null);
      await Promise.resolve();

      expect(emitter).not.toHaveBeenCalled();
    });

    test('does NOT throw on Symbol keys (String(symbol) would TypeError)', async () => {
      // Real footgun: our wrapper runs BEFORE React processes the key, so a
      // user JSX call with `key={Symbol()}` would crash the wrapper if we
      // String()-coerced unconditionally. Filter to primitive types only.
      __resetDuplicateKeyStateForTesting();
      const emitter = vi.fn<(evt: DuplicateKeyEvent) => void>();
      setDuplicateKeyEmitter(emitter);

      expect(() => recordJsxKey(SOURCE_A, Symbol('x'))).not.toThrow();
      expect(() => recordJsxKey(SOURCE_A, Symbol('x'))).not.toThrow();
      await Promise.resolve();

      // Symbol keys aren't tracked → no duplicate event fires even on repeats.
      expect(emitter).not.toHaveBeenCalled();
    });

    test('does NOT false-positive on object keys (String({}) === "[object Object]")', async () => {
      // Two distinct {} objects would both coerce to `'[object Object]'` and
      // collide in the batch map as duplicates of each other. React rejects
      // non-primitive keys anyway — surface that via React's own warning, not
      // a misleading "duplicate key" report.
      __resetDuplicateKeyStateForTesting();
      const emitter = vi.fn<(evt: DuplicateKeyEvent) => void>();
      setDuplicateKeyEmitter(emitter);

      recordJsxKey(SOURCE_A, { foo: 1 });
      recordJsxKey(SOURCE_A, { bar: 2 });
      await Promise.resolve();

      expect(emitter).not.toHaveBeenCalled();
    });

    test('detects duplicates on number + boolean keys (primitive coercion still applies)', async () => {
      __resetDuplicateKeyStateForTesting();
      const emitter = vi.fn<(evt: DuplicateKeyEvent) => void>();
      setDuplicateKeyEmitter(emitter);

      // Boolean keys are valid (rare but legal in React). Two `true`s at the
      // same callsite SHOULD detect.
      recordJsxKey(SOURCE_A, true);
      recordJsxKey(SOURCE_A, true);
      await Promise.resolve();

      expect(emitter).toHaveBeenCalledTimes(1);
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({ duplicateKey: 'true', occurrences: 2 }),
      );
    });

    test('separates duplicates by callSiteId — two different call sites with the same key do not collide', async () => {
      __resetDuplicateKeyStateForTesting();
      const emitter = vi.fn<(evt: DuplicateKeyEvent) => void>();
      setDuplicateKeyEmitter(emitter);

      recordJsxKey(SOURCE_A, 'shared');
      recordJsxKey(SOURCE_B, 'shared');
      await Promise.resolve();

      expect(emitter).not.toHaveBeenCalled();
    });

    test('emits N occurrences when key appears N times (≥ 3 case)', async () => {
      __resetDuplicateKeyStateForTesting();
      const emitter = vi.fn<(evt: DuplicateKeyEvent) => void>();
      setDuplicateKeyEmitter(emitter);

      for (let i = 0; i < 5; i++) recordJsxKey(SOURCE_A, 'dup');
      await Promise.resolve();

      expect(emitter).toHaveBeenCalledTimes(1);
      expect(emitter).toHaveBeenCalledWith(
        expect.objectContaining({ occurrences: 5 }),
      );
    });

    test('silently drops events when no emitter is registered', async () => {
      __resetDuplicateKeyStateForTesting();
      // No setDuplicateKeyEmitter call — null emitter.
      recordJsxKey(SOURCE_A, 'x');
      recordJsxKey(SOURCE_A, 'x');
      // Should NOT throw on flush — the microtask just clears the batch.
      await expect(Promise.resolve()).resolves.toBeUndefined();
    });
  });
});
