/**
 * Tests for the JSX-runtime integration in fiberTreeWalker:
 *
 *   - readJsxSourceFromFiber: reads + validates the FLOTRACE_SOURCE symbol off
 *     a fiber's memoizedProps.
 *   - resolveSourceConfidence: four-tier decision tree (exact / inferred /
 *     package / unknown).
 *   - resolveEffectiveSourcePath: priority ladder (JSX runtime → _debugSource
 *     → _debugOwner → _debugStack).
 *
 * The helpers are file-local in fiberTreeWalker.ts; we reach them via the
 * `__*ForTesting` escape-hatches (same convention as
 * `__walkFiberForTesting` / `__setWalkerFilterConfigForTesting`).
 */
import { describe, expect, test } from 'vitest';
import {
  __readJsxSourceFromFiberForTesting as readJsxSourceFromFiber,
  __resolveSourceConfidenceForTesting as resolveSourceConfidence,
  __resolveEffectiveSourcePathForTesting as resolveEffectiveSourcePath,
  type Fiber,
} from './fiberTreeWalker';
import { FLOTRACE_SOURCE, type FlotraceJsxSource } from './jsxRuntimeUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic fiber builder — only the fields the helpers actually read.
// ─────────────────────────────────────────────────────────────────────────────

function createFiber(override: Partial<Fiber> = {}): Fiber {
  return {
    // Minimum viable Fiber shape — fill with no-op defaults.
    tag: 0,
    type: null,
    key: null,
    child: null,
    sibling: null,
    return: null,
    memoizedProps: null,
    pendingProps: null,
    memoizedState: null,
    ...override,
  } as Fiber;
}

const FULL_SOURCE: FlotraceJsxSource = {
  fileName: 'src/components/Header.tsx',
  lineNumber: 42,
  columnNumber: 8,
  callSiteId: 'deadbeef',
};

