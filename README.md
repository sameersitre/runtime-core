# @flotrace/runtime-core

Platform-agnostic core for the FloTrace runtime — fiber walker, hook/effect inspectors, state-store trackers, serializer, and WebSocket client. Shared by [`@flotrace/runtime`](https://www.npmjs.com/package/@flotrace/runtime) (web) and [`@flotrace/runtime-native`](https://www.npmjs.com/package/@flotrace/runtime-native) (React Native).

> **You probably don't want this package directly.**
> Install `@flotrace/runtime` for a web React app or `@flotrace/runtime-native` for React Native. Those adapters depend on `runtime-core` and provide the wiring (provider, network tracker, platform-specific hooks) you need.

`runtime-core` is published as a public package so adapters can pin a compatible version. It has no runtime dependency on `window` / `document` / `XMLHttpRequest` — all platform-specific features live in the adapters.

## What's inside

| Module | Purpose |
|---|---|
| `fiberTreeWalker` | Incremental fiber walk, diffed tree emission, pluggable `pruneSubtree` / `frameworkComponentNames` / `hostComponentSkipPrefixes` options for platform adapters. |
| `hookInspector` / `effectInspector` | Classify hooks and effects from a fiber; diff deps between commits. |
| `zustandTracker` / `reduxTracker` / `tanstackQueryTracker` | Duck-typed subscribers for the major state libraries. |
| `timelineTracker` | Per-component lifecycle events. |
| `cascadeAnalyzer` / `propDrillingAnalyzer` | Render-cascade tracing + prop-drilling chain detection. |
| `serializer` | Safe JSON serialization (depth 5, circular refs, truncation). |
| `websocketClient` | Singleton WS client with reconnect, batching, auth-token support. |

## Version compatibility

`@flotrace/runtime-core@0.1.x` is the companion release for:

- `@flotrace/runtime@0.2.x`
- `@flotrace/runtime-native@0.1.x`

Use matching minor versions when pinning across all three.

## License

MIT
