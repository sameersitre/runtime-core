// @vitest-environment jsdom
/**
 * Unit tests for the jsxDEV wrapper.
 *
 * We DON'T render through React here — the wrapper's contract is purely:
 * "given the same args the compiler would pass to React's jsxDEV, attach the
 * FLOTRACE_SOURCE symbol to props and delegate to React". So we mock the
 * delegated function and assert on its inputs.
 *
 * React-version compatibility (17 / 18 / 19) is verified separately via
 * integration smoke tests; the jsxDEV argument shape is frozen since R17.
 *
 * Requires jsdom: the wrapper now has an `IS_BROWSER` short-circuit
 * (`typeof window !== 'undefined' && typeof document !== 'undefined'`) that
 * skips symbol-attach on the server to avoid Next.js RSC serializer
 * warnings. Without jsdom, every "happy path" test would hit the bail-out
 * and fail because the wrapper would pass through without enrichment.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted lifts these declarations alongside vi.mock so they're initialized
// before the mock factory runs (vi.mock is hoisted to file top).
const { mockOrigJsxDEV, mockFragment } = vi.hoisted(() => ({
  mockOrigJsxDEV: vi.fn(
    (
      type: unknown,
      props: unknown,
      key: unknown,
      isStaticChildren: boolean,
      source: unknown,
      self: unknown,
    ) => ({ type, props, key, isStaticChildren, source, self, __mocked: true }),
  ),
  mockFragment: Symbol.for('react.fragment.mock'),
}));

vi.mock('react/jsx-dev-runtime', () => ({
  jsxDEV: mockOrigJsxDEV,
  Fragment: mockFragment,
}));

import {
  FLOTRACE_SOURCE,
  __resetJsxRuntimeAdoptionForTesting,
  isJsxRuntimeActive,
  clearCallSiteRenders,
  getCallSiteRenders,
  computeCallSiteId,
  type FlotraceJsxSource,
} from './jsxRuntimeUtils';
import {
  jsxDEV,
  jsxsDEV,
  Fragment,
  __resetAdoptionMarkedForTesting,
} from './jsx-dev-runtime';

const SOURCE = { fileName: 'src/Foo.tsx', lineNumber: 10, columnNumber: 5 };

function MyComponent() {
  return null;
}

beforeEach(() => {
  mockOrigJsxDEV.mockClear();
  clearCallSiteRenders();
  __resetJsxRuntimeAdoptionForTesting();
  __resetAdoptionMarkedForTesting();
});

afterEach(() => {
  __resetJsxRuntimeAdoptionForTesting();
  __resetAdoptionMarkedForTesting();
});

describe('jsx-dev-runtime', () => {
  describe('Fragment re-export', () => {
    test('forwards React Fragment unchanged', () => {
      // The Fragment identity matters to React when authors write <></>.
      expect(Fragment).toBe(mockFragment);
    });
  });

  describe('jsxDEV wrapper — happy path', () => {
    test('enriches props with FLOTRACE_SOURCE symbol and delegates to origJsxDEV', () => {
      const props = { title: 'Hi' };
      jsxDEV(MyComponent, props, undefined, false, SOURCE, null);

      expect(mockOrigJsxDEV).toHaveBeenCalledTimes(1);
      const [type, enrichedProps, key, isStatic, source, self] =
        mockOrigJsxDEV.mock.calls[0];
      expect(type).toBe(MyComponent);
      expect(key).toBeUndefined();
      expect(isStatic).toBe(false);
      expect(source).toBe(SOURCE);
      expect(self).toBeNull();

      // Original-props passthrough.
      const p = enrichedProps as Record<string | symbol, unknown>;
      expect(p.title).toBe('Hi');

      // Symbol-keyed source attached.
      const attached = p[FLOTRACE_SOURCE] as FlotraceJsxSource;
      expect(attached).toBeDefined();
      expect(attached.fileName).toBe('src/Foo.tsx');
      expect(attached.lineNumber).toBe(10);
      expect(attached.columnNumber).toBe(5);
      expect(attached.callSiteId).toBe(computeCallSiteId(SOURCE));
    });

    test('does NOT mutate the caller-supplied props object (referential safety)', () => {
      // React + downstream `===` checks (memo, useEffect dep arrays) rely on
      // props identity. Mutating in place would silently invalidate them.
      const props = { title: 'Hi' };
      jsxDEV(MyComponent, props, undefined, false, SOURCE, null);
      expect(Object.keys(props)).toEqual(['title']);
      expect((props as Record<string | symbol, unknown>)[FLOTRACE_SOURCE]).toBeUndefined();
    });

    test('normalizes the bundler-specific fileName before attaching', () => {
      jsxDEV(
        MyComponent,
        { title: 'Hi' },
        undefined,
        false,
        { fileName: 'webpack-internal:///./src/Foo.tsx', lineNumber: 10, columnNumber: 5 },
        null,
      );
      const enriched = mockOrigJsxDEV.mock.calls[0][1] as Record<string | symbol, unknown>;
      const attached = enriched[FLOTRACE_SOURCE] as FlotraceJsxSource;
      expect(attached.fileName).toBe('src/Foo.tsx');
    });

    test('attaches `inline` map only when literals are present', () => {
      // No inline literals → no `inline` field (saves bytes on every JSX call).
      jsxDEV(MyComponent, { count: 5 }, undefined, false, SOURCE, null);
      const noInline = (mockOrigJsxDEV.mock.calls[0][1] as Record<symbol, unknown>)[
        FLOTRACE_SOURCE
      ] as FlotraceJsxSource;
      expect(noInline.inline).toBeUndefined();

      // With an inline arrow → `inline.onClick === 'fn'`.
      mockOrigJsxDEV.mockClear();
      const onClick = () => undefined;
      Object.defineProperty(onClick, 'name', { value: '' });
      jsxDEV(MyComponent, { onClick }, undefined, false, SOURCE, null);
      const withInline = (mockOrigJsxDEV.mock.calls[0][1] as Record<symbol, unknown>)[
        FLOTRACE_SOURCE
      ] as FlotraceJsxSource;
      expect(withInline.inline).toEqual({ onClick: 'fn' });
    });

    test('records a render into the per-callSiteId ring buffer', () => {
      jsxDEV(MyComponent, { title: 'A' }, undefined, false, SOURCE, null);
      jsxDEV(MyComponent, { title: 'B' }, undefined, false, SOURCE, null);
      const renders = getCallSiteRenders(computeCallSiteId(SOURCE));
      expect(renders.length).toBe(2);
    });
  });

  describe('jsxDEV wrapper — adoption sentinel', () => {
    test('first call marks adoption; subsequent calls are no-op', () => {
      expect(isJsxRuntimeActive()).toBe(false);
      jsxDEV(MyComponent, { title: 'Hi' }, undefined, false, SOURCE, null);
      expect(isJsxRuntimeActive()).toBe(true);
      // Calling again must not throw / write again; idempotent.
      jsxDEV(MyComponent, { title: 'Hi' }, undefined, false, SOURCE, null);
      expect(isJsxRuntimeActive()).toBe(true);
    });

    test('passthrough path (no source) does NOT mark adoption', () => {
      // Classic runtime / non-dev compiler / stripped-source plugin path
      // must remain invisible — we don't want to advertise "JSX runtime
      // active" when our wrapper was never given a source argument.
      jsxDEV(MyComponent, { title: 'Hi' }, undefined, false, undefined, null);
      expect(isJsxRuntimeActive()).toBe(false);
    });
  });

  describe('jsxDEV wrapper — passthrough paths', () => {
    test('passes through unchanged when source is undefined', () => {
      const props = { title: 'Hi' };
      jsxDEV(MyComponent, props, undefined, false, undefined, null);
      expect(mockOrigJsxDEV).toHaveBeenCalledWith(
        MyComponent,
        props, // SAME reference, not enriched
        undefined,
        false,
        undefined,
        null,
      );
      // Source symbol not added.
      expect(
        (props as Record<string | symbol, unknown>)[FLOTRACE_SOURCE],
      ).toBeUndefined();
    });

    test('passes through unchanged when props is null', () => {
      // React allows null props for some element shapes (rare but valid).
      jsxDEV(MyComponent, null, undefined, false, SOURCE, null);
      expect(mockOrigJsxDEV).toHaveBeenCalledWith(
        MyComponent,
        null,
        undefined,
        false,
        SOURCE,
        null,
      );
      // Ring buffer untouched on bail-out paths (no callSiteId hashed).
      expect(getCallSiteRenders(computeCallSiteId(SOURCE))).toEqual([]);
    });

    test('enriches even when type is undefined — origJsxDEV decides the fate', () => {
      // `<undefined />` is invalid React but the compiler can still emit it
      // (e.g. user wrote `const X = undefined; <X />`). React's own jsxDEV
      // is responsible for the warning; our wrapper should still enrich +
      // record so the resulting fiber (if any) carries source attribution.
      jsxDEV(undefined as never, { title: 'Hi' }, undefined, false, SOURCE, null);
      expect(mockOrigJsxDEV).toHaveBeenCalledTimes(1);
      const enriched = mockOrigJsxDEV.mock.calls[0][1] as Record<symbol, unknown>;
      expect(enriched[FLOTRACE_SOURCE]).toBeDefined();
      // Ring buffer records the call — Hot Call Sites tab will surface it
      // even if React rejected the element.
      expect(getCallSiteRenders(computeCallSiteId(SOURCE)).length).toBe(1);
    });
  });

  describe('jsxsDEV alias', () => {
    test('is the same reference as jsxDEV (defensive alias for compilers that emit jsxsDEV)', () => {
      expect(jsxsDEV).toBe(jsxDEV);
    });
  });

  describe('FLOTRACE_SOURCE prop invisibility', () => {
    test('does not appear in Object.keys(enrichedProps)', () => {
      jsxDEV(MyComponent, { title: 'Hi' }, undefined, false, SOURCE, null);
      const enriched = mockOrigJsxDEV.mock.calls[0][1] as Record<string, unknown>;
      expect(Object.keys(enriched)).toEqual(['title']);
    });

    test('survives JSON.stringify (safe for any accidental serialization)', () => {
      jsxDEV(MyComponent, { title: 'Hi' }, undefined, false, SOURCE, null);
      const enriched = mockOrigJsxDEV.mock.calls[0][1] as Record<string, unknown>;
      expect(JSON.parse(JSON.stringify(enriched))).toEqual({ title: 'Hi' });
    });
  });
});
