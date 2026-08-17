/**
 * Detects React Fast Refresh so hot-reload re-renders are not reported as
 * avoidable cascades.
 *
 * Why this exists: editing a file re-renders the touched component's whole
 * subtree, and those renders look exactly like an ancestor cascade — same
 * `parent-cascade` reason, same 100%-avoidable ratio. `React.memo` cannot
 * prevent them (Fast Refresh swaps the module, so the component TYPE changes
 * and React must remount), which makes every such finding unfixable by the
 * advice attached to it.
 *
 * Measured on Next.js 15 dev: a single file save adds 4 re-renders to one
 * `<Section>` subtree. A short editing burst manufactures a "critical, 100%
 * avoidable" finding on whatever was touched — during precisely the activity a
 * React debugger is open for.
 *
 * Coverage is web/webpack-shaped, which is where the problem was measured:
 *   - `window.webpackHotUpdate*` — webpack's hot-update entry point. Next.js
 *     names it `webpackHotUpdate_N_E`; the prefix scan covers other configs.
 *   - `window.$RefreshHelpers$.scheduleUpdate` — react-refresh's scheduler,
 *     present under Next.js dev.
 * Vite drives refresh through `import.meta.hot`, which a library cannot reach,
 * so Vite is best-effort: neither hook fires and behaviour is unchanged from
 * before this module existed. React Native is unaffected — Metro exposes
 * neither global, and the patch is a no-op without `window`.
 */

/** How long after a hot update commits are treated as refresh-induced. */
const HMR_WINDOW_MS = 2000;

let lastHmrAt = 0;

/** Record that a hot update just happened. Exported for the patches + tests. */
export function markHmrActivity(now: number = Date.now()): void {
  lastHmrAt = now;
}

/**
 * Was a commit at `timestamp` plausibly caused by Fast Refresh?
 *
 * Deliberately a time WINDOW rather than a single-commit flag: one hot update
 * produces several commits as React re-mounts the boundary, and only the first
 * is adjacent to the hook call.
 */
export function isHmrInduced(timestamp: number): boolean {
  if (lastHmrAt === 0) return false;
  const delta = timestamp - lastHmrAt;
  return delta >= 0 && delta < HMR_WINDOW_MS;
}

type Fn = (...args: unknown[]) => unknown;

/** Wrappers we installed, so uninstall only restores what is still ours. */
const installed: Array<{
  owner: Record<string, unknown>;
  key: string;
  original: unknown;
  wrapper: unknown;
}> = [];

function patch(owner: Record<string, unknown>, key: string): void {
  const original = owner[key];
  if (typeof original !== 'function') return;

  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    markHmrActivity();
    return (original as Fn).apply(this, args);
  };
  owner[key] = wrapper;
  installed.push({ owner, key, original, wrapper });
}

/**
 * Patch the hot-update hooks. Safe to call when none exist (production builds,
 * React Native, a browser with HMR disabled) — each patch is a no-op then.
 */
export function installHmrDetector(): void {
  if (typeof window === 'undefined') return;
  const win = window as unknown as Record<string, unknown>;

  for (const key of Object.keys(win)) {
    // Webpack derives the suffix from the build name (`_N_E` under Next.js).
    if (key.startsWith('webpackHotUpdate')) patch(win, key);
  }

  const helpers = win.$RefreshHelpers$;
  if (helpers && typeof helpers === 'object') {
    patch(helpers as Record<string, unknown>, 'scheduleUpdate');
  }
}

/**
 * Restore each hook, but only where our wrapper is still the installed value —
 * mirrors the sentinel discipline the fetch patches use, so we never clobber a
 * later patch from another tool.
 */
export function uninstallHmrDetector(): void {
  for (const entry of installed.splice(0)) {
    // Only restore if OUR wrapper is still on top. If something patched after
    // us, restoring would silently drop their wrapper.
    if (entry.owner[entry.key] === entry.wrapper) entry.owner[entry.key] = entry.original;
  }
}

/** Test-only: module state is global and would leak across cases. */
export function __resetHmrStateForTesting(): void {
  lastHmrAt = 0;
  installed.length = 0;
}
