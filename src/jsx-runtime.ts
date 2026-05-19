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
// Re-export the JSX namespace so TypeScript can resolve `JSX.Element`,
// `JSX.IntrinsicElements`, `JSX.IntrinsicAttributes`, etc. when
// `jsxImportSource` points at this module. Without this, users hit
// "Property 'div' does not exist on type 'JSX.IntrinsicElements'" on every
// HTML element in their codebase. Same pattern Preact + Emotion use.
export type { JSX } from 'react/jsx-runtime';
