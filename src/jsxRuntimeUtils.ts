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
  if (p.startsWith('webpack-internal:///./')) p = p.slice('webpack-internal:///./'.length);
  // Next.js Turbopack emits `[project]/path/to/Foo.tsx` for project-relative
  // paths. Strip the prefix so the result is a plain project-relative path
  // matching what other bundlers produce — click-to-IDE in the desktop can
  // then resolve it against the active project root.
  if (p.startsWith('[project]/')) p = p.slice('[project]/'.length);
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
 * Normalize a file path extracted from a JS engine stack frame (V8 / Hermes).
 * Stack frames in dev mode carry dev-server URLs ("http://localhost:5173/src/Foo.tsx?t=1234")
 * or RN Metro bundle URLs ("http://10.0.2.2:8081/index.bundle?platform=android&dev=true").
 *
 * Steps (order matters):
 *   1. Strip the URL query string (`?t=...`, `?platform=...`).
 *   2. If the path is an http(s) URL, strip the scheme + host[:port] and the
 *      leading `/` — the result is a project-relative path that the desktop
 *      can resolve against the active project root.
 *   3. Delegate to `normalizeJsxSourcePath` for `file://`, `webpack-internal:`,
 *      Turbopack `[project]/`, and Windows drive normalizations.
 */
export function normalizeStackFramePath(rawPath: string): string {
  let p = rawPath;
  const queryIdx = p.indexOf('?');
  if (queryIdx !== -1) p = p.slice(0, queryIdx);
  const httpMatch = p.match(/^https?:\/\/[^/]+(\/.+)$/);
  if (httpMatch) {
    p = httpMatch[1];
    if (p.startsWith('/')) p = p.slice(1);
  }
  return normalizeJsxSourcePath(p);
}

/**
 * Heuristic: does this stack-frame path point at a JS bundle file rather than
 * a real source file? Used to skip Metro/Webpack/Vite bundle frames in the
 * `_debugStack` fallback — the bundle line number is meaningless without
 * source maps, and the bundle URL isn't a path the desktop can open.
 *
 *   - Metro: `http://10.0.2.2:8081/index.bundle?platform=android&...`
 *   - Generic: `<anything>/bundle.js` or `<anything>.bundle` or `.bundle.js`
 *   - Metro platform query (defensive — covers source-map-disabled bundles
 *     that don't include `index.bundle` in the URL path)
 */
export function isJsBundlePath(rawPath: string): boolean {
  if (/\bindex\.bundle\b/.test(rawPath)) return true;
  if (/\.bundle(\?|$|\.js(\?|$))/.test(rawPath)) return true;
  if (/\?platform=(ios|android|web|native)\b/.test(rawPath)) return true;
  return false;
}

/**
 * Parse the first V8/Hermes stack frame that is NOT inside React/RN internals
 * and NOT a JS bundle URL. Returns the file path AND line/column so callers
 * that need full position (LiveTreeNode click-to-IDE on React 19+ web) get
 * them, not just the path.
 *
 * Lives here (not in `fiberTreeWalker.ts`) so `isUserComponent` below — which
 * also needs to detect "this fiber's source is outside node_modules" — can
 * reach it without creating a circular dependency with the walker.
 *
 * Frame formats handled:
 *   "    at Component (file:///path/file.tsx:10:5)"        — V8 (Node, Chrome)
 *   "    at fn (webpack-internal:///./src/Foo.tsx:10:5)"   — Webpack dev
 *   "    at fn (http://localhost:3000/_next/...:10:5)"     — Next.js Turbopack
 *   "Component@/path/to/file.tsx:10:5"                     — Hermes (RN)
 *
 * Skipped:
 *   - React internal frames (`react-dom`, `/react/cjs/`, `/scheduler/`,
 *     `react-native/Libraries`)
 *   - JS bundle URLs (`isJsBundlePath` matches Metro `index.bundle?...` etc.)
 */
