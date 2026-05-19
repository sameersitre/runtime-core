/**
 * Shared utilities for the @flotrace/runtime-core JSX runtime entries.
 *
 * The JSX runtime (jsx-dev-runtime.ts) writes the FLOTRACE_SOURCE symbol onto
 * a JSX element's props at creation time. The fiber walker reads the same
 * symbol back from `fiber.memoizedProps` during tree walking. Centralising
 * the symbol identity + helpers here means there's exactly one place to look
 * for "what shape is fiber.memoizedProps[FLOTRACE_SOURCE]".
 *
 * Per PRD-JSX-RUNTIME.md §8 + IMPLEMENTATION-PLAN-JSX-RUNTIME.md Phase 1.
 */

/**
 * Global symbol so the same identity is reachable from any module — including
 * dynamically-loaded chunks and multiple bundled copies of runtime-core that
 * may end up linked into the same app (workspace + npm registry mix). The
 * `Symbol.for()` registry guarantees one global slot.
 */
export const FLOTRACE_SOURCE = Symbol.for('flotrace.source');

/**
 * Adoption sentinel — the dev runtime sets this on first jsxDEV call so the
 * walker (and `runtime:ready` event) can detect that the user opted in via
 * `"jsxImportSource": "@flotrace/runtime-core"`. No per-call telemetry; this
 * is a one-time boolean.
 */
export const JSX_RUNTIME_ACTIVE_KEY = Symbol.for('flotrace.jsx-runtime-active');

/**
 * Source attribution attached to a React element's props at JSX-creation time.
 * Stored under the `FLOTRACE_SOURCE` symbol key so it doesn't appear in
 * `Object.keys(props)` or React's unknown-DOM-prop warnings.
 */
export interface FlotraceJsxSource {
  /** Normalized file path (bundler prefixes stripped). */
  fileName: string;
  /** 1-indexed line number. */
  lineNumber: number;
  /** 1-indexed column number. */
  columnNumber: number;
  /** FNV-1a 32-bit hash of `${fileName}:${lineNumber}:${columnNumber}`, 8 hex chars. */
  callSiteId: string;
  /** Map of prop key → inline-literal kind, only present when literals detected. */
  inline?: Record<string, 'fn' | 'obj' | 'arr'>;
}

/** Subset of the compiler-supplied `source` argument passed to jsxDEV. */
export interface JsxSourceArg {
  fileName: string;
  lineNumber: number;
  columnNumber: number;
}

/**
 * Normalize a bundler-specific file path to a canonical form. Different
 * bundlers emit different path styles for the SAME line of source code:
 *
 *   Vite dev          → `file:///abs/src/Foo.tsx`
 *   Webpack dev       → `webpack-internal:///./src/Foo.tsx`
 *   esbuild           → `./src/Foo.tsx`
 *   Next.js Turbopack → `[project]/src/Foo.tsx` (left as-is — no known prefix)
 *   Windows           → `C:\Users\foo\src\Foo.tsx`
 *
 * Without normalization, the same line of code produces a different
 * `callSiteId` after a bundler swap (or even after switching between Next.js
 * Webpack and Turbopack), breaking per-callsite metrics + HMR-stable watches.
 *
 * Normalization rules (order matters):
 *   1. Strip `file://` prefix.
 *   2. Strip `webpack-internal:///./` prefix.
 *   3. Trim leading `./`.
 *   4. Lowercase Windows drive letters (`C:\` → `c:\`).
 */
export function normalizeJsxSourcePath(fileName: string): string {
  let p = fileName;
  if (p.startsWith('file://')) p = p.slice('file://'.length);
  if (p.startsWith('webpack-internal:///./'))
    p = p.slice('webpack-internal:///./'.length);
  if (p.startsWith('./')) p = p.slice(2);
  // Windows + Vite emits `file:///C:/...` → after `file://` strip we get
  // `/C:/...`. Trim a single leading `/` when followed by `<letter>:` so the
  // drive-letter rule below still applies and Vite-Windows hashes match
  // Webpack-Windows for the same source line.
  if (/^\/[a-zA-Z]:[\\/]/.test(p)) p = p.slice(1);
  if (/^[a-zA-Z]:[\\/]/.test(p)) p = p[0].toLowerCase() + p.slice(1);
  return p;
}