describe('fiberTreeWalker — JSX runtime integration', () => {
  describe('readJsxSourceFromFiber', () => {
    test('returns undefined when memoizedProps is null', () => {
      expect(readJsxSourceFromFiber(createFiber({ memoizedProps: null }))).toBeUndefined();
    });

    test('returns undefined when symbol is absent from props', () => {
      const fiber = createFiber({ memoizedProps: { title: 'Hi' } });
      expect(readJsxSourceFromFiber(fiber)).toBeUndefined();
    });

    test('returns the FlotraceJsxSource when symbol is present and shape is valid', () => {
      const fiber = createFiber({
        memoizedProps: {
          title: 'Hi',
          [FLOTRACE_SOURCE]: FULL_SOURCE,
        } as Record<string | symbol, unknown> as Record<string, unknown>,
      });
      expect(readJsxSourceFromFiber(fiber)).toBe(FULL_SOURCE);
    });

    test.each([
      ['missing fileName', { lineNumber: 1, columnNumber: 1, callSiteId: 'a' }],
      ['fileName not a string', { fileName: 123, lineNumber: 1, columnNumber: 1, callSiteId: 'a' }],
      [
        'lineNumber not a number',
        { fileName: 'x', lineNumber: '1', columnNumber: 1, callSiteId: 'a' },
      ],
      [
        'columnNumber not a number',
        { fileName: 'x', lineNumber: 1, columnNumber: '1', callSiteId: 'a' },
      ],
      [
        'callSiteId not a string',
        { fileName: 'x', lineNumber: 1, columnNumber: 1, callSiteId: 123 },
      ],
    ])('rejects malformed shape: %s', (_label, malformed) => {
      // Defensive: a Symbol.for('flotrace.source') collision from unrelated
      // tooling must not produce phantom node attribution.
      const fiber = createFiber({
        memoizedProps: {
          [FLOTRACE_SOURCE]: malformed,
        } as Record<string | symbol, unknown> as Record<string, unknown>,
      });
      expect(readJsxSourceFromFiber(fiber)).toBeUndefined();
    });

    test('returns undefined for non-object symbol value (string / number / null)', () => {
      for (const malformed of ['oops', 42, null]) {
        const fiber = createFiber({
          memoizedProps: {
            [FLOTRACE_SOURCE]: malformed,
          } as Record<string | symbol, unknown> as Record<string, unknown>,
        });
        expect(readJsxSourceFromFiber(fiber)).toBeUndefined();
      }
    });
  });

  describe('resolveSourceConfidence — four-tier decision tree', () => {
    test('framework wins over any source signal — returns "package"', () => {
      // A framework wrapper that happens to carry _debugSource (e.g. a
      // user-authored component wrapped via vendored framework HOC) must
      // still classify as `package` so the UI doesn't surface a file:line
      // link or `?` pill on a framework wrapper.
      const fiber = createFiber({
        _debugSource: { fileName: 'fw/Wrapper.tsx', lineNumber: 1 },
      });
      expect(resolveSourceConfidence(fiber, true, false)).toBe('package');
    });

    test('library wins over any source signal — returns "package"', () => {
      const fiber = createFiber({
        _debugSource: { fileName: 'node_modules/@radix-ui/popover/index.tsx', lineNumber: 1 },
      });
      expect(resolveSourceConfidence(fiber, false, true)).toBe('package');
    });

    test('JSX-runtime symbol present → "exact"', () => {
      const fiber = createFiber({
        memoizedProps: {
          [FLOTRACE_SOURCE]: FULL_SOURCE,
        } as Record<string | symbol, unknown> as Record<string, unknown>,
      });
      expect(resolveSourceConfidence(fiber, false, false)).toBe('exact');
    });

    test('_debugSource populated but no JSX symbol → "exact"', () => {
      const fiber = createFiber({
        _debugSource: { fileName: 'src/Foo.tsx', lineNumber: 10 },
      });
      expect(resolveSourceConfidence(fiber, false, false)).toBe('exact');
    });

    test('only owner-chain _debugSource → "inferred"', () => {
      const owner = createFiber({
        _debugSource: { fileName: 'src/Owner.tsx', lineNumber: 5 },
      });
      const fiber = createFiber({ _debugOwner: owner });
      expect(resolveSourceConfidence(fiber, false, false)).toBe('inferred');
    });

    test('no source signal at any tier → "unknown"', () => {
      const fiber = createFiber();
      expect(resolveSourceConfidence(fiber, false, false)).toBe('unknown');
    });
  });

  describe('resolveEffectiveSourcePath — priority ladder', () => {
    test('JSX-runtime symbol takes priority over _debugSource', () => {
      // The point of the JSX runtime is to provide the most precise source —
      // when both signals exist, the runtime wins.
      const fiber = createFiber({
        memoizedProps: {
          [FLOTRACE_SOURCE]: { ...FULL_SOURCE, fileName: 'jsx-runtime/path.tsx' },
        } as Record<string | symbol, unknown> as Record<string, unknown>,
        _debugSource: { fileName: 'debug-source/path.tsx', lineNumber: 1 },
      });
      expect(resolveEffectiveSourcePath(fiber)).toBe('jsx-runtime/path.tsx');
    });

    test('falls back to _debugSource when JSX symbol absent', () => {
      const fiber = createFiber({
        _debugSource: { fileName: 'src/Foo.tsx', lineNumber: 1 },
      });
      expect(resolveEffectiveSourcePath(fiber)).toBe('src/Foo.tsx');
    });

    test('falls back to owner-chain when fiber itself lacks signals', () => {
      const grandparent = createFiber({
        _debugSource: { fileName: 'src/Grandparent.tsx', lineNumber: 1 },
      });
      const parent = createFiber({ _debugOwner: grandparent });
      const child = createFiber({ _debugOwner: parent });
      expect(resolveEffectiveSourcePath(child)).toBe('src/Grandparent.tsx');
    });

    test('returns null when nothing resolves', () => {
      const fiber = createFiber();
      expect(resolveEffectiveSourcePath(fiber)).toBeNull();
    });
  });
});