export function parseFirstNonReactFrame(
  stack: string,
): { fileName: string; lineNumber: number; columnNumber: number } | null {
  const lines = stack.split('\n');
  for (const line of lines) {
    // V8: "(path:line:col)"; Hermes: "@path:line:col"
    const parened = line.match(/\(([^)]+):(\d+):(\d+)\)/);
    const hermes = line.match(/@([^\s]+):(\d+):(\d+)$/);
    const match = parened ?? hermes;
    if (!match) continue;
    const path = match[1];
    if (path.includes('react-dom')) continue;
    if (path.includes('react-native/Libraries')) continue;
    if (path.includes('/react/cjs/')) continue;
    if (path.includes('/scheduler/')) continue;
    // RN Metro / Webpack bundle frames are not openable in an IDE — the path
    // is a dev-server URL and the line number is bundle-relative, not
    // source-relative. Skip and keep looking (in practice no source frame
    // follows in RN dev — `_debugStack` will degrade to "no signal", same as
    // pre-fix behaviour, instead of populating a garbage filePath that the
    // desktop's editor IPC then rejects with "File not found on disk").
    if (isJsBundlePath(path)) continue;
    return {
      fileName: normalizeStackFramePath(path),
      lineNumber: Number(match[2]),
      columnNumber: Number(match[3]),
    };
  }
  return null;
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

/**
 * String-keyed JSX attribute name used by `@flotrace/runtime-core/babel-plugin`.
 * Kept here so the babel plugin (CJS) and the walker (ESM/TS) read from a
 * single source of truth — typo'ing one half would silently break click-to-IDE.
 *
 * `data-*` is intentional: valid on every React DOM host element (no
 * unknown-prop warning) and silently ignored by RN's native renderer.
 */
export const FLOTRACE_SRC_ATTR = 'data-flotrace-src';

/**
 * Parse the JSON payload written by the babel plugin (`{f,l,c}` keys for
 * size) into the canonical `FlotraceJsxSource` shape. Computes `callSiteId`
 * at read time so the plugin payload stays minimal AND every consumer agrees
 * on the hash (the FNV-1a is in this file too).
 *
 * Returns `undefined` for any malformed payload — the walker treats this
 * the same as "no source signal" and falls back through the tier ladder.
 */
function parseDataFlotraceSrc(value: string): FlotraceJsxSource | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  if (typeof o.f !== 'string' || typeof o.l !== 'number' || typeof o.c !== 'number') {
    return undefined;
  }
  const fileName = o.f;
  const lineNumber = o.l;
  const columnNumber = o.c;
  return {
    fileName,
    lineNumber,
    columnNumber,
    callSiteId: computeCallSiteId({ fileName, lineNumber, columnNumber }),
  };
}

/**
 * Read the JSX-runtime source attribution off a fiber. Three routes,
 * checked in order:
 *
 *   1. `memoizedProps[FLOTRACE_SOURCE]` — symbol-keyed payload from the
 *      optional `@flotrace/runtime-core/jsx-dev-runtime` JSX-runtime
 *      opt-in. Highest precision (carries the precomputed callSiteId and
 *      any inline-literal diagnostics). Caveat: React 19 strips symbol-
 *      keyed entries on any element with a `key` prop (list rows, .map()
 *      children) — those fall through to routes 2/3.
 *
 *   2. `memoizedProps[FLOTRACE_SRC_ATTR]` — string-keyed JSON payload from
 *      the `@flotrace/runtime-core/babel-plugin` JSX-attribute pass. This
 *      is the "call site" attribution — points at where `<Component />`
 *      was *written*. Survives React 19's keyed-element clone, coexists
 *      with any other `jsxImportSource` consumer (nativewind etc.).
 *
 *   3. `type[FLOTRACE_SRC_ATTR]` — string-keyed JSON payload from the
 *      same babel plugin's declaration-tagging pass. This is the
 *      "definition site" attribution — points at the `function Component`
 *      / `const Component = ...` declaration. Covers fibers whose
 *      memoizedProps lacks the attribute, i.e. components instantiated
 *      via `React.createElement(Component, ...)` from inside a library
 *      (react-navigation `<Stack.Screen component={X}>`, HOC-wrapped
 *      components, AppRegistry-registered roots).
 *
 * Returns `undefined` if no route yields a valid payload. Caller falls
 * back to the existing heuristic ladder (`_debugSource` → owner chain →
 * `_debugStack`).
 *
 * Validation is strict: missing fields or wrong types → `undefined`, never
 * a partially-populated object. Defensive against a malformed symbol-key
 * collision from unrelated tooling.
 *
 * Generic over the fiber-like shape — works for both the full `Fiber` type
 * in `fiberTreeWalker.ts` and the minimal subset used by `cascadeAnalyzer.ts`.
 * `type` is optional so legacy callers that pass only `{memoizedProps}`
 * keep working (they just skip route 3).
 */