/**
 * FNV-1a 32-bit hash → 8-char hex string. Fast, stable, and sufficient for
 * a non-cryptographic per-callsite identity. Operates on the NORMALIZED path
 * so the same source line produces the same hash regardless of bundler.
 *
 * Collision probability across a 5000-callsite app via the birthday paradox
 * on a 32-bit hash space: 1 − e^(−5000²/(2 × 2³²)) ≈ 0.3%. Acceptable for a
 * UI key — a one-in-300 chance of two callsites sharing a row in the Hot
 * Call Sites table is preferable to the wire-format weight of a longer hash.
 * Not suitable as a security token.
 */
export function computeCallSiteId(source: JsxSourceArg): string {
  const normPath = normalizeJsxSourcePath(source.fileName);
  const key = `${normPath}:${source.lineNumber}:${source.columnNumber}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-callsite render ring buffer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-`callSiteId` FIFO ring buffer of render timestamps. Capped at
 * `RING_BUFFER_MAX` entries per call site; total memory bounded by call-site
 * count (typically <5000 in a real app → ~2.4 MB worst case).
 *
 * Powers:
 *   - Phase 4 Hot Call Sites tab (renders/sec per callsite, independent of
 *     React Profiler — works in concurrent rendering where the Profiler may
 *     miss commits).
 *   - Phase 4 conditional-render detection (parent render count vs child).
 *   - Phase 6 Watch Expression "watch this callsite" surface.
 */
const callSiteRenders = new Map<string, number[]>();
const RING_BUFFER_MAX = 60;

/**
 * Record a render timestamp for a call site. Caller may inject `now` for
 * deterministic tests; production callers use the default `performance.now()`.
 */
export function recordCallSiteRender(
  callSiteId: string,
  now: number = performance.now(),
): void {
  const arr = callSiteRenders.get(callSiteId);
  if (arr === undefined) {
    callSiteRenders.set(callSiteId, [now]);
    return;
  }
  arr.push(now);
  if (arr.length > RING_BUFFER_MAX) arr.shift();
}

/** Read-only snapshot of recorded timestamps for a call site. */
export function getCallSiteRenders(callSiteId: string): readonly number[] {
  return callSiteRenders.get(callSiteId) ?? [];
}

/**
 * Renders-per-second over the last `windowMs` ms. Walks backwards through the
 * ring buffer; stops at the first entry older than the cutoff (entries are
 * monotonically non-decreasing because the runtime only ever appends).
 *
 * Caller may inject `now` for deterministic tests.
 */
export function getCallSiteRenderRate(
  callSiteId: string,
  windowMs: number = 5000,
  now: number = performance.now(),
): number {
  const arr = callSiteRenders.get(callSiteId);
  if (!arr || arr.length === 0) return 0;
  const cutoff = now - windowMs;
  let count = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] >= cutoff) count++;
    else break;
  }
  return (count / windowMs) * 1000;
}

/**
 * Clear all ring-buffer state. Called by the walker uninstall path so HMR
 * rapid-reconnect cycles don't accumulate stale entries across sessions.
 */
export function clearCallSiteRenders(): void {
  callSiteRenders.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Adoption sentinel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One-time boolean stored on `globalThis` under `JSX_RUNTIME_ACTIVE_KEY`. The
 * dev jsx-runtime sets it on first `jsxDEV` call; the walker reads it to
 * include `jsxRuntimeActive: true` on `runtime:ready` for adoption telemetry.
 *
 * No per-call telemetry — this is a single boolean, set once.
 */
export function markJsxRuntimeActive(): void {
  (globalThis as Record<symbol, unknown>)[JSX_RUNTIME_ACTIVE_KEY] = true;
}

export function isJsxRuntimeActive(): boolean {
  return (globalThis as Record<symbol, unknown>)[JSX_RUNTIME_ACTIVE_KEY] === true;
}

/**
 * Reset the adoption sentinel. Used only by tests — there's no production
 * code path that needs to un-mark adoption (a single dev session that loads
 * the runtime is permanently "active" for that session).
 */
export function __resetJsxRuntimeAdoptionForTesting(): void {
  delete (globalThis as Record<symbol, unknown>)[JSX_RUNTIME_ACTIVE_KEY];
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline-literal detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Props that are intrinsically managed by React or always-recreated by JSX
 * itself — flagging them as "inline" would be useless noise.
 *
 *   - `key`, `ref`, `children`: React-managed, never useful as a perf signal.
 *   - `className`: string literal in 99% of cases; the rare `clsx()` call is
 *     usually intentional and any caller doing it knowingly accepts the cost.
 */
const KNOWN_REACT_PROPS = new Set(['key', 'ref', 'children', 'className']);

/**
 * React elements carry `$$typeof` set to one of two registry symbols (one for
 * legacy, one for R19 "transitional"). Either marker means the value is itself
 * a React element — we never want to flag a child element passed as a prop as
 * an "inline obj" perf warning. Catches mixed-runtime codebases where the
 * nested element wasn't processed by our jsxDEV (no FLOTRACE_SOURCE marker)
 * but is still semantically an element.
 */
const REACT_ELEMENT_TYPEOF_LEGACY = Symbol.for('react.element');
const REACT_ELEMENT_TYPEOF_R19 = Symbol.for('react.transitional.element');

function isReactElement(v: object): boolean {
  const typeOf = (v as { $$typeof?: unknown }).$$typeof;
  return (
    typeOf === REACT_ELEMENT_TYPEOF_LEGACY ||
    typeOf === REACT_ELEMENT_TYPEOF_R19
  );
}

/**
 * Detect props that look like fresh-each-render literals — the #1 React perf
 * footgun (an inline `onClick={() => ...}` invalidates `memo` + breaks
 * `useEffect` dep arrays). This signal can ONLY be observed at JSX-creation
 * time; after React commits, the prop on the fiber looks identical whether it
 * was a literal or `useCallback`/`useMemo`'d ref.
 *
 * Heuristics (conservative — false-negatives are acceptable; false-positives
 * train users to ignore the warning, so we err toward silence):
 *
 *   - **Functions**: only flagged when the fn has no `.name`. `useCallback`'d
 *     fns preserve the inner fn's name, named methods are hoisted — the
 *     anonymous-arrow case is what catches `{() => doX()}` and `{e => h(e)}`.
 *   - **Arrays**: only non-empty arrays. `[]` literals are usually intentional
 *     empty defaults and not a perf concern in their own right.
 *   - **Plain objects**: detected via prototype check (`Object.prototype` or
 *     `null` prototype). React elements (`$$typeof`), class instances, dates,
 *     maps, sets — all skipped.
 *
 * Returns `undefined` when nothing is flagged, so callers can use a single
 * truthy check before serialising.
 */
export function detectInlineLiterals(
  props: Record<string, unknown>,
): Record<string, 'fn' | 'obj' | 'arr'> | undefined {
  let out: Record<string, 'fn' | 'obj' | 'arr'> | undefined;
  for (const k in props) {
    if (KNOWN_REACT_PROPS.has(k)) continue;
    const v = props[k];
    if (typeof v === 'function') {
      if (!v.name) {
        (out ??= {})[k] = 'fn';
      }
    } else if (Array.isArray(v)) {
      if (v.length > 0) {
        (out ??= {})[k] = 'arr';
      }
    } else if (
      v !== null &&
      typeof v === 'object' &&
      // Skip elements processed by our own runtime (marker present).
      !(FLOTRACE_SOURCE in (v as object)) &&
      // Skip React elements processed by ANY runtime — `$$typeof` is set on
      // every element regardless of which jsx-runtime created it, so this
      // catches mixed-runtime codebases. Without this guard, an inline
      // `<Outer child={<Inner/>} />` would false-positive on `child` when
      // Inner went through a different jsxImportSource.
      !isReactElement(v as object)
    ) {
      const proto = Object.getPrototypeOf(v as object);
      if (proto === Object.prototype || proto === null) {
        (out ??= {})[k] = 'obj';
      }
    }
  }
  return out;
}
