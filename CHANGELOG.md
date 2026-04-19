# @flotrace/runtime-core

## 0.1.0

Initial release. Extracted from `@flotrace/runtime` to share fiber-walking, hook/effect inspection, state-store tracking, serialization, and the WebSocket client across the web adapter (`@flotrace/runtime@0.2.x`) and the React Native adapter (`@flotrace/runtime-native@0.1.x`).

### Features

- Fiber tree walker with incremental diffs, adaptive debounce, and pluggable `pruneSubtree` / `frameworkComponentNames` / `frameworkPathPatterns` / `hostComponentSkipPrefixes` options for platform adapters.
- Hook and effect inspectors (classification + dep diffing).
- State trackers: Zustand (per-store), Redux, TanStack Query (duck-typed).
- Cascade analyzer + prop-drilling analyzer.
- Safe JSON serializer (depth 5, circular refs, truncation).
- WebSocket client with auto-reconnect, batch sending, auth-token support, and heartbeat pong responses.
- Parameterized `getAppUrl?: () => string | undefined` so platform adapters supply their own current-URL signal (web passes `window.location.href`, native passes `undefined`).
- `globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__` access path (replaces the previous `window.`-scoped read).

### Not included (platform-specific, lives in adapters)

- Fetch / XHR / History API patching.
- RSC payload interception.
- React Native provider + navigation tracker + Metro host resolver.