export function readJsxSourceFromFiber(fiber: {
  memoizedProps: Record<string, unknown> | null;
  type?: unknown;
}): FlotraceJsxSource | undefined {
  const props = fiber.memoizedProps;

  if (props) {
    // Route 1: symbol-keyed payload (JSX-runtime opt-in)
    const symRaw = (props as Record<string | symbol, unknown>)[FLOTRACE_SOURCE];
    if (symRaw && typeof symRaw === 'object') {
      const obj = symRaw as Record<string, unknown>;
      if (
        typeof obj.fileName === 'string' &&
        typeof obj.lineNumber === 'number' &&
        typeof obj.columnNumber === 'number' &&
        typeof obj.callSiteId === 'string'
      ) {
        return symRaw as FlotraceJsxSource;
      }
    }

    // Route 2: string-keyed JSON payload on props (babel plugin call-site
    // attribution) — the recommended path for nativewind / RN consumers,
    // and the only one that survives React 19's keyed-element prop clone.
    const strRaw = (props as Record<string, unknown>)[FLOTRACE_SRC_ATTR];
    if (typeof strRaw === 'string') {
      const parsed = parseDataFlotraceSrc(strRaw);
      if (parsed) return parsed;
    }
  }

  // Route 3: string-keyed JSON payload on the component TYPE (babel plugin
  // definition-site attribution). Covers fibers whose props lack the
  // attribute — e.g. react-navigation screens, HOC-wrapped components.
  // Host components have a string type (e.g. 'View'), which can't carry
  // properties — guard against that here.
  const type = fiber.type;
  if (type !== null && (typeof type === 'function' || typeof type === 'object')) {
    const typeAttr = (type as Record<string, unknown>)[FLOTRACE_SRC_ATTR];
    if (typeof typeAttr === 'string') {
      const parsed = parseDataFlotraceSrc(typeAttr);
      if (parsed) return parsed;
    }
  }

  return undefined;
}

