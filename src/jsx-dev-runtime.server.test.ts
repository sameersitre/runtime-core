/**
 * Server-side bail-out test for the jsxDEV wrapper.
 *
 * Next.js App Router runs `jsxDEV` for Server Components on the Node server.
 * React's RSC serializer warns when symbol-keyed props cross the SC → CC
 * boundary:
 *
 *   "Only plain objects can be passed to Client Components from Server
 *    Components. Objects with symbol properties like flotrace.source are
 *    not supported."
 *
 * The wrapper detects non-browser context via an `IS_BROWSER` const captured
 * at module-load. On the server, the wrapper passes through without
 * attaching the symbol. Server-side fibers never reach the FloTrace walker
 * anyway (the walker runs in the browser), so this eliminates the warning
 * + saves an allocation per server-rendered element.
 *
 * Test strategy: `IS_BROWSER` is module-scope and frozen at import time. The
 * project's `setupFiles` leak `window` globally even in `node`-env tests
 * (jsdom polyfills loaded eagerly), so we can't observe the server path by
 * just running in node env. Instead: delete window + document BEFORE
 * dynamically importing the module, so its module-init captures the
 * server-shape globals.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { mockOrigJsxDEV, mockFragment } = vi.hoisted(() => ({
  mockOrigJsxDEV: vi.fn(
    (type, props, key, isStatic, source, self) =>
      ({ type, props, key, isStatic, source, self, __mocked: true }) as unknown,
  ),
  mockFragment: Symbol.for('react.fragment.mock'),
}));

vi.mock('react/jsx-dev-runtime', () => ({
  jsxDEV: mockOrigJsxDEV,
  Fragment: mockFragment,
}));

const SOURCE = { fileName: 'src/SC.tsx', lineNumber: 10, columnNumber: 5 };
function MyComponent() {
  return null;
}

let savedWindow: unknown;
let savedDocument: unknown;

beforeEach(() => {
  mockOrigJsxDEV.mockClear();
  // Stash + remove the globals BEFORE module reset so the dynamically-
  // imported jsx-dev-runtime sees a server-shape global scope at module
  // init. The `IS_BROWSER` const is computed once at module load.
  savedWindow = (globalThis as { window?: unknown }).window;
  savedDocument = (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  vi.resetModules();
});

afterEach(() => {
  // Restore globals so the rest of the test run (other files) gets the
  // jsdom-shape it expects.
  if (savedWindow !== undefined) {
    (globalThis as { window?: unknown }).window = savedWindow;
  }
  if (savedDocument !== undefined) {
    (globalThis as { document?: unknown }).document = savedDocument;
  }
});

describe('jsxDEV — server-side bail-out (no window/document)', () => {
  test('test setup successfully removed the globals', () => {
    // Sanity check: prove the setup actually deleted window/document so the
    // module that follows truly sees a server-shape global scope. If a
    // future setup change polyfills these back, this test fails first and
    // points at the cause instead of mysteriously breaking the assertions
    // below.
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  test('does NOT attach FLOTRACE_SOURCE symbol on the server (fixes Next.js RSC warning)', async () => {
    const { jsxDEV } = await import('./jsx-dev-runtime');
    const { FLOTRACE_SOURCE } = await import('./jsxRuntimeUtils');
    const props = { title: 'Server prop' };

    jsxDEV(MyComponent, props, undefined, false, SOURCE, null);

    expect(mockOrigJsxDEV).toHaveBeenCalledTimes(1);
    const enriched = mockOrigJsxDEV.mock.calls[0][1] as Record<string | symbol, unknown>;
    // Critical: the symbol MUST be absent. React's RSC serializer scans
    // for foreign symbols on props crossing the SC → CC boundary and emits
    // a user-facing warning when it finds any.
    expect(enriched[FLOTRACE_SOURCE]).toBeUndefined();
  });

  test('passes the SAME props reference through (no allocation on the server)', async () => {
    const { jsxDEV } = await import('./jsx-dev-runtime');
    const props = { count: 5 };

    jsxDEV(MyComponent, props, undefined, false, SOURCE, null);

    // Browser path allocates `{...props, [SYM]: ...}`. Server bail-out
    // forwards the exact reference — zero allocation cost per SSR'd
    // element. For a 1000-element page that's a meaningful win.
    expect(mockOrigJsxDEV.mock.calls[0][1]).toBe(props);
  });

  test('does NOT mark adoption sentinel on the server (browser-only signal)', async () => {
    const { jsxDEV } = await import('./jsx-dev-runtime');
    const { isJsxRuntimeActive, __resetJsxRuntimeAdoptionForTesting } =
      await import('./jsxRuntimeUtils');
    __resetJsxRuntimeAdoptionForTesting();
    expect(isJsxRuntimeActive()).toBe(false);

    for (let i = 0; i < 50; i++) {
      jsxDEV(MyComponent, { i }, undefined, false, SOURCE, null);
    }

    // Adoption is meaningful only on the client (where the walker
    // observes fibers). 50 server jsxDEV calls must leave it false.
    expect(isJsxRuntimeActive()).toBe(false);
  });

  test('still delegates to React on the server (passthrough, not no-op)', async () => {
    const { jsxDEV } = await import('./jsx-dev-runtime');

    jsxDEV(MyComponent, { x: 1 }, 'k', true, SOURCE, null);

    // Even though we skip enrichment, the underlying React jsxDEV MUST
    // still be called so SSR works correctly — we're a passthrough on
    // the server, not a no-op.
    expect(mockOrigJsxDEV).toHaveBeenCalledWith(MyComponent, { x: 1 }, 'k', true, SOURCE, null);
  });
});
