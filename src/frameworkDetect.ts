/**
 * Framework + framework-version detection (web adapter).
 *
 * Detects whether the running page is Next.js vs plain React and attempts to
 * resolve the Next.js version via the package's own `package.json`. All signals
 * are probed at runtime; absence is non-fatal and simply returns `undefined`.
 *
 * Node version of the project is intentionally NOT captured — `process.version`
 * is unavailable in browsers, and surfacing it would require user bundler
 * config (Vite `define`, Next.js `env`), which breaks the zero-config contract.
 */

export interface FrameworkInfo {
  frameworkName?: 'next' | 'expo' | 'rn-cli' | 'plain-react';
  frameworkVersion?: string;
}

/**
 * Detect the web framework hosting this page and, when possible, its version.
 *
 * - Next.js: presence detected via `window.__NEXT_DATA__` (App Router + Pages
 *   Router both set it) or the `<script id="__NEXT_DATA__">` element.
 * - Otherwise: reports `plain-react` (covers Vite, CRA, Remix, and anything else
 *   not positively identified as Next.js).
 *
 * Returns `{}` in non-DOM contexts (SSR on Node, first render of a Client
 * Component). `FloTraceProvider` only creates the WebSocket singleton on the
 * client, so the empty-object branch is harmless — detection re-runs after
 * hydration with a DOM available.
 *
 * **About `frameworkVersion`**: in a Next.js *client* bundle, `globalThis.require`
 * is normally not defined — so the version probe below usually no-ops and we
 * report `frameworkName: 'next'` with `frameworkVersion: undefined`. This is
 * by design: version detection is best-effort, the name alone is enough for
 * admin-side categorization, and the string-concat require trick exists
 * primarily to keep non-Next bundlers from failing the build on a static
 * `require('next/package.json')` they can't resolve. Framework *detection*
 * works reliably via `__NEXT_DATA__` regardless.
 */
export function detectWebFramework(): FrameworkInfo {
  if (typeof document === 'undefined') return {};

  const hasNextData =
    !!(globalThis as { __NEXT_DATA__?: unknown }).__NEXT_DATA__ ||
    !!document.querySelector('script#__NEXT_DATA__');
  if (!hasNextData) return { frameworkName: 'plain-react' };

  // Best-effort version probe. String-concat defeats bundler static analysis
  // so the build doesn't fail in projects without `next` as a dep. At runtime,
  // this resolves only when `require` is a live function (Node/SSR paths);
  // in a typical Next.js client bundle `require` is not on globalThis and
  // `version` stays undefined — we still report the framework name.
  let version: string | undefined;
  try {
    const req = (globalThis as { require?: (id: string) => unknown }).require;
    if (typeof req === 'function') {
      const id = 'next/' + 'package.json';
      const pkg = req(id) as { version?: string } | undefined;
      version = pkg?.version;
    }
  } catch {
    /* resolution failed — report the framework without a version */
  }

  return { frameworkName: 'next', frameworkVersion: version };
}