/**
 * Top-priority "is this fiber a user-defined component?" check.
 *
 * Three routes, checked in order of precision (fastest + most reliable
 * first). Returns `true` as soon as ANY route produces positive evidence
 * that the fiber's source code lives outside `node_modules`.
 *
 *   Route A — `fiber.type[FLOTRACE_SRC_ATTR]` (babel plugin):
 *     The `@flotrace/runtime-core/babel-plugin` declaration-tagging pass
 *     writes a JSON `{f,l,c}` payload onto every PascalCase function /
 *     class / variable in user code. Works for: React Native (Babel),
 *     Vite + React (Babel), CRA, Webpack + Babel, Next.js Pages Router
 *     (if Babel is opted in). Doesn't work for: Next.js with SWC.
 *
 *   Route B — `fiber._debugSource.fileName` (React 18 + Babel JSX source):
 *     The `@babel/plugin-transform-react-jsx-source` plugin (auto-included
 *     by RN's preset and CRA/Vite's React preset) injects `__source` on
 *     every JSX element, which React 18 captures onto `fiber._debugSource`.
 *     Empty under React 19+ (the field was deprecated upstream).
 *
 *   Route C — `fiber._debugStack.stack` (React 19+ web — Next.js SWC, Vite):
 *     React 19 replaced `_debugSource` with an Error captured at JSX
 *     creation time. We parse the first non-React stack frame for a path.
 *     This is what makes Next.js (SWC, no babel config possible without
 *     losing SWC) work — the React 19 reconciler attaches stack-frame
 *     info regardless of the compiler used.
 *
 * For ALL routes the "is user code" criterion is the same: the resolved
 * file path must not include `node_modules`. That string check is enough
 * because every modern bundler resolves third-party deps through a path
 * containing `/node_modules/` — there's no realistic false-negative.
 *
 * Returns `false` for:
 *   - Host components (string `fiber.type` like `'View'` / `'div'`)
 *   - Library / framework components (paths in `node_modules`, plus
 *     bundle-URL frames which are skipped by `parseFirstNonReactFrame`)
 *   - Fibers with no source signal at all (degrade to existing heuristics)
 *
 * Used by `fiberTreeWalker.ts` as a top-priority short-circuit before
 * name-list / regex / path heuristics fire. A fiber that returns `true`
 * here is authoritatively user code — every framework/library
 * classification downstream should bypass.
 *
 * Generic over the fiber-like shape so cascadeAnalyzer / propDrillingAnalyzer
 * / valueTraceResolver can all share one definition without importing the
 * walker's `Fiber` type.
 */
/**
 * Per-fiber memo for {@link isUserComponent}. The result is a pure function of fields fixed
 * at fiber creation (`type` / `memoizedProps` / `_debugSource` / `_debugStack`), and the
 * walker calls `isUserComponent` up to 3× per node (via `resolveSourceConfidence`,
 * `isFrameworkComponent`, `detectLibraryName`) plus once per ancestor in
 * `resolveEffectiveReactKey`. The Route-C `_debugStack` parse is the costly tier, so caching
 * by fiber reference collapses N parses into 1. `WeakMap` ⇒ entries are GC'd with the fiber,
 * so there's no unbounded growth and nothing to clear across snapshots.
 */
const userComponentCache = new WeakMap<object, boolean>();

export function isUserComponent(fiber: {
  type?: unknown;
  memoizedProps?: Record<string, unknown> | null;
  _debugSource?: { fileName: string; lineNumber?: number } | null;
  _debugStack?: { stack?: string } | null;
}): boolean {
  // Memoize by fiber reference. Every caller passes a fiber-like OBJECT; the guard only
  // protects against a hypothetical primitive arg (WeakMap keys must be objects).
  if (typeof fiber !== 'object' || fiber === null) return computeIsUserComponent(fiber);
  const cached = userComponentCache.get(fiber);
  if (cached !== undefined) return cached;
  const result = computeIsUserComponent(fiber);
  userComponentCache.set(fiber, result);
  return result;
}

