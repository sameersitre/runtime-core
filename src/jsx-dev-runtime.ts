/**
 * Development JSX runtime entry — instrumented wrapper around React's `jsxDEV`.
 *
 * When the user sets `"jsxImportSource": "@flotrace/runtime-core"` in
 * tsconfig.json, the compiler emits `jsxDEV(...)` calls importing from this
 * module in dev builds. We intercept each call to:
 *
 *   1. Mark the global adoption sentinel (one-time, on first call).
 *   2. Compute a stable per-callsite ID from the bundler-normalized
 *      `file:line:col`.
 *   3. Record the render timestamp into a 60-entry FIFO ring buffer keyed by
 *      callSiteId (powers the Hot Call Sites tab + conditional-render hint).
 *   4. Detect inline-literal props (`fn` / `obj` / `arr`) that would survive
 *      every memo boundary — only observable here, before React processes the
 *      props.
 *   5. Attach a `FlotraceJsxSource` object to props under the `FLOTRACE_SOURCE`
 *      symbol key. Symbol-keyed entries don't appear in `Object.keys` or
 *      React's unknown-prop warnings, but they DO survive React's prop pipeline
 *      and end up on `fiber.memoizedProps` unchanged — where the fiber walker
 *      reads them back.
 *   6. Delegate to React's real `jsxDEV` with the enriched props.
 *
 * The wrapper passes through unchanged when `source` or `props` is missing
 * (classic runtime, non-dev compiler, stripped source plugin, etc.) — the
 * existing heuristic ladder in fiberTreeWalker handles those fibers.
 *
 * Performance target: <10µs median per call (see jsx-dev-runtime.bench.ts).
 * Memory: ring buffer caps at 60 × callSiteId-count timestamps (~2.4 MB for a
 * 5000-callsite app); symbol-keyed source object adds ~200 bytes per
 * user-component fiber (~1 MB for 5000 fibers).
 */
import {
  jsxDEV as origJsxDEV,
  Fragment,
} from 'react/jsx-dev-runtime';
import {
  FLOTRACE_SOURCE,
  computeCallSiteId,
  normalizeJsxSourcePath,
  detectInlineLiterals,
  recordCallSiteRender,
  recordJsxKey,
  markJsxRuntimeActive,
  type FlotraceJsxSource,
} from './jsxRuntimeUtils';

/**
 * The wrapper takes the same arguments the compiler would pass to React's
 * `jsxDEV`. We mirror React's argument types via `Parameters<typeof origJsxDEV>`
 * rather than re-declaring them, so any drift in React's signature surfaces
 * at compile time here. Return type is `ReactNode` (whatever React's jsxDEV
 * returns — opaque to us).
 */
type JsxDEVArgs = Parameters<typeof origJsxDEV>;
type JsxDEVReturn = ReturnType<typeof origJsxDEV>;
type JsxDEVType = JsxDEVArgs[0];

/** Shape of the compiler-supplied `source` argument to `jsxDEV`. Stable since React 17. */
interface JsxSource {
  fileName: string;
  lineNumber: number;
  columnNumber: number;
}

/**
 * One-time adoption flag local to this module. First call sets it via
 * `markJsxRuntimeActive()`; subsequent calls take a cheap boolean branch.
 * Module-local (not exported) — we never need to "un-adopt" mid-session.
 */
let adoptionMarked = false;

export function jsxDEV(
  type: JsxDEVType,
  props: Record<string, unknown> | null,
  key: JsxDEVArgs[2],
  isStaticChildren: boolean,
  source: JsxSource | undefined,
  self: JsxDEVArgs[5],
): JsxDEVReturn {
  // Bail-out path: classic runtime, compiler that stripped source, or a
  // children-less element React-internal call. Pass through untouched.
  if (!source || !props) {
    return origJsxDEV(type, props, key, isStaticChildren, source, self);
  }

  if (!adoptionMarked) {
    markJsxRuntimeActive();
    adoptionMarked = true;
  }

  const callSiteId = computeCallSiteId(source);
  const inline = detectInlineLiterals(props);
  const flotraceSource: FlotraceJsxSource = inline
    ? {
        fileName: normalizeJsxSourcePath(source.fileName),
        lineNumber: source.lineNumber,
        columnNumber: source.columnNumber,
        callSiteId,
        inline,
      }
    : {
        fileName: normalizeJsxSourcePath(source.fileName),
        lineNumber: source.lineNumber,
        columnNumber: source.columnNumber,
        callSiteId,
      };

  recordCallSiteRender(callSiteId);
  // Record the React key for duplicate detection — emits a
  // `runtime:duplicateKey` event (via the registered emitter) when the same
  // (callSiteId, key) pair appears two or more times in one synchronous
  // render pass. Bails internally when key is null/undefined.
  recordJsxKey(flotraceSource, key);

  // Symbol-keyed prop is invisible to `Object.keys` / `JSON.stringify` / React
  // unknown-DOM-prop warnings but survives the prop pipeline. Allocates one
  // new props object per call (unavoidable — must not mutate the caller's
  // reference, which React + downstream `===` comparisons depend on).
  const enrichedProps = { ...props, [FLOTRACE_SOURCE]: flotraceSource };
  return origJsxDEV(type, enrichedProps, key, isStaticChildren, source, self);
}

/**
 * `jsxsDEV` is what some compilers emit for statically-known children arrays.
 * Behaviour is identical to `jsxDEV`; we alias rather than duplicate.
 *
 * React 17/18's `react/jsx-dev-runtime` doesn't export `jsxsDEV` directly —
 * compilers call `jsxDEV` for both cases in dev. Re-exporting here under both
 * names is defensive against compilers that happen to call `jsxsDEV` (some
 * older Babel configs).
 */
export const jsxsDEV = jsxDEV;

export { Fragment };

/**
 * Reset adoption-marked flag for testing. Pairs with
 * `__resetJsxRuntimeAdoptionForTesting` in jsxRuntimeUtils which clears the
 * global sentinel. Both are needed because this module also tracks a local
 * boolean to skip the global write on subsequent calls.
 */
export function __resetAdoptionMarkedForTesting(): void {
  adoptionMarked = false;
}
