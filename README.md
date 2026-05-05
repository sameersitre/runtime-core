# @flotrace/runtime-core

Platform-agnostic core for [FloTrace](https://flotrace.dev) — fiber walker, hook/effect inspectors, state-store trackers (Zustand / Redux / TanStack Query), serializer, and WebSocket client. Shared between [`@flotrace/runtime`](https://www.npmjs.com/package/@flotrace/runtime) (web) and [`@flotrace/runtime-native`](https://www.npmjs.com/package/@flotrace/runtime-native) (React Native).

> **You almost certainly want one of the adapter packages instead.**
>
> - **Web React app?** → [`@flotrace/runtime`](https://www.npmjs.com/package/@flotrace/runtime)
> - **React Native (Expo / bare)?** → [`@flotrace/runtime-native`](https://www.npmjs.com/package/@flotrace/runtime-native)
>
> The adapters depend on `runtime-core` and provide the wiring (provider component, network tracker, platform-specific hooks) you actually need. This package on its own does nothing useful at runtime.

`runtime-core` is published publicly so adapters can pin a compatible version and so users can audit the open-source half of FloTrace. It has zero runtime dependency on `window` / `document` / `XMLHttpRequest` — all platform-specific features live in the adapters.

---

## About FloTrace Desktop

[**FloTrace Desktop**](https://flotrace.dev) is a free Electron app (macOS / Windows / Linux) that visualizes a running React app's component hierarchy in real time. It pairs with this runtime over a local WebSocket on port `3457` — the runtime sits inside your app and emits metadata; the desktop app renders the live tree, props, hooks, effects, and state. **Source code never leaves your machine.**

What you get when this runtime is paired with the desktop:

- **Live component tree** — React Flow graph, render-flash animation, frequency-based heatmap, breadcrumb navigation.
- **Per-node inspection** — props (with diff history), hooks (14 classified types + dep diffs), effects (willRun + dep diffs), component timeline.
- **State tracking** — Zustand (per-store), Redux (with change highlighting), Router, TanStack Query (with health warnings + wasted-refetch detection), Context.
- **Render cascade tracing** — trigger log, cascade tree, flame chart, cascade compare modal.
- **Prop drilling detection** — chain detection (≥3 levels deep), severity badges, heatmap overlay, refactor recommendations.
- **Network health** — fetch / XHR tracking, method badges, status dots, duplicate detection, API → store causal correlation.
- **Watch expressions** — pin values from 8 sources (Zustand / Redux / Router / Context / Props / Hooks / TanStack Query / API).
- **AI Code Review Dashboard** — 6-tab review (Re-renders, Memo, Drilling, Effects, Compiler, Network) with Lighthouse-style scores.
- **Copy-as-Prompt** — turn any panel into an AI-ready prompt for Cursor / Claude / ChatGPT in one click.

How it fits together:

```
your React app  ←→  @flotrace/runtime[-native]  ←→  ws://localhost:3457  ←→  FloTrace Desktop
                       (this stack — open source, MIT)         (closed-source commercial)
```

[**Download FloTrace Desktop →**](https://flotrace.dev) · [Docs](https://flotrace.dev/docs) · [Security model](https://flotrace.dev/security)

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

Issues and PRs welcome at [github.com/sameersitre/runtime-core](https://github.com/sameersitre/runtime-core). The runtime packages target Hermes, V8 (Chromium), and JavaScriptCore — please test against all three when changing fiber-walker or serializer code.

## License

MIT — see [LICENSE](./LICENSE).

---

> **Mirrored from the [flotrace-desktop](https://github.com/sameersitre/flotrace-desktop) monorepo.** This repo is read-only — every release is regenerated by the lockstep publisher in the desktop monorepo. Issues filed here are tracked, but PRs are best opened against the upstream monorepo where the canonical source lives.