function computeIsUserComponent(fiber: {
  type?: unknown;
  memoizedProps?: Record<string, unknown> | null;
  _debugSource?: { fileName: string; lineNumber?: number } | null;
  _debugStack?: { stack?: string } | null;
}): boolean {
  // Routes 1-3 — JSX-runtime opt-in symbol on memoizedProps, babel-plugin
  // string attr on memoizedProps, and babel-plugin string attr on fiber.type.
  // All three are read by `readJsxSourceFromFiber`. Critical: the Next.js +
  // SWC + `jsxImportSource: '@flotrace/runtime-core'` path hits Route 1
  // (memoizedProps[FLOTRACE_SOURCE]) — without delegating here, Next.js
  // tsconfig-only consumers would fall through to the much slower stack
  // parse below.
  const jsxSrc = readJsxSourceFromFiber({
    memoizedProps: fiber.memoizedProps ?? null,
    type: fiber.type,
  });
  if (jsxSrc && !jsxSrc.fileName.includes('node_modules')) return true;

  // Route B — React 18's `_debugSource` (auto-populated by the Babel JSX
  // source plugin in any dev build using Babel).
  const debugSourcePath = fiber._debugSource?.fileName;
  if (typeof debugSourcePath === 'string' && !debugSourcePath.includes('node_modules')) {
    return true;
  }

  // Route C — React 19's `_debugStack` (the fallback signal when neither
  // the JSX-runtime opt-in nor the babel plugin is installed, e.g. plain
  // Vite + React 19 with no config changes). `parseFirstNonReactFrame`
  // skips React internals AND JS bundle URLs (so RN Metro bundle frames
  // don't false-positive a user path), then normalizes the result.
  const stack = fiber._debugStack?.stack;
  if (typeof stack === 'string') {
    const frame = parseFirstNonReactFrame(stack);
    if (frame && !frame.fileName.includes('node_modules')) return true;
  }

  return false;
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
export function recordCallSiteRender(callSiteId: string, now: number = performance.now()): void {
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
  windowMs = 5000,
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

/**
 * Compute a `runtime:callSiteMetrics` payload from the ring buffer — one
 * entry per callsite that has rendered within the last `windowMs` ms (5s
 * default). Callsites with zero recent activity are omitted so the wire-
 * format payload stays small on idle apps.
 *
 * Returns `null` when no callsite has activity → caller skips the WebSocket
 * send entirely. This is load-bearing: a 5000-callsite app with no live
 * renders should NOT emit a 5000-entry map of zeros every second.
 *
 * The `now` arg lets tests inject deterministic timestamps.
 */
export function computeCallSiteMetricsPayload(
  windowMs = 5000,
  now: number = performance.now(),
): Record<string, number> | null {
  let out: Record<string, number> | null = null;
  const cutoff = now - windowMs;
  // Single-pass over the ring buffer Map. Iterating `entries()` gives us
  // the timestamp array directly; counting backwards on the same array
  // saves a `Map.get(callSiteId)` per entry compared to delegating to
  // `getCallSiteRenderRate`. On a 5000-callsite app at 1Hz that's 5000
  // map lookups per tick saved.
  for (const [callSiteId, arr] of callSiteRenders) {
    if (arr.length === 0) continue;
    let count = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] >= cutoff) count++;
      else break;
    }
    if (count > 0) {
      (out ??= {})[callSiteId] = (count / windowMs) * 1000;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate-key detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Payload emitted whenever a JSX call site fires twice in the same commit
 * with the same React `key`. Shape mirrors `RuntimeDuplicateKeyMessage` minus
 * the wire-format envelope (`type` + `timestamp`) — those are added by the
 * caller (typically `FloTraceProvider`) at WS-send time.
 */
export interface DuplicateKeyEvent {
  callSiteId: string;
  fileName: string;
  lineNumber: number;
  columnNumber: number;
  duplicateKey: string;
  occurrences: number;
}

/**
 * Settable emitter — `FloTraceProvider` registers a callback that forwards
 * `runtime:duplicateKey` messages to the WS client. Keeping the transport
 * out of jsxRuntimeUtils means this file stays free of WS-client / Provider
 * dependencies, so the jsx-dev-runtime entry bundle stays minimal.
 *
 * When no emitter is registered (e.g. user installed the JSX runtime
 * without the provider), detected duplicates are silently dropped.
 */
let duplicateKeyEmitter: ((evt: DuplicateKeyEvent) => void) | null = null;

export function setDuplicateKeyEmitter(emitter: ((evt: DuplicateKeyEvent) => void) | null): void {
  duplicateKeyEmitter = emitter;
}

/**
 * Per-commit batch state: `(callSiteId + '|' + keyValue) → {count, source}`.
 * The wrapper calls `recordJsxKey` for every JSX element that carries a key;
 * a microtask flush at the end of the synchronous render pass detects pairs
 * with `count ≥ 2` and emits a `DuplicateKeyEvent` for each.
 *
 * Microtask boundary is a close approximation of React's commit phase — React
 * 18+ schedules its work in microtasks, so a full render pass (and its JSX
 * eval) drains before the microtask flush runs. For React 17, the heuristic
 * over-collects across commits but never under-reports duplicates.
 */
const currentKeyBatch = new Map<string, { count: number; source: FlotraceJsxSource }>();
let keyBatchFlushScheduled = false;

export function recordJsxKey(source: FlotraceJsxSource, key: unknown): void {
  // React accepts string/number/boolean keys; everything else (null,
  // undefined, symbols, objects) means "no usable key for duplicate
  // detection". The primitive whitelist subsumes the null/undefined case
  // (typeof null === 'object', typeof undefined === 'undefined') AND
  // guards against `String(Symbol())` TypeError + the `String({}) ===
  // '[object Object]'` false-collision that would silently group every
  // distinct object key together. Non-primitive keys are React's own bug
  // to surface via its warning — we don't pretend to detect "duplicates"
  // over them.
  const keyType = typeof key;
  if (keyType !== 'string' && keyType !== 'number' && keyType !== 'boolean') return;
  const keyStr = String(key);
  const batchKey = `${source.callSiteId}|${keyStr}`;
  const entry = currentKeyBatch.get(batchKey);
  if (entry !== undefined) {
    entry.count++;
  } else {
    currentKeyBatch.set(batchKey, { count: 1, source });
  }
  if (!keyBatchFlushScheduled) {
    keyBatchFlushScheduled = true;
    queueMicrotask(flushDuplicateKeys);
  }
}

function flushDuplicateKeys(): void {
  keyBatchFlushScheduled = false;
  const emitter = duplicateKeyEmitter;
  if (emitter === null) {
    currentKeyBatch.clear();
    return;
  }
  for (const [batchKey, { count, source }] of currentKeyBatch) {
    if (count < 2) continue;
    // batchKey shape is "<callSiteId>|<keyValue>" — slice after the
    // delimiter; callSiteId is fixed 8 hex chars but using slice on the
    // explicit `|` index keeps this robust if the hash format ever widens.
    const sep = batchKey.indexOf('|');
    const duplicateKey = batchKey.slice(sep + 1);
    emitter({
      callSiteId: source.callSiteId,
      fileName: source.fileName,
      lineNumber: source.lineNumber,
      columnNumber: source.columnNumber,
      duplicateKey,
      occurrences: count,
    });
  }
  currentKeyBatch.clear();
}

/**
 * Test-only: reset emitter + batch + scheduled flag. Tests assert on
 * emit-or-not-emit behaviour, and queueMicrotask makes that asynchronous —
 * tests use `await Promise.resolve()` to drain the microtask queue, then
 * read the spy.
 */
export function __resetDuplicateKeyStateForTesting(): void {
  duplicateKeyEmitter = null;
  currentKeyBatch.clear();
  keyBatchFlushScheduled = false;
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

/**
 * One-stop reset for every piece of module-local state owned by the JSX
 * runtime layer. Tests that don't care about fine-grained isolation can
 * call this in `beforeEach` instead of chaining the individual resets and
 * risking a missed slot when new state is added later.
 *
 * Currently covers: duplicate-key batch + flush-scheduled flag + emitter,
 * adoption sentinel. The individual helpers stay exported for tests that
 * need surgical reset (e.g. asserting that a partial reset preserves the
 * other piece).
 */
export function __resetJsxRuntimeForTesting(): void {
  __resetDuplicateKeyStateForTesting();
  __resetJsxRuntimeAdoptionForTesting();
  clearCallSiteRenders();
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
  return typeOf === REACT_ELEMENT_TYPEOF_LEGACY || typeOf === REACT_ELEMENT_TYPEOF_R19;
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
