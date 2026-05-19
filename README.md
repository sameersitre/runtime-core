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

## Optional: JSX runtime opt-in (source attribution upgrade)

`runtime-core` ships two additional subpath entries — `./jsx-runtime` and `./jsx-dev-runtime` — that you can opt into via a one-line `tsconfig.json` change. Doing so lets FloTrace attribute every JSX call site to its exact `file:line:column` with 100% confidence, even on stacks where React no longer carries that signal (Next.js 15 + SWC, React 19 with `_debugSource` removed).

**The opt-in is free, additive, and reverts cleanly** — your app continues to work in production unchanged, and the existing heuristic ladder still runs when the opt-in is off.

### Setup

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@flotrace/runtime-core"
  }
}
```

Restart your dev server. That's it.

### What you get

- **Click any node in FloTrace → IDE jumps to the exact JSX line** (column included).
- **Per-call-site render metrics** instead of per-component-type. `<Button/>` at `Header.tsx:23` and `<Button/>` at `Footer.tsx:7` are now separate rows in the Hot Call Sites tab — only the actually-hot one is flagged.
- **Inline-literal detection** — the runtime sees props *before* React processes them and tags fresh-each-render `onClick={() => ...}`, `style={{}}`, `items={[...]}` at the call site that created them. This signal is impossible to recover after React commits.
- **Conditional-render visibility** — a callsite nested in `{cond && <X/>}` gets a `~N%` chip showing how often it actually renders.
- **Duplicate-key warnings** with exact source location instead of grep-the-codebase.
- **Privacy-safe Copy-as-Prompt** — every component reference cites `(src/components/Header.tsx:42)`, project-relative, never `/Users/foo/...`.
- **Watches, Resolution Tracker, Value Lineage, Cascade, Prop Drilling** all gain `(file:line)` annotations and HMR-stable call-site identity.

### Bundler matrix

| Bundler | Zero-config? | Notes |
|---|---|---|
| **Vite (+ SWC or Babel)** | ✅ | Honors `jsxImportSource` from tsconfig out of the box. |
| **Next.js 15 (Webpack)** | ✅ | SWC reads tsconfig. |
| **Next.js 15 (Turbopack)** | ✅ | Same. |
| **Remix / Vinxi** | ✅ | Same. |
| **Expo SDK 50+ (Metro + Babel)** | ✅ | Metro's Babel preset honors `jsxImportSource`. |
| **Bun** | ✅ | Built-in JSX transformer reads tsconfig. |
| **Create React App** | ⚠ Needs Babel snippet | CRA's locked Babel config doesn't honor `jsxImportSource` from tsconfig. Use CRACO (or `react-app-rewired`) to inject a Babel preset override. See snippet below. |

For CRA via CRACO, add to `craco.config.js`:

```js
module.exports = {
  babel: {
    presets: [
      ['@babel/preset-react', {
        runtime: 'automatic',
        importSource: '@flotrace/runtime-core',
        development: true, // emits jsxDEV instead of jsx in dev builds
      }],
    ],
  },
};
```

### How to verify it's working

1. **Run your app in dev mode**, open browser DevTools → Console.
2. Paste: `globalThis[Symbol.for('flotrace.jsx-runtime-active')]` → should return `true`.
3. **Open React DevTools → Components tab**, select any user component, then click the wrench icon to view its props in the Console. Run:
   ```js
   $r.memoizedProps[Symbol.for('flotrace.source')]
   ```
   You should see `{ fileName, lineNumber, columnNumber, callSiteId }`.

If step 2 returns `undefined`, your bundler isn't picking up the tsconfig setting — see the bundler matrix above. The connection-status tooltip inside the FloTrace desktop app also shows **"JSX runtime: active ✓"** once the opt-in is wired up correctly.

If step 2 returns `true` but step 3 returns `undefined` on a specific component, that fiber was created via a path that bypasses `jsxDEV` (e.g. `React.createElement` direct call inside a vendored dependency, or a server-rendered component hydrated client-side). User-authored Client Components in `.tsx` / `.jsx` files always pass through.

### Performance budget

| Cost | Target | Notes |
|---|---|---|
| Per-`jsxDEV` call overhead | **<10µs median** | Microbenchmark on V8. Path normalization + hash + inline detection + symbol-prop allocation. |
| Per-commit cumulative overhead | **<55ms** | For a 5000-element user-component tree. Well below React's own commit cost. |
| Symbol-prop memory | ~200 bytes per user-component fiber | ~1 MB for 5000 fibers. GC'd with the fiber on unmount. |
| Ring buffer memory | 60 timestamps × callSiteId count | ~2.4 MB worst case for 5000 distinct callsites. Cleared on walker uninstall. |

### Privacy

The runtime captures **absolute paths** (needed so click-to-IDE can resolve files reliably across symlinks and workspaces). Absolute paths NEVER leave your machine via:

- **WebSocket** → bound to `127.0.0.1` only; the desktop app is also local.
- **Copy-as-Prompt** → the prompt builder calls `relativizePath(absPath, projectRoot)` before serialization. Output cites `src/Header.tsx:42`, never `/Users/foo/proj/src/Header.tsx:42`.

The opt-in is **dev-only** by design. The production entry (`@flotrace/runtime-core/jsx-runtime`) is a pure passthrough to `react/jsx-runtime` — zero runtime overhead, no symbol injection, no metadata captured.

### Reverting

Delete the `jsxImportSource` line from `tsconfig.json` and restart your dev server. FloTrace falls back to its existing heuristic ladder (`_debugSource` → `_debugOwner` → `_debugStack`). No code changes needed in your app.

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
