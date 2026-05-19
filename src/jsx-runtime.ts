/**
 * Production JSX runtime entry — pure passthrough.
 *
 * When the user sets `"jsxImportSource": "@flotrace/runtime-core"` in
 * tsconfig.json, the compiler emits `jsx()` / `jsxs()` calls importing from
 * `@flotrace/runtime-core/jsx-runtime` in production builds. Since the
 * production-mode compiler never emits the `source` argument anyway, there is
 * nothing for us to capture — re-exporting React's own runtime keeps the path
 * truly zero-cost.
 *
 * The dev runtime lives in jsx-dev-runtime.ts and is where attribution +
 * inline-literal detection happens.
 */
export { jsx, jsxs, Fragment } from 'react/jsx-runtime';
