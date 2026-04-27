# @flotrace/runtime-core

Platform-agnostic core for [FloTrace](https://flotrace.dev) — fiber walker, hook/effect inspectors, state-store trackers (Zustand / Redux / TanStack Query), serializer, and WebSocket client. Shared between [`@flotrace/runtime`](https://www.npmjs.com/package/@flotrace/runtime) (web) and [`@flotrace/runtime-native`](https://www.npmjs.com/package/@flotrace/runtime-native) (React Native).

> **You almost certainly want one of the adapter packages instead.**
>
> - **Web React app?** → [`@flotrace/runtime`](https://www.npmjs.com/package/@flotrace/runtime)
> - **React Native (Expo / bare)?** → [`@flotrace/runtime-native`](https://www.npmjs.com/package/@flotrace/runtime-native)
>
> The adapters depend on `runtime-core` and provide the wiring (provider component, network tracker, platform-specific hooks) you actually need. This package on its own does nothing useful at runtime.

`runtime-core` is published publicly so adapters can pin a compatible version and so users can audit the open-source half of FloTrace. It has zero runtime dependency on `window` / `document` / `XMLHttpRequest` — all platform-specific features live in the adapters.

## What's inside

| Module | Purpose |
|---|---|
| `fiberTreeWalker` | Incremental fiber walk, diffed tree emission. Pluggable `pruneSubtree` / `frameworkComponentNames` / `hostComponentSkipPrefixes` for platform adapters. |
| `hookInspector` / `effectInspector` | Classify hooks (14 types) and effects from a fiber; diff deps between commits. |
| `zustandTracker` / `reduxTracker` / `tanstackQueryTracker` | Duck-typed subscribers for the major state libraries — no peer-dep bloat. |
| `timelineTracker` | Per-component lifecycle events (mount, unmount, update, prop diff). |
| `cascadeAnalyzer` / `propDrillingAnalyzer` | Render-cascade tracing + prop-drilling DFS chain detection with severity scoring. |
| `serializer` | Safe JSON serialization (depth 5, circular-ref guard, truncation). |
| `websocketClient` | Singleton WS client with exponential backoff reconnect, message batching, optional auth token. |

## Version compatibility

`@flotrace/runtime-core@2.x` is the companion release for:

- `@flotrace/runtime@2.x`
- `@flotrace/runtime-native@2.x`

All three are released in lockstep — pin the same major.minor across the trio. The desktop app and runtime versions are independent (the WebSocket protocol is versioned).

## Why open?

The runtime is what lives inside your app. Open-source means you can read every byte of the code that touches your fibers, audit the WebSocket payloads, and fork if FloTrace ever disappears. The desktop app is closed-source commercial — that's the bit we charge for. See [flotrace.dev/security](https://flotrace.dev/security) for the full threat model.

## Contributing

Issues and PRs welcome at [github.com/flotrace](https://github.com/flotrace). The runtime packages target Hermes, V8 (Chromium), and JavaScriptCore — please test against all three when changing fiber-walker or serializer code.

## License

MIT.
