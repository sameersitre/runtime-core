/**
 * Fiber Tree Walker for @flotrace/runtime
 *
 * Captures the full React component hierarchy and sends tree snapshots
 * to the FloTrace VS Code extension via WebSocket.
 *
 * Two strategies for accessing the fiber tree:
 * 1. DevTools Hook: Wraps __REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot (event-driven)
 * 2. DOM Fallback: Finds fibers via __reactFiber$ keys on DOM elements (works without DevTools)
 *
 * The DOM fallback is triggered by requestTreeSnapshot() which is called
 * from the Profiler's onRender callback - so tree walks happen after each React commit.
 */

import type {
  LiveTreeNode,
  RuntimeTreeDiffMessage,
  SerializedValue,
  DetailedRenderReason,
  PropChange,
  HookInfo,
  EffectInfo,
  SourceConfidence,
} from './types';
import {
  readJsxSourceFromFiber,
  isUserComponent,
  parseFirstNonReactFrame,
  FLOTRACE_SRC_ATTR,
  type FlotraceJsxSource,
} from './jsxRuntimeUtils';
import { serializeValue, serializeProps } from './serializer';
import { getWebSocketClient } from './websocketClient';
import { inspectHooks } from './hookInspector';
import { inspectEffects } from './effectInspector';
import { recordTimelineEvent } from './timelineTracker';
import { wrapFiberDispatchers, peekTriggers, clearTriggers } from './dispatchWrapper';
import { analyzeCascade } from './cascadeAnalyzer';
import { schedulePropDrillingAnalysis } from './propDrillingAnalyzer';
import { detectCompilerStatus } from './compilerAnalyzer';
import {
  detectServerComponent,
  maybeEmitNextjsContext,
  resetNextjsDetection,
} from './nextjsDetector';
import { scanActionStateChanges, clearActionStateCache } from './actionStateTracker';
import {
  installRscPayloadInterceptor,
  uninstallRscPayloadInterceptor,
} from './rscPayloadInterceptor';
import { findFetchOrigin, hasActiveTags } from './fetchOriginRegistry';
import { logFiberType, logTreeSnapshot, logTreeSummary } from './fiberDebugLogger';
export type { SerializedValue };

// React fiber tag constants (from React source: ReactWorkTags.js)
const FIBER_TAGS = {
  FunctionComponent: 0,
  ClassComponent: 1,
  HostRoot: 3, // Root of a host tree (e.g., #root DOM node)
  HostComponent: 5, // DOM elements (div, span, etc.) - SKIP these
  HostText: 6, // Text nodes - SKIP these
  Fragment: 7, // React.Fragment - SKIP but traverse children
  Mode: 8, // React.StrictMode, ConcurrentMode - SKIP but traverse children
  ContextConsumer: 9,
  ContextProvider: 10,
  ForwardRef: 11,
  Profiler: 12, // React.Profiler - SKIP but traverse children
  SuspenseComponent: 13,
  MemoComponent: 14,
  SimpleMemoComponent: 15,
  LazyComponent: 16,
  OffscreenComponent: 22, // React 18 concurrent features - SKIP but traverse children
} as const;

// Fiber tags that represent user components (not host/DOM elements)
const USER_COMPONENT_TAGS: Set<number> = new Set([
  FIBER_TAGS.FunctionComponent,
  FIBER_TAGS.ClassComponent,
  FIBER_TAGS.ForwardRef,
  FIBER_TAGS.MemoComponent,
  FIBER_TAGS.SimpleMemoComponent,
]);

/**
 * Minimal fiber type - only the fields we access.
 * React fibers are internal, so we type just what we use.
 */
export interface Fiber {
  tag: number;
  key: string | null;
  type: FiberType | null;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  memoizedProps: Record<string, unknown> | null;
  pendingProps: Record<string, unknown> | null;
  actualDuration?: number;
  alternate?: Fiber | null;
  stateNode?: unknown;
  _debugSource?: { fileName: string; lineNumber: number } | null;
  /** React 19+: fiber that created this fiber (owner chain). */
  _debugOwner?: Fiber | null;
  /** React 19.1+: Error captured at JSX creation site (replaces _debugSource in React 19+). */
  _debugStack?: { stack?: string } | null;
  /** Hook state linked list head (useState, useRef, useMemo, etc.) */
  memoizedState: FiberHookState | null;
  /** Effect queue (useEffect, useLayoutEffect circular list) */
  updateQueue: FiberUpdateQueue | null;
  /** Fiber flags (for detecting force updates, etc.) */
  flags: number;
  /** Pending work lanes on this fiber */
  lanes: number;
  /** Pending work lanes on this fiber's subtree */
  childLanes: number;
  /** Element type (used for context detection) */
  elementType: unknown;
  /** Context dependencies (React 18+) */
  dependencies: FiberDependencies | null;
  /** Debug hook types array (dev mode: ["useState", "useEffect", ...]) */
  _debugHookTypes?: string[] | null;
}

/**
 * Duck-type check: does this object look like a TanStack QueryObserver?
 * Uses method signatures (getCurrentResult + subscribe) which are stable
 * across TQ v4 and v5, rather than checking data fields which vary by version.
 */
function isLikelyQueryObserver(obj: unknown): obj is Record<string, unknown> {
  if (obj === null || typeof obj !== 'object') return false;
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.getCurrentResult === 'function' && typeof candidate.subscribe === 'function'
  );
}

/**
 * Extract queryHash from a confirmed QueryObserver-like object.
 * Checks multiple locations where TQ stores the hash across versions.
 */
function getQueryHashFromObserver(observer: Record<string, unknown>): string | null {
  // Path 1: observer.options.queryHash (TQ v4/v5 standard)
  if (observer.options && typeof observer.options === 'object') {
    const opts = observer.options as Record<string, unknown>;
    if (typeof opts.queryHash === 'string') return opts.queryHash;
  }
  // Path 2: observer.currentQuery.queryHash (TQ v4 internal)
  if (observer.currentQuery && typeof observer.currentQuery === 'object') {
    const q = observer.currentQuery as Record<string, unknown>;
    if (typeof q.queryHash === 'string') return q.queryHash;
  }
  // Path 3: direct observer.queryHash (rare)
  if (typeof observer.queryHash === 'string') return observer.queryHash;
  return null;
}

/**
 * Detect TanStack Query observer instances in a fiber's hook linked list.
 *
 * TQ stores QueryObserver in different hooks depending on version:
 * - v4: `useState(() => new QueryObserver(...))` — observer is memoizedState directly
 * - v5: `useRef` — observer is in memoizedState.current
 *
 * We identify QueryObserver by duck-typing its methods (getCurrentResult, subscribe)
 * rather than checking data fields, making detection version-independent.
 * Returns deduplicated array of queryHash strings, or undefined if none found.
 */
function detectQueryObserverHashes(fiber: Fiber): string[] | undefined {
  let hookState = fiber.memoizedState;
  if (!hookState) return undefined;

  const seen = new Set<string>();
  let iterations = 0;

  while (hookState && iterations < 100) {
    iterations++;
    try {
      const ms = hookState.memoizedState;

      // Pattern 1: Direct memoizedState is a QueryObserver (TQ v4 useState)
      if (isLikelyQueryObserver(ms)) {
        const hash = getQueryHashFromObserver(ms);
        if (hash) seen.add(hash);
      }
      // Pattern 2: useRef — memoizedState = { current: QueryObserver } (TQ v5)
      else if (ms !== null && typeof ms === 'object' && !Array.isArray(ms)) {
        const ref = (ms as { current?: unknown }).current;
        if (isLikelyQueryObserver(ref)) {
          const hash = getQueryHashFromObserver(ref);
          if (hash) seen.add(hash);
        }
      }
    } catch {
      // Skip malformed hooks
    }
    hookState = hookState.next as FiberHookState | null;
  }

  return seen.size > 0 ? Array.from(seen) : undefined;
}

/**
 * Count the number of hooks in a fiber's memoizedState linked list.
 * Uses _debugHookTypes if available (dev mode), falls back to linked list traversal.
 */
function countFiberHooks(fiber: Fiber): number {
  if (fiber._debugHookTypes) return fiber._debugHookTypes.length;
  let count = 0;
  let state = fiber.memoizedState;
  while (state && count < 100) {
    count++;
    state = state.next as typeof state | null;
  }
  return count;
}

/**
 * Detect if a fiber has any useContext hooks.
 * Uses fiber.dependencies (React 18+) as primary signal, _debugHookTypes as fallback.
 */
function hasFiberContextHook(fiber: Fiber): boolean {
  if (fiber.dependencies?.firstContext) return true;
  if (fiber._debugHookTypes?.includes('useContext')) return true;
  return false;
}

/**
 * Detect if any useTransition hook on this fiber currently has isPending=true.
 * useTransition stores memoizedState as [isPending: boolean, startTransition: function].
 * This shape is reliable across React 18/19 and detected the same way as hookInspector.
 */
function detectTransitionPending(fiber: Fiber): boolean {
  let state = fiber.memoizedState;
  let iterations = 0;
  while (state && iterations < 100) {
    iterations++;
    const ms = state.memoizedState;
    if (
      Array.isArray(ms) &&
      ms.length === 2 &&
      typeof ms[0] === 'boolean' &&
      typeof ms[1] === 'function'
    ) {
      if (ms[0] === true) return true;
    }
    state = state.next as FiberHookState | null;
  }
  return false;
}

// Test-only escape hatch — same pattern as `__setWalkerFilterConfigForTesting`.
// Not re-exported from `index.ts`.
export const __detectTransitionPendingForTesting = detectTransitionPending;

/**
 * Hook state linked list node from fiber.memoizedState.
 * Each hook call creates one node in this linked list.
 */
export interface FiberHookState {
  memoizedState: unknown;
  baseState: unknown;
  baseQueue: unknown;
  queue: {
    pending: unknown;
    lastRenderedReducer: ((...args: unknown[]) => unknown) | null;
    lastRenderedState: unknown;
    dispatch?: (...args: unknown[]) => void;
  } | null;
  next: FiberHookState | null;
}

/**
 * Effect structure in the updateQueue circular linked list.
 * Tag bitmask: HookHasEffect=0b0001, Insertion=0b0010, Layout=0b0100, Passive=0b1000
 */
export interface FiberEffect {
  tag: number;
  create: (() => (() => void) | void) | null;
  destroy: (() => void) | null;
  deps: unknown[] | null;
  next: FiberEffect | null;
}

interface FiberUpdateQueue {
  lastEffect: FiberEffect | null;
  /** Class component update queue — pending updates linked list */
  shared?: { pending?: unknown };
  /** Lane bits for this queue */
  lanes?: number;
}

interface FiberDependencies {
  firstContext: FiberContextDependency | null;
}

interface FiberContextDependency {
  context: { _currentValue: unknown; displayName?: string };
  memoizedValue: unknown;
  next: FiberContextDependency | null;
}

type FiberType = {
  name?: string;
  displayName?: string;
  // ForwardRef/Memo wrap an inner type
  render?: { name?: string; displayName?: string };
  type?: { name?: string; displayName?: string };
};

/**
 * FiberRoot from React internals (what onCommitFiberRoot receives)
 */
interface FiberRoot {
  current: Fiber;
}

/**
 * The global hook React DevTools uses. We piggyback on it.
 */
interface DevToolsHook {
  onCommitFiberRoot?: (rendererID: number, root: FiberRoot, priority?: number) => void;
}

declare global {
  interface Window {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook & Record<string, unknown>;
  }
  // React Native has no `window`; the DevTools hook is attached to `globalThis`.
  // Augment globalThis so the walker can read the hook uniformly across platforms.
  interface globalThis {
    __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook & Record<string, unknown>;
  }
}

type DevToolsHookGlobal = {
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevToolsHook & Record<string, unknown>;
};

// Tree size limits to prevent JSON.stringify "Invalid string length" errors
// in large apps (e.g., tables with hundreds of rows)
//
// Depth is intentionally NOT feature-limited: deeply-nested trees are real
// (nativewind doubles every element into `CssInterop.X → X`, React Navigation
// stacks add many provider/scene layers), and a shallow cap silently drops
// genuine leaf components that live far down the tree. `MAX_TREE_DEPTH` survives
// only as a recursion backstop against a malformed/cyclic fiber tree blowing the
// JS call stack. It must sit BELOW the engine's stack ceiling (V8 ≈ 10k frames)
// to actually fire — `walkFiber` recurses ~1.3–1.5× per `depth` increment (it
// recurses through transparent host/provider levels without bumping `depth`), so
// 3000 leaves comfortable headroom (~4–5k frames) while being ~10× beyond any
// realistic app depth — it never truncates a real snapshot. Snapshot byte-size
// is bounded by `MAX_CHILDREN_PER_NODE` (breadth), the actual driver of
// "Invalid string length".
const MAX_TREE_DEPTH = 3000; // Stack-overflow backstop only — not a feature limit
const MAX_CHILDREN_PER_NODE = 300; // Max children per user component node

// Throttle state for tree snapshot sending.
// Uses adaptive rate: small trees get frequent snapshots, large trees get
// throttled to avoid blocking the user's app main thread with walkFiber() + JSON.stringify().
// Unlike a simple debounce, this guarantees snapshots fire within maxWait even during
// rapid React commits (e.g., Next.js hydration replacing Skeleton → real content).
let throttleTimer: ReturnType<typeof setTimeout> | null = null;
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
const INTERVAL_MS_SMALL = 200; // < 50 components → 5 snapshots/sec
const INTERVAL_MS_MEDIUM = 500; // 50-200 components → 2 snapshots/sec
const INTERVAL_MS_LARGE = 1000; // 200+ components → 1 snapshot/sec
let snapshotIntervalMs = INTERVAL_MS_SMALL; // Starts fast, adapts after first snapshot

// Cache the last-seen FiberRoot so requestFullSnapshot() can actively trigger a walk
let cachedFiberRoot: FiberRoot | null = null;

// Track whether we're currently walking (to avoid recursive/concurrent walks)
let isWalking = false;

// Accumulated useState/useReducer → API correlations during walkFiber, flushed after tree is built
const pendingLocalStateCorrelations: Array<{
  requestId: string;
  componentName: string;
  hookIndex: number;
}> = [];

// Store the original hook so we can restore it
let originalOnCommitFiberRoot: DevToolsHook['onCommitFiberRoot'] | null = null;
let isInstalled = false;
let hookedRendererID: number | null = null;

/** Platform-specific hooks the walker reads during descent. */
export interface FiberTreeWalkerOptions {
  /**
   * Per-node predicate invoked for every user-component node after it has been
   * fully assembled. Returning true drops the node (and its descendants) from
   * the emitted tree. Platforms use this to hide subtrees that are not visible
   * to the user — e.g. React Native inactive screens, React `<Modal>` overlays,
   * or lib/framework-only subtrees. Default: never prune.
   */
  pruneSubtree?: (node: LiveTreeNode) => boolean;
  /**
   * Extra component names treated as framework internals (merged with the built-in
   * web list). Platforms use this to tag RN / React Navigation / Reanimated /
   * Gesture Handler / Safe Area / FlashList wrappers without forking the walker.
   */
  frameworkComponentNames?: string[];
  /**
   * Extra display-name regex patterns treated as framework internals. Used for
   * generated names that can't be enumerated exhaustively — e.g. React Native's
   * `Animated(View)` / `Animated(Anonymous)` HOC output or `_withRef` forwardRef
   * wrappers. Checked when the exact-name set misses.
   */
  frameworkComponentNamePatterns?: RegExp[];
  /**
   * Extra path patterns treated as framework source (merged with the built-in
   * web list). Checked against fiber._debugSource.fileName in dev mode.
   */
  frameworkPathPatterns?: RegExp[];
  /**
   * Host-node name prefixes to skip at the host-component layer (mirror of the
   * DOM-element filter). React Native sets this to `["RCT"]` so native host
   * views like `RCTView`/`RCTText` don't appear in the tree.
   */
  hostComponentSkipPrefixes?: string[];
  /**
   * **Experimental.** Default-deny mode: a fiber is treated as framework
   * unless there is positive source-path evidence that it originates from user
   * code. Evidence resolution order (first match wins):
   *   1. `fiber._debugSource.fileName`
   *   2. owner-chain walk of `fiber._debugOwner._debugSource.fileName` (3 hops)
   *   3. first non-react frame parsed from `fiber._debugStack.stack`
   * A fiber passes iff the resolved path is defined AND does not contain
   * `node_modules` AND matches `userAllowPatterns` when that list is set.
   *
   * Rationale: library code is typically published pre-transpiled so the JSX
   * source plugin never runs on it, and `_debugSource` is absent. Flipping the
   * default from allow-list (enumerate every wrapper) to deny-list (require
   * user evidence) eliminates most of the per-library maintenance burden.
   *
   * Degrades gracefully: when strict mode is on but the runtime populates zero
   * `_debugSource` info on any fiber (e.g. Next.js SWC without the plugin),
   * the name-based filter remains the fallback.
   */
  userOnlyStrict?: boolean;
  /**
   * Regex patterns that explicitly mark paths as user code even when they
   * would otherwise be hidden (e.g. a monorepo package resolved into
   * `node_modules/@workspace/ui/dist/*`). Only consulted when `userOnlyStrict`
   * is on. Checked BEFORE the `node_modules` deny rule.
   */
  userAllowPatterns?: RegExp[];
}

let walkerOptions: FiberTreeWalkerOptions = {};

// Filter configuration — rebuilt when walker options change. Consolidated into a
// single object so adding/removing filter flags touches one place, and `uninstall`
// can reset everything to defaults via a factory. Initialized empty to avoid TDZ
// on the `FRAMEWORK_*` constants declared further down; `installFiberTreeWalker`
// fills the real values.
interface WalkerFilterConfig {
  frameworkNames: Set<string>;
  frameworkNamePatterns: readonly RegExp[];
  frameworkPathPatterns: readonly RegExp[];
  hostSkipPrefixes: readonly string[];
  userOnlyStrict: boolean;
  userAllowPatterns: readonly RegExp[];
}

function defaultFilterConfig(): WalkerFilterConfig {
  return {
    frameworkNames: new Set(),
    frameworkNamePatterns: [],
    frameworkPathPatterns: [],
    hostSkipPrefixes: [],
    userOnlyStrict: false,
    userAllowPatterns: [],
  };
}

let walkerFilterConfig: WalkerFilterConfig = defaultFilterConfig();

// Test-only escape hatch — lets unit tests seed filter state without going
// through `installFiberTreeWalker` (which requires a browser-like environment,
// DevTools hooks, WebSocket, etc.). Not re-exported from `index.ts`.
export function __setWalkerFilterConfigForTesting(partial: Partial<WalkerFilterConfig>): void {
  walkerFilterConfig = { ...defaultFilterConfig(), ...partial };
}
export function __resetWalkerFilterConfigForTesting(): void {
  walkerFilterConfig = defaultFilterConfig();
}

// Track which strategy is active
let activeStrategy: 'devtools' | 'dom' | null = null;

// Track when the last snapshot was actually sent, so the Profiler-based
// fallback can kick in if the DevTools hook stops firing (React 19 compat).
let lastSnapshotSentTime = 0;
const DEVTOOLS_STALE_THRESHOLD_MS = 2000; // If no DevTools snapshot in 2s, allow DOM fallback

// Debug logging — disabled by default to avoid polluting the user's browser console.
// Enable via: window.__FLOTRACE_DEBUG__ = true
let debugEnabled = false;
try {
  debugEnabled = !!(globalThis as unknown as { __FLOTRACE_DEBUG__?: boolean }).__FLOTRACE_DEBUG__;
} catch {
  /* SSR safe */
}
function debugLog(...args: unknown[]): void {
  if (debugEnabled) console.log(...args);
}

// Fiber reference cache: nodeId → fiber, rebuilt on every tree walk.
// Used for on-demand props lookup (getNodeProps) so we don't re-walk the tree.
// Fiber references stay valid because React reuses fiber objects across renders.
let fiberRefMap: Map<string, Fiber> = new Map();

/**
 * Get the display name of a fiber's component type.
 */
function getComponentName(fiber: Fiber): string {
  logFiberType(fiber, 'getName');
  const type = fiber.type;
  if (!type) return 'Unknown';

  // Direct function/class component
  if (typeof type === 'function') {
    return (type as FiberType).displayName || (type as FiberType).name || 'Anonymous';
  }

  // Object-based types (ForwardRef, Memo)
  if (typeof type === 'object' && type !== null) {
    const t = type as FiberType;
    // Memo wraps type
    if (t.type) {
      return t.type.displayName || t.type.name || 'Memo';
    }
    // ForwardRef wraps render
    if (t.render) {
      return t.render.displayName || t.render.name || 'ForwardRef';
    }
    return t.displayName || t.name || 'Unknown';
  }

  // String type means host component (div, span)
  if (typeof type === 'string') {
    return type;
  }

  return 'Unknown';
}

/**
 * Heuristic "likely user-defined component" check — fiber-tag gate plus name +
 * `_debugSource` + host-prefix filters. Returns `true` when nothing OBVIOUSLY
 * marks this fiber as framework/library/host. Authoritative user-code proof
 * comes from `isUserComponent` (imported from `jsxRuntimeUtils`), which
 * reads the babel-plugin declaration-site tag.
 *
 * Renamed from `isUserComponent` to avoid colliding with the imported helper.
 * The two are layered: this is a coarse heuristic filter applied to every
 * fiber walk; the imported `isUserComponent` is a top-priority short-circuit
 * used by `isFrameworkComponent`/`detectLibraryName`/`resolveSourceConfidence`
 * to override mis-classifications when the plugin signal is present.
 */
function isLikelyUserComponent(fiber: Fiber): boolean {
  if (!USER_COMPONENT_TAGS.has(fiber.tag)) return false;

  const name = getComponentName(fiber);

  // Filter generic React wrapper names that have no specific component identity
  if (name === 'Anonymous' || name === 'Unknown' || name === 'ForwardRef' || name === 'Memo')
    return false;

  // Filter FloTrace's own internal components (provider, profiler wrapper, HOC wrappers)
  if (name.startsWith('FloTrace')) return false;

  // Filter library-style displayNames (e.g., "@mantine/core/Box", "@radix-ui/Popover").
  // Libraries set displayName with the scoped package path — user components never do this.
  // NOTE: This filters the *displayName* string, not the import path. A component `function Header()`
  // imported from `@common/components/header.tsx` (monorepo scoped package) will have
  // name = "Header" here, so it is NOT affected by this filter.
  if (name.startsWith('@') || name.includes('/')) return false;

  // Filter React Compiler-generated cache variable names (e.g., "_c", "_T", "$r").
  // These are short identifiers starting with _ or $ — not real component names; pure noise.
  if (/^[$_][A-Za-z0-9]{0,3}$/.test(name)) return false;

  // If _debugSource points to node_modules, it's a pre-bundled library component.
  // Monorepo workspace packages in dev mode resolve via symlinks to their actual source paths
  // (e.g., /workspace/packages/ui/src/Button.tsx), so they are NOT affected by this check.
  if (fiber._debugSource?.fileName?.includes('node_modules')) return false;

  // Platform host-component prefix filter — mirrors the DOM-element skip on web.
  // React Native leaks `RCTView`/`RCTScrollView`/etc. through as user-component-tag
  // fibers; their children are already surfaced via the transparent-wrapper branch,
  // so we drop the wrapper name itself from the tree.
  if (walkerFilterConfig.hostSkipPrefixes.length > 0) {
    for (const prefix of walkerFilterConfig.hostSkipPrefixes) {
      if (name.startsWith(prefix)) return false;
    }
  }

  return true;
}

// ============================================================================
// Framework component detection
// ============================================================================

/**
 * Known framework/library wrapper component names.
 * These pass isLikelyUserComponent() but are framework internals users typically don't want to see.
 *
 * React 19 notes:
 * - <Activity> replaces the old <Offscreen> experimental primitive
 * - <ViewTransition> appears in Next.js 15 (which ships React 19) as a transition wrapper
 * - Server Action context providers (ActionStateContext) are Next.js 15 internals
 */
const FRAMEWORK_COMPONENT_NAMES: Set<string> = new Set([
  // Next.js App Router internals (Next.js 13–14)
  'InnerLayoutRouter',
  'OuterLayoutRouter',
  'HotReload',
  'RedirectBoundary',
  'NotFoundBoundary',
  'RenderFromTemplateContext',
  'ScrollAndFocusHandler',
  'AppRouter',
  'ServerRoot',
  'ReactDevOverlay',
  'PathnameContextProviderAdapter',
  'MetadataBoundary',
  'ViewportBoundary',
  'NotFoundErrorBoundary',
  'RedirectErrorBoundary',
  'InnerScrollAndFocusHandler',
  'GlobalError',
  // Next.js 15 / React 19 new internals
  'ViewTransition', // Next.js 15 shared-element transition wrapper
  'ActionStateContext', // Next.js 15 server action state context provider
  'RequestCookiesProvider',
  'DraftModeProvider',
  // React Router v6 / v7
  'Routes',
  'Route',
  'Router',
  'BrowserRouter',
  'HashRouter',
  'MemoryRouter',
  'Outlet',
  'Navigate',
  'RenderedRoute',
  'RouterProvider',
  // React 19 built-in primitives
  'Activity', // React 19: show/hide subtrees while preserving state (was <Offscreen>)
  // Common library wrappers
  'Suspense',
  'ErrorBoundary',
  'QueryClientProvider',
  'PersistGate',
]);

/**
 * File path patterns indicating framework/library source.
 * Checked against fiber._debugSource.fileName (dev mode only).
 */
const FRAMEWORK_PATH_PATTERNS: RegExp[] = [
  // React core / Next.js
  /next[\\/]dist/,
  /react-dom/,
  /[\\/]scheduler[\\/]/, // React internal scheduler package
  // Routing
  /react-router/, // React Router v6
  /@react-router[\\/]/, // React Router v7 (scoped package)
  // State management
  /@tanstack[\\/]/, // TanStack Query / Table / Router / Form / Virtual
  /react-redux/,
  /zustand/,
  /jotai/,
  /recoil/,
  // UI component libraries (for when source maps are available)
  /@fortawesome[\\/]/, // Font Awesome icons
  /framer-motion/, // Framer Motion (PresenceChild, AnimatePresence, etc.)
  /sonner/, // Sonner toast
  /@radix-ui[\\/]/, // Radix UI primitives
  /@headlessui[\\/]/, // Headless UI
  /@mui[\\/]/, // Material UI
  /@chakra-ui[\\/]/, // Chakra UI
  /react-spring/, // React Spring
  /react-transition-group/, // React Transition Group
  /react-aria/, // Adobe React Aria
  /react-hook-form/,
  /formik/,
];

/**
 * Detect if a user-visible component is actually a framework/library wrapper.
 * Called only for fibers that already passed isLikelyUserComponent().
 *
 * Platform adapters can inject extra names/patterns via
 * `installFiberTreeWalker({ frameworkComponentNames, frameworkPathPatterns })`.
 */
/**
 * Resolved location for a fiber: file path plus (when available) line/column.
 *
 * `lineNumber` / `columnNumber` are optional because the owner-chain tier only
 * yields a path (the wrapper's call site isn't the fiber's own — copying its
 * line would land click-to-IDE on the wrong file).
 */
type EffectiveSourceLocation = {
  fileName: string;
  lineNumber?: number;
  columnNumber?: number;
};

/**
 * Resolve the most useful source location for a fiber, trying evidence
 * sources in priority order:
 *   1. `fiber.memoizedProps[FLOTRACE_SOURCE]` — JSX-runtime opt-in
 *      (highest confidence; full {fileName, lineNumber, columnNumber})
 *   2. `fiber._debugSource` — React 17/18 + early 19 (Babel JSX plugin)
 *   3. `fiber._debugOwner` chain (3-hop) — enriches wrappers that don't carry
 *      `_debugSource` themselves but are rendered by user code that does.
 *      Path-only — the wrapper's own line is not its caller's line.
 *   4. `fiber._debugStack.stack` first non-react frame — React 19.1+ replaces
 *      `_debugSource` with an Error object captured at JSX-creation time.
 *      Carries line/column.
 */
function resolveEffectiveSourceLocation(fiber: Fiber): EffectiveSourceLocation | null {
  const jsxSrc = readJsxSourceFromFiber(fiber);
  if (jsxSrc) {
    return {
      fileName: jsxSrc.fileName,
      lineNumber: jsxSrc.lineNumber,
      columnNumber: jsxSrc.columnNumber,
    };
  }

  if (fiber._debugSource?.fileName) {
    return {
      fileName: fiber._debugSource.fileName,
      lineNumber: fiber._debugSource.lineNumber,
    };
  }

  const ownerHit = walkAncestors<string>(
    fiber._debugOwner ?? null,
    3,
    (f) => f._debugOwner ?? null,
    (cur) => cur._debugSource?.fileName ?? undefined,
  );
  if (ownerHit) return { fileName: ownerHit };

  const stack = fiber._debugStack?.stack;
  if (typeof stack === 'string') {
    const parsed = parseFirstNonReactFrame(stack);
    if (parsed) return parsed;
  }

  return null;
}

/**
 * Path-only convenience wrapper for callers that only need the file name
 * (framework/library detection, confidence tier). New code should prefer
 * `resolveEffectiveSourceLocation` so click-to-IDE can land on the exact
 * line under React 19.
 */
function resolveEffectiveSourcePath(fiber: Fiber): string | null {
  return resolveEffectiveSourceLocation(fiber)?.fileName ?? null;
}

/**
 * Compute the four-tier source-confidence for a fiber. Pure decision tree —
 * mirrors `resolveEffectiveSourcePath`'s priority ladder but returns the tier
 * rather than the resolved path. Used to drive the OriginBadge variant.
 *
 * Framework / library nodes short-circuit to `'package'` regardless of any
 * source signal they may have inherited from a wrapping user component —
 * we don't want a `?` pill or file-line link on `<RedirectErrorBoundary>`.
 *
 * `precomputedJsxSource` lets the caller pass in an already-read value to
 * avoid a second symbol lookup on every fiber visit (the walker reads it
 * once for `node.jsxSource` assignment and reuses it here).
 */
function resolveSourceConfidence(
  fiber: Fiber,
  isFramework: boolean,
  isLibrary: boolean,
  precomputedJsxSource?: FlotraceJsxSource | undefined,
): SourceConfidence {
  // Top-priority signal: the babel plugin's declaration-site tag on
  // `fiber.type` is authoritative proof of user code. Override the
  // `isFramework || isLibrary → 'package'` shortcut when present so a user
  // component sharing a name with a framework wrapper still surfaces as
  // `'exact'` (no `fw`/`lib` badge in the inspector).
  if (isUserComponent(fiber)) return 'exact';
  if (isFramework || isLibrary) return 'package';
  const jsxSrc = precomputedJsxSource ?? readJsxSourceFromFiber(fiber);
  if (jsxSrc) return 'exact';
  if (fiber._debugSource?.fileName) return 'exact';
  if (resolveEffectiveSourcePath(fiber)) return 'inferred';
  return 'unknown';
}

/**
 * Sentinel returned from a `walkAncestors` visitor to halt the climb with
 * `undefined` — used when a semantic boundary is reached (e.g. an emitted
 * non-framework user ancestor whose identity belongs to itself).
 */
const STOP_WALK: unique symbol = Symbol('stop-walk');
type WalkVisit<T> = T | typeof STOP_WALK | undefined;

/**
 * Walks up to `maxHops` ancestors starting from `start`, moving via `next`.
 * Returns the first defined value produced by `visit`; returns `undefined`
 * when `visit` emits STOP_WALK or the hop/null limit is reached.
 *
 * Starting pointer is visited (not skipped) — callers pass e.g. `fiber.return`
 * when they want to exclude the fiber itself.
 */
function walkAncestors<T>(
  start: Fiber | null,
  maxHops: number,
  next: (fiber: Fiber) => Fiber | null | undefined,
  visit: (fiber: Fiber) => WalkVisit<T>,
): T | undefined {
  let cur: Fiber | null = start;
  for (let hops = 0; cur && hops < maxHops; hops++, cur = next(cur) ?? null) {
    const out = visit(cur);
    if (out === STOP_WALK) return undefined;
    if (out !== undefined) return out;
  }
  return undefined;
}

function isFrameworkComponent(fiber: Fiber, name: string): boolean {
  // Top-priority signal: the babel plugin's declaration-site tag on
  // `fiber.type` is authoritative proof that this component is user code.
  // Short-circuit BEFORE the name-list / regex / path heuristics fire, so a
  // user component that happens to share a name with a framework wrapper
  // (e.g. user-defined `Provider` or `Modal`) doesn't get hidden.
  if (isUserComponent(fiber)) return false;

  if (walkerFilterConfig.frameworkNames.has(name)) return true;

  for (const pattern of walkerFilterConfig.frameworkNamePatterns) {
    if (pattern.test(name)) return true;
  }

  // Strict mode: require positive source-path evidence that this fiber is user
  // code. Allowlist takes precedence, then node_modules deny-rule fires.
  if (walkerFilterConfig.userOnlyStrict) {
    const effective = resolveEffectiveSourcePath(fiber);
    if (effective) {
      for (const allow of walkerFilterConfig.userAllowPatterns) {
        if (allow.test(effective)) return false;
      }
      if (effective.includes('node_modules')) return true;
    }
    // When strict mode is on AND no evidence is present at all, fall through
    // to the path-pattern check below (degrade gracefully rather than force-hide,
    // since some bundlers legitimately omit all source metadata).
  }

  // Library code is published pre-transpiled, so `_debugSource` is usually only
  // present on user JSX — path-based detection here is a best-effort safety net,
  // not the primary strategy. Name-based detection above is the reliable path.
  const filePath = fiber._debugSource?.fileName;
  if (filePath) {
    for (const pattern of walkerFilterConfig.frameworkPathPatterns) {
      if (pattern.test(filePath)) return true;
    }
  }

  return false;
}

// ============================================================================
// Library component detection
// ============================================================================

/**
 * Well-known third-party library component names → short display label.
 * Used as an explicit fallback when _debugSource is absent (pre-bundled library).
 */
const KNOWN_LIBRARY_NAMES = new Map<string, string>([
  // Font Awesome
  ['FontAwesomeIcon', 'fontawesome'],
  ['FontAwesomeLayers', 'fontawesome'],
  ['FontAwesomeLayersText', 'fontawesome'],
  // Framer Motion
  ['AnimatePresence', 'framer'],
  ['LazyMotion', 'framer'],
  ['MotionConfig', 'framer'],
  ['PresenceChild', 'framer'],
  ['LayoutGroupContext', 'framer'],
  // Lottie
  ['Lottie', 'lottie'],
  ['LottiePlayer', 'lottie'],
  // Heroicons / Lucide exported icons sometimes appear as named functions
  ['HeroIcon', 'heroicons'],
]);

/**
 * Detect if a component that passed isLikelyUserComponent() is actually a third-party library component.
 * Returns a short library label if detected, undefined if it looks like user code.
 *
 * Detection strategies (in priority order):
 * 1. Dot-notation displayName — library sub-component pattern (Radix, Sonner, Headless UI, etc.)
 *    Libraries set displayName like "DropdownMenu.Item"; user components never do this.
 * 2. Double-underscore markers — framework/library internal names ("__next_outlet_boundary__")
 *    that slipped past isFrameworkComponent() (e.g., not yet in the known-names list).
 * 3. Explicit KNOWN_LIBRARY_NAMES — canonical names for well-known pre-bundled components.
 *
 * NOTE: _debugSource absence is NOT used as a fallback. Next.js (SWC compiler) does not inject
 * _debugSource into fiber nodes, so its absence cannot distinguish library from user code.
 */
function detectLibraryName(fiber: Fiber, name: string): string | undefined {
  // Top-priority signal: the babel plugin's declaration-site tag on
  // `fiber.type` is authoritative proof that this component is user code.
  // Short-circuit BEFORE the name-pattern checks so a user component whose
  // name happens to look library-shaped (e.g. `Primitive.div`-style or a
  // user-defined `__internal`) doesn't get mis-classified as `lib`.
  if (isUserComponent(fiber)) return undefined;

  // Dot-notation: "ToastCollectionSlot.Slot", "Primitive.div", "DropdownMenu.Trigger"
  if (name.includes('.')) {
    return name.split('.')[0].toLowerCase();
  }

  // Double-underscore internal markers (framework/library internals)
  if (name.startsWith('__')) {
    return 'internal';
  }

  // Explicit known library names (pre-bundled components identifiable by name alone).
  // NOTE: Do NOT fall back to "library" for all components missing _debugSource.
  // Next.js uses SWC by default which does NOT inject _debugSource into fibers —
  // absence of _debugSource is not a reliable signal across all bundlers.
  const known = KNOWN_LIBRARY_NAMES.get(name);
  return known;
}

/**
 * Build a path-based stable ID for a fiber node.
 * Format: "App-0/Dashboard-0/Card-2"
 */
function buildNodeId(name: string, sameNameIndex: number, parentId: string): string {
  const segment = `${name}-${sameNameIndex}`;
  return parentId ? `${parentId}/${segment}` : segment;
}

/**
 * Shallow-compare two props objects by reference equality per key.
 * Returns true if any key was added, removed, or changed reference.
 */
function shallowPropsChanged(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): boolean {
  if (prev === next) return false;
  if (!prev || !next) return true;

  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);

  if (prevKeys.length !== nextKeys.length) return true;

  for (const key of nextKeys) {
    // Skip React internal keys (children is always "changed" on re-render)
    if (key === 'children') continue;
    if (prev[key] !== next[key]) return true;
  }

  return false;
}

/**
 * Determine why a fiber re-rendered by comparing current vs previous props.
 */
function detectRenderReason(
  fiber: Fiber,
  renderPhase: 'mount' | 'update',
): 'mount' | 'props-changed' | 'state-or-context' | 'parent' {
  if (renderPhase === 'mount') return 'mount';

  // fiber.alternate holds the previous version of this fiber
  const prev = fiber.alternate;
  if (!prev) return 'mount';

  // Compare props: if props changed, that's the reason
  if (shallowPropsChanged(prev.memoizedProps, fiber.memoizedProps)) {
    return 'props-changed';
  }

  // Props are identical — the render was caused by internal state change
  // (useState, useReducer, useContext) or a parent re-render forcing this component
  // We can't reliably distinguish state vs context vs parent without accessing
  // memoizedState (unstable internal), so we use a single bucket
  return 'state-or-context';
}

/**
 * Scan a user component's hook linked list for useState/useReducer values that
 * match a tagged API response in the WeakMap. Only called when hasActiveTags()
 * is true (zero-cost when no fetch is in-flight). Results accumulate in
 * pendingLocalStateCorrelations and are emitted after the tree walk.
 */
function scanFiberStateForOrigin(fiber: Fiber, componentName: string): void {
  let hook: FiberHookState | null = fiber.memoizedState;
  let hookIndex = 0;
  while (hook !== null) {
    try {
      const ms = hook.memoizedState;
      // Only scan object values — primitives can't be WeakMap keys
      if (ms !== null && typeof ms === 'object') {
        // Skip effect hooks: {tag, create, deps} shape
        const isEffect =
          'tag' in (ms as Record<string, unknown>) && 'create' in (ms as Record<string, unknown>);
        if (!isEffect) {
          const rid = findFetchOrigin(ms);
          if (rid) {
            pendingLocalStateCorrelations.push({ requestId: rid, componentName, hookIndex });
          } else if (hook.queue !== null) {
            // Also check useReducer's lastRenderedState
            const lastRendered = (hook.queue as { lastRenderedState: unknown }).lastRenderedState;
            if (lastRendered !== null && typeof lastRendered === 'object') {
              const rid2 = findFetchOrigin(lastRendered);
              if (rid2) {
                pendingLocalStateCorrelations.push({ requestId: rid2, componentName, hookIndex });
              }
            }
          }
        }
      }
    } catch {
      /* never break the tree walk */
    }
    hook = hook.next;
    hookIndex++;
  }
}

/**
 * Resolve the React `key` that visually belongs to this component.
 *
 * Direct key (`<X key="a" />`) wins. Otherwise we walk up through framework /
 * transparent wrappers and inherit the first string key we find. This is what
 * makes mapped-list children show up with a key in the graph even though the
 * common RN pattern puts the key on a hidden wrapper:
 *
 *   <FlatList data={items} keyExtractor={i => i.id} renderItem={...} />
 *     → CellRenderer  (fiber.key = extracted id, FILTERED as framework)
 *       → View        (host, no key)
 *         → RowCard   (fiber.key = null — what walkFiber sees directly)
 *
 * We stop the climb at the nearest *emitted user* ancestor so we never steal
 * another sibling's key, and cap at 6 hops so deeply-buried wrappers don't
 * inherit irrelevant keys from far up the tree.
 */
// Exported for test harness only — not re-exported from `index.ts`, so not part
// of the package's public API surface.
export function resolveEffectiveReactKey(fiber: Fiber): string | undefined {
  if (typeof fiber.key === 'string') return fiber.key;
  return walkAncestors<string>(
    fiber.return ?? null,
    6,
    (f) => f.return ?? null,
    (cur) => {
      // Another emitted non-framework user component above — stop, the key (if any)
      // belongs to that node, not to us.
      if (isLikelyUserComponent(cur) && !isFrameworkComponent(cur, getComponentName(cur))) {
        return STOP_WALK;
      }
      return typeof cur.key === 'string' ? cur.key : undefined;
    },
  );
}

/**
 * Walk the fiber tree starting from a fiber node.
 * Skips host elements and transparent wrappers, keeps user components.
 *
 * @param sharedNameCountMap - When provided, this map is shared across recursive calls
 *   for transparent wrappers at the same logical level. This prevents duplicate IDs
 *   when sibling wrappers (e.g., <div>, SortableItem) each contain a user component
 *   with the same name — a common pattern in lists/tables.
 */
// Test-only escape hatch — same pattern as `__setWalkerFilterConfigForTesting`.
// Not re-exported from `index.ts`. Lets unit tests exercise Suspense / Offscreen
// propagation and field assignment without spinning up React + DOM.
// eslint-disable-next-line @typescript-eslint/no-use-before-define
export const __walkFiberForTesting = (
  fiber: Fiber | null,
  parentId = 'root',
  inSuspenseFallback = false,
): LiveTreeNode[] => walkFiber(fiber, parentId, undefined, 0, inSuspenseFallback);

/**
 * Test-only escape hatch exposing the JSX-runtime source helpers so unit
 * tests can exercise them on synthetic fiber shapes without going through
 * the full walker. Not re-exported from `index.ts` — adapter packages never
 * see these.
 */
export const __readJsxSourceFromFiberForTesting = readJsxSourceFromFiber;
export const __resolveSourceConfidenceForTesting = resolveSourceConfidence;
export const __resolveEffectiveSourcePathForTesting = resolveEffectiveSourcePath;
export const __resolveEffectiveSourceLocationForTesting = resolveEffectiveSourceLocation;
export const __parseFirstNonReactFrameForTesting = parseFirstNonReactFrame;

function walkFiber(
  fiber: Fiber | null,
  parentId: string,
  sharedNameCountMap?: Map<string, number>,
  depth = 0,
  inSuspenseFallback = false,
): LiveTreeNode[] {
  if (!fiber) return [];

  // Recursion backstop only (see MAX_TREE_DEPTH): guards against a malformed /
  // cyclic fiber tree blowing the JS call stack. Real app depth never reaches it,
  // so this no longer truncates genuine deep leaf components.
  if (depth >= MAX_TREE_DEPTH) return [];

  const nodes: LiveTreeNode[] = [];
  let current: Fiber | null = fiber;

  // Use shared map if provided (for promoted children from transparent wrappers),
  // otherwise create a new one for this sibling group
  const nameCountMap = sharedNameCountMap || new Map<string, number>();

  while (current) {
    // Per-node try-catch so one bad fiber doesn't kill the entire tree walk
    try {
      const tag = current.tag;

      if (isLikelyUserComponent(current)) {
        const name = getComponentName(current);
        const nameCount = nameCountMap.get(name) || 0;
        nameCountMap.set(name, nameCount + 1);

        const nodeId = buildNodeId(name, nameCount, parentId);

        // Store fiber reference for on-demand props lookup via getNodeProps()
        fiberRefMap.set(nodeId, current);

        const renderPhase: 'mount' | 'update' = current.alternate ? 'update' : 'mount';
        const renderReason = detectRenderReason(current, renderPhase);

        // Record timeline event for this component
        recordTimelineEvent(
          nodeId,
          name,
          renderPhase === 'mount' ? 'mount' : 'render',
          { reason: renderReason },
          current.actualDuration,
        );

        // Children of a user component start with a fresh nameCountMap (new parent level)
        // Increment depth for user component nesting
        const children = walkFiber(current.child, nodeId, undefined, depth + 1, inSuspenseFallback);

        // Truncate children if there are too many (e.g., large tables/lists)
        const truncatedChildren =
          children.length > MAX_CHILDREN_PER_NODE
            ? children.slice(0, MAX_CHILDREN_PER_NODE)
            : children;

        const framework = isFrameworkComponent(current, name) || undefined;
        const queryHashes = detectQueryObserverHashes(current);
        const isTransitionPending = detectTransitionPending(current) || undefined;
        const compilerStatus = detectCompilerStatus(current);
        const isServerComponent = detectServerComponent(current) || undefined;
        // Library detection: only run for non-framework components; framework components
        // are already categorized and hidden/shown via the framework filter toggle.
        const libraryName = framework ? undefined : detectLibraryName(current, name);

        // JSX-runtime source attribution (highest confidence): if the user
        // opted into `"jsxImportSource": "@flotrace/runtime-core"`, the symbol
        // is on memoizedProps. When present, prefer it over _debugSource for
        // filePath/lineNumber so click-to-IDE lands on the exact JSX position.
        // Read once and reuse — single symbol lookup per fiber visit.
        const jsxSource = readJsxSourceFromFiber(current);
        const sourceConfidence = resolveSourceConfidence(
          current,
          framework === true,
          libraryName !== undefined,
          jsxSource,
        );

        // React 19.1+ stops populating `_debugSource` — only `_debugStack` survives.
        // Without the stack-frame fallback for line/col, the click-to-source button
        // at ComponentNode.tsx:75 (gate `filePath && lineNumber > 0`) never renders
        // for React 19 consumers. Only reach for the stack parse when the cheap
        // tiers haven't already produced both fields.
        const needsStackFallback =
          (jsxSource?.fileName ?? current._debugSource?.fileName) === undefined ||
          (jsxSource?.lineNumber ?? current._debugSource?.lineNumber) === undefined;
        const stackLocation = needsStackFallback
          ? resolveEffectiveSourceLocation(current)
          : null;

        const node: LiveTreeNode = {
          id: nodeId,
          name,
          children: truncatedChildren,
          fiberTag: tag,
          renderPhase,
          renderReason,
          renderDuration: current.actualDuration,
          filePath:
            jsxSource?.fileName ?? current._debugSource?.fileName ?? stackLocation?.fileName,
          lineNumber:
            jsxSource?.lineNumber ??
            current._debugSource?.lineNumber ??
            stackLocation?.lineNumber,
          isFramework: framework,
          reactKey: resolveEffectiveReactKey(current),
          queryHashes,
          hookCount: countFiberHooks(current),
          hasContextHook: hasFiberContextHook(current) || undefined,
          isTransitionPending,
          isSuspenseFallback: inSuspenseFallback || undefined,
          compilerStatus,
          isServerComponent,
          isLibrary: libraryName !== undefined ? true : undefined,
          libraryName,
          jsxSource,
          sourceConfidence,
        };

        // Platform-specific prune hook: RN active-screen filter, Modal overlays, etc.
        // Default (no hook installed) never prunes — behavior identical to pre-hook.
        // Children were already walked above; if we prune, we simply discard the
        // assembled node and let the normal sibling advance at the end of the loop run.
        if (!walkerOptions.pruneSubtree?.(node)) {
          nodes.push(node);
        }

        // Scan hook state for API response correlation (zero-cost when no fetch is in-flight)
        if (hasActiveTags() && current.memoizedState !== null) {
          scanFiberStateForOrigin(current, name);
        }
      } else if (tag === FIBER_TAGS.HostText) {
        // Text nodes have no children to traverse - skip entirely
      } else if (tag === FIBER_TAGS.SuspenseComponent) {
        // Suspense boundary: only walk the VISIBLE subtree.
        // Structure: SuspenseComponent → child(primary OffscreenComponent) → sibling(fallback)
        // When memoizedState === null → resolved (primary visible, fallback hidden)
        // When memoizedState !== null → showing fallback (primary hidden)
        const primary = current.child;
        if (current.memoizedState === null && primary) {
          // Resolved: walk primary OffscreenComponent's children (real content)
          const childNodes = walkFiber(
            primary.child,
            parentId,
            nameCountMap,
            depth,
            inSuspenseFallback,
          );
          nodes.push(...childNodes);
        } else if (primary?.sibling) {
          // Fallback: mark all nodes in this subtree as isSuspenseFallback=true
          const childNodes = walkFiber(
            primary.sibling,
            parentId,
            nameCountMap,
            depth,
            true, // all nodes in the fallback branch get isSuspenseFallback
          );
          nodes.push(...childNodes);
        } else {
          debugLog('[FloTrace] SuspenseComponent has no walkable children');
        }
      } else if (tag === FIBER_TAGS.OffscreenComponent) {
        // React 18+ OffscreenComponent: wraps Suspense primary/fallback content.
        // When memoizedState is non-null, this subtree is HIDDEN (e.g., a resolved
        // Suspense fallback that React keeps around for future use). Skip hidden
        // subtrees to avoid showing stale Skeleton components alongside real content.
        if (current.memoizedState === null) {
          const childNodes = walkFiber(
            current.child,
            parentId,
            nameCountMap,
            depth,
            inSuspenseFallback,
          );
          nodes.push(...childNodes);
        } else {
          debugLog('[FloTrace] Skipping hidden OffscreenComponent subtree');
        }
      } else {
        // For transparent wrappers (host components, fragments, providers, etc.):
        // skip the node itself but walk children — user components may be nested inside.
        // Pass the SAME nameCountMap so promoted children from different wrapper siblings
        // get unique indices (e.g., Row-0, Row-1 instead of both being Row-0).
        // Transparent wrappers don't increment depth (they're not user components)
        const childNodes = walkFiber(
          current.child,
          parentId,
          nameCountMap,
          depth,
          inSuspenseFallback,
        );
        nodes.push(...childNodes);
      }
    } catch (error) {
      console.error('[FloTrace] Error processing fiber node, skipping:', error);
    }

    current = current.sibling;
  }

  return nodes;
}

/**
 * Build a complete LiveTreeNode tree from a FiberRoot.
 * Props are NOT included in the tree — they are fetched on demand via getNodeProps().
 * This keeps tree snapshots small and avoids JSON.stringify overflow on large apps.
 */
function buildTreeFromFiberRoot(root: FiberRoot): LiveTreeNode | null {
  const rootFiber = root.current;
  if (!rootFiber || !rootFiber.child) {
    console.warn('[FloTrace] No root fiber or no child:', {
      hasRoot: !!rootFiber,
      hasChild: !!rootFiber?.child,
    });
    return null;
  }

  // Clear fiber reference map before rebuilding (reuse to reduce GC pressure)
  fiberRefMap.clear();

  const topLevelNodes = walkFiber(rootFiber.child, '');
  debugLog('[FloTrace] walkFiber found', topLevelNodes.length, 'top-level nodes');

  if (topLevelNodes.length === 1) {
    return topLevelNodes[0];
  }

  if (topLevelNodes.length > 0) {
    return {
      id: 'Root',
      name: 'Root',
      children: topLevelNodes,
      fiberTag: FIBER_TAGS.HostRoot,
    };
  }

  return null;
}

// ============================================================================
// DOM-based fiber root discovery (fallback when DevTools hook is unavailable)
// ============================================================================

/**
 * Find the React fiber root by looking at DOM elements.
 * React attaches fibers to DOM nodes as __reactFiber$ (React 18+)
 * or __reactInternalInstance$ (React 16/17) properties.
 */
function findFiberRootFromDOM(): FiberRoot | null {
  try {
    if (typeof document === 'undefined') return null;

    // Common root element selectors
    const selectors = ['#root', '#__next', '#app', '#__nuxt', '[data-reactroot]'];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (!element) continue;

      debugLog(
        `[FloTrace] Trying selector "${selector}" → found element`,
        element.tagName,
        element.id,
      );
      const reactKeys = Object.keys(element).filter(
        (k) => k.startsWith('__react') || k.startsWith('_react'),
      );
      debugLog(`[FloTrace] React keys on element:`, reactKeys);

      const fiberRoot = getFiberRootFromElement(element);
      if (fiberRoot) {
        debugLog('[FloTrace] Found fiber root from selector:', selector);
        return fiberRoot;
      }
    }

    // Fallback: check ALL direct children of <body>
    const allBodyChildren = document.body?.children;
    if (allBodyChildren) {
      debugLog(
        '[FloTrace] Scanning all',
        allBodyChildren.length,
        'body children for React root...',
      );
      for (const child of Array.from(allBodyChildren)) {
        const reactKeys = Object.keys(child).filter(
          (k) => k.startsWith('__react') || k.startsWith('_react'),
        );
        if (reactKeys.length > 0) {
          debugLog(
            '[FloTrace] React keys on',
            child.tagName,
            child.id || '(no id)',
            ':',
            reactKeys,
          );
        }
        const fiberRoot = getFiberRootFromElement(child);
        if (fiberRoot) {
          debugLog(
            '[FloTrace] Found fiber root from body child scan:',
            child.tagName,
            child.id || '(no id)',
          );
          return fiberRoot;
        }
      }
    }

    console.warn('[FloTrace] Could not find React fiber root from any DOM element');
    return null;
  } catch (error) {
    console.error('[FloTrace] Error finding fiber root from DOM:', error);
    return null;
  }
}

/**
 * Get the FiberRoot from a DOM element.
 *
 * React attaches internal properties to DOM elements:
 * - React 18 createRoot: __reactContainer$xxx on the ROOT element (value = HostRoot fiber)
 * - React 18 child elements: __reactFiber$xxx (value = element's fiber)
 * - React 17 ReactDOM.render: _reactRootContainer on the ROOT element
 * - React 16/17 child elements: __reactInternalInstance$xxx
 */
function getFiberRootFromElement(element: Element): FiberRoot | null {
  const keys = Object.keys(element);

  // Strategy 1: React 18 createRoot - root element has __reactContainer$xxx
  // This is the HostRoot fiber directly
  const containerKey = keys.find((k) => k.startsWith('__reactContainer$'));
  if (containerKey) {
    const hostRootFiber = (element as unknown as Record<string, Fiber>)[containerKey];
    if (hostRootFiber?.stateNode) {
      return hostRootFiber.stateNode as FiberRoot;
    }
  }

  // Strategy 2: React 18 child elements or React 16/17 - __reactFiber$ / __reactInternalInstance$
  const fiberKey = keys.find(
    (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
  );
  if (fiberKey) {
    const fiber = (element as unknown as Record<string, Fiber>)[fiberKey];
    if (fiber) {
      // Walk up to find the HostRoot fiber
      let current: Fiber | null = fiber;
      while (current?.return) {
        current = current.return;
      }
      if (current && current.tag === FIBER_TAGS.HostRoot && current.stateNode) {
        return current.stateNode as FiberRoot;
      }
    }
  }

  // Strategy 3: React 17 ReactDOM.render - _reactRootContainer on root element
  const el = element as unknown as {
    _reactRootContainer?: { _internalRoot?: FiberRoot };
  };
  if (el._reactRootContainer?._internalRoot) {
    return el._reactRootContainer._internalRoot;
  }

  return null;
}

// ============================================================================
// Snapshot sending (shared by both strategies)
// ============================================================================

/**
 * Adapt the snapshot interval based on the current tree size.
 * Called after each walk so the next throttle window matches tree complexity.
 */
function adaptSnapshotInterval(nodeCount: number): void {
  if (nodeCount >= 200) {
    snapshotIntervalMs = INTERVAL_MS_LARGE;
  } else if (nodeCount >= 50) {
    snapshotIntervalMs = INTERVAL_MS_MEDIUM;
  } else {
    snapshotIntervalMs = INTERVAL_MS_SMALL;
  }
}

/**
 * Execute the actual tree walk + send logic (extracted for reuse by throttle).
 * Walks the fiber tree from the given root, computes a full snapshot or
 * incremental diff, and sends it over WebSocket.
 *
 * Side effects: updates previousFlatTree, snapshotCounter, diffSeq,
 * snapshotIntervalMs, lastSnapshotSentTime, isWalking, fiberRefMap.
 */
function executeSnapshot(root: FiberRoot): void {
  // Bail BEFORE the O(tree-size) walk when there's no desktop listening. Previously the
  // connected-check ran after buildTreeFromFiberRoot, so an enabled-but-disconnected dev
  // runtime walked the entire fiber tree on every scheduled snapshot for nothing.
  const client = getWebSocketClient();
  if (!client.connected) {
    debugLog('[FloTrace] WebSocket not connected, skipping snapshot walk');
    return;
  }

  if (isWalking) {
    debugLog('[FloTrace] Skipped snapshot: already walking');
    return;
  }
  isWalking = true;

  try {
    const tree = buildTreeFromFiberRoot(root);
    if (!tree) {
      console.warn('[FloTrace] buildTreeFromFiberRoot returned null');
      return;
    }

    // Adapt interval for next snapshot based on current tree size.
    // fiberRefMap is populated during buildTreeFromFiberRoot → walkFiber().
    const nodeCount = fiberRefMap.size;
    adaptSnapshotInterval(nodeCount);

    const currentFlatTree = flattenTree(tree);

    // Full snapshot when: first time, forced reset, or every Nth snapshot to prevent drift
    const sendFull = previousFlatTree === null || snapshotCounter % FULL_SNAPSHOT_INTERVAL === 0;

    if (sendFull) {
      debugLog(
        '[FloTrace] Sending FULL tree snapshot, root:',
        tree.name,
        'nodes:',
        nodeCount,
        'seq:',
        snapshotCounter,
        'nextInterval:',
        snapshotIntervalMs + 'ms',
      );
      logTreeSnapshot(tree, `send seq=${snapshotCounter}`);
      client.sendImmediate({
        type: 'runtime:treeSnapshot',
        tree,
        timestamp: Date.now(),
      });
      lastSnapshotSentTime = Date.now();
      diffSeq = 0;
    } else {
      const diff = computeTreeDiff(previousFlatTree!, currentFlatTree);
      if (diff) {
        debugLog(
          '[FloTrace] Sending tree diff, seq:',
          diffSeq,
          'added:',
          diff.added.length,
          'removed:',
          diff.removed.length,
          'updated:',
          diff.updated.length,
        );
        logTreeSummary(tree, `diff seq=${diffSeq}`);
        client.sendImmediate({
          type: 'runtime:treeDiff',
          seq: diffSeq,
          added: diff.added,
          removed: diff.removed,
          updated: diff.updated,
          timestamp: Date.now(),
        });
        lastSnapshotSentTime = Date.now();
        diffSeq++;
      } else {
        debugLog('[FloTrace] Tree unchanged, skipping diff');
      }
    }

    previousFlatTree = currentFlatTree;
    // Flush any useState/useReducer API correlations detected during this walk
    if (pendingLocalStateCorrelations.length > 0) {
      const now = Date.now();
      const toSend = pendingLocalStateCorrelations.splice(0);
      for (const corr of toSend) {
        try {
          client.sendImmediate({
            type: 'runtime:localStateCorrelation',
            requestId: corr.requestId,
            componentName: corr.componentName,
            hookIndex: corr.hookIndex,
            timestamp: now,
          });
        } catch {
          /* best-effort */
        }
      }
    }

    // Schedule prop drilling analysis — debounced to 2s, runs in background after each snapshot
    schedulePropDrillingAnalysis(tree, fiberRefMap, client);
    // Scan for useActionState / useOptimistic changes — best-effort, non-blocking
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    scanActionStateChanges(fiberRefMap as Map<string, any>, client);
    // Emit Next.js context once on first snapshot if Next.js is detected
    maybeEmitNextjsContext(client);
    snapshotCounter++;
  } catch (error) {
    console.error('[FloTrace] Error walking fiber tree:', error);
  } finally {
    isWalking = false;
  }
}

/**
 * Schedule a tree snapshot with adaptive throttle based on tree size.
 *
 * Small trees (< 50 nodes) → 200ms interval (5 snapshots/sec)
 * Medium trees (50-200 nodes) → 500ms interval (2 snapshots/sec)
 * Large trees (200+ nodes) → 1000ms interval (1 snapshot/sec)
 *
 * Uses throttle-with-trailing + maxWait guarantee:
 * - Trailing: waits for silence (like debounce) to batch rapid commits
 * - MaxWait: guarantees a snapshot fires within 2× the interval, even during
 *   continuous rapid commits (e.g., Next.js hydration, Suspense streaming).
 *   This prevents the "stuck on skeleton" bug where trailing-only debounce
 *   starves snapshots because each new commit keeps resetting the timer.
 */
function scheduleSnapshot(root: FiberRoot): void {
  cachedFiberRoot = root;

  // Reset trailing timer on each call (standard debounce behavior)
  if (throttleTimer) {
    clearTimeout(throttleTimer);
  }

  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
    executeSnapshot(cachedFiberRoot!);
  }, snapshotIntervalMs);

  // MaxWait guarantee: if no trailing timer has fired within 2× interval,
  // force-fire to prevent starvation during rapid commits.
  // Uses cachedFiberRoot (not closure root) to always walk the latest tree.
  if (!maxWaitTimer) {
    maxWaitTimer = setTimeout(() => {
      maxWaitTimer = null;
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      debugLog('[FloTrace] MaxWait forced snapshot (rapid commits detected)');
      if (cachedFiberRoot) {
        executeSnapshot(cachedFiberRoot);
      }
    }, snapshotIntervalMs * 2);
  }
}

// ============================================================================
// Incremental Tree Diffs
// ============================================================================

// Previous tree flattened into a Map<nodeId, node> for O(1) diff lookups.
// null = no previous tree → next snapshot must be a full one.
let previousFlatTree: Map<string, LiveTreeNode> | null = null;

// Monotonic sequence number for diffs — extension detects gaps to request resync
let diffSeq = 0;

// Counter for periodic full snapshots to prevent drift from accumulated diffs
let snapshotCounter = 0;
const FULL_SNAPSHOT_INTERVAL = 10; // Send full snapshot every 10th to resync

/**
 * Flatten a tree into a Map<id, node> for O(1) lookups during diff computation.
 * Does NOT include children in the map values (the map is keyed by node.id only).
 */
function flattenTree(
  root: LiveTreeNode,
  out: Map<string, LiveTreeNode> = new Map(),
): Map<string, LiveTreeNode> {
  out.set(root.id, root);
  for (const child of root.children) {
    flattenTree(child, out);
  }
  return out;
}

/**
 * Derive the parent ID from a node's path-based ID.
 * E.g., "App-0/Dashboard-0/Card-2" → "App-0/Dashboard-0"
 * Returns empty string for root nodes (no "/" in ID).
 */
function getParentId(nodeId: string): string {
  const lastSlash = nodeId.lastIndexOf('/');
  return lastSlash === -1 ? '' : nodeId.substring(0, lastSlash);
}

/**
 * Compute an incremental diff between the previous and current tree snapshots.
 *
 * - **added**: nodes present in `curr` but not in `prev` (new components mounted)
 * - **removed**: node IDs present in `prev` but not in `curr` (components unmounted)
 * - **updated**: nodes in both where renderDuration, renderPhase, or renderReason changed
 *
 * Returns null if the diff is empty (nothing changed) — caller should skip sending.
 */
function computeTreeDiff(
  prev: Map<string, LiveTreeNode>,
  curr: Map<string, LiveTreeNode>,
): RuntimeTreeDiffMessage['added'] extends Array<infer _>
  ? {
      added: Array<LiveTreeNode & { parentId: string }>;
      removed: string[];
      updated: RuntimeTreeDiffMessage['updated'];
    } | null
  : never {
  const added: Array<LiveTreeNode & { parentId: string }> = [];
  const removed: string[] = [];
  const updated: RuntimeTreeDiffMessage['updated'] = [];

  // Detect added + updated nodes
  for (const [id, currNode] of curr) {
    const prevNode = prev.get(id);
    if (!prevNode) {
      // New node — include full data + parentId for insertion
      added.push({ ...currNode, children: [], parentId: getParentId(id) });
    } else {
      // Existing node — check if mutable fields changed
      if (
        prevNode.renderDuration !== currNode.renderDuration ||
        prevNode.renderPhase !== currNode.renderPhase ||
        prevNode.renderReason !== currNode.renderReason
      ) {
        updated.push({
          id,
          renderDuration: currNode.renderDuration,
          renderPhase: currNode.renderPhase,
          renderReason: currNode.renderReason,
        });
      }
    }
  }

  // Detect removed nodes
  for (const id of prev.keys()) {
    if (!curr.has(id)) {
      removed.push(id);
    }
  }

  // Return null if nothing changed — no need to send an empty diff
  if (added.length === 0 && removed.length === 0 && updated.length === 0) {
    return null;
  }

  return { added, removed, updated };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Request a tree snapshot using the DOM fallback approach.
 * Called from FloTraceProvider's Profiler onRender callback after each React commit.
 * This is the primary way to trigger tree walks when DevTools hook isn't available.
 *
 * When the DevTools hook strategy is active, this acts as a safety net:
 * if no snapshot has been sent via onCommitFiberRoot within DEVTOOLS_STALE_THRESHOLD_MS,
 * we fall back to DOM-based snapshots. This handles React 19 compatibility issues
 * where onCommitFiberRoot may not fire reliably for all commits.
 */
export function requestTreeSnapshot(): void {
  if (!isInstalled) {
    return;
  }

  // If using DevTools hook strategy AND it's been sending snapshots recently, skip.
  // Otherwise fall through to DOM fallback (React 19 compat safety net).
  if (activeStrategy === 'devtools') {
    const elapsed = Date.now() - lastSnapshotSentTime;
    if (elapsed < DEVTOOLS_STALE_THRESHOLD_MS) return;
    debugLog('[FloTrace] DevTools hook stale (' + elapsed + 'ms), falling back to DOM snapshot');
  }

  // DOM fallback: find the fiber root from DOM elements
  const root = findFiberRootFromDOM();
  if (root) {
    scheduleSnapshot(root);
  }
}

/**
 * Force the next snapshot to be a full tree (not a diff).
 * Called when the extension detects a sequence gap or on explicit refresh.
 * Resets diff state so the next scheduleSnapshot sends runtime:treeSnapshot.
 */
export function requestFullSnapshot(): void {
  previousFlatTree = null;
  snapshotCounter = 0;
  diffSeq = 0;
  // Actively trigger a snapshot using cached root (don't wait for next commit)
  if (cachedFiberRoot) {
    scheduleSnapshot(cachedFiberRoot);
  }
}

/**
 * Install the fiber tree walker.
 *
 * Strategy 1 (preferred): Hook into __REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot
 * Strategy 2 (fallback): DOM-based fiber access, triggered by requestTreeSnapshot()
 *
 * Tree snapshots are always sent WITHOUT props (structure only).
 * Props are fetched on demand via getNodeProps() when the user selects a node.
 *
 * @returns Cleanup function to uninstall
 */
export function installFiberTreeWalker(options: FiberTreeWalkerOptions = {}): () => void {
  if (isInstalled) {
    console.warn('[FloTrace] Fiber tree walker already installed');
    return () => uninstallFiberTreeWalker();
  }

  if (typeof window === 'undefined') {
    console.warn('[FloTrace] Not in browser environment, cannot install fiber tree walker');
    return () => {
      /* no-op uninstall: walker was never installed in this environment */
    };
  }

  walkerOptions = options;
  isInstalled = true;

  // Merge built-in framework detection with platform-supplied extras.
  walkerFilterConfig = {
    frameworkNames: options.frameworkComponentNames?.length
      ? new Set<string>([...FRAMEWORK_COMPONENT_NAMES, ...options.frameworkComponentNames])
      : FRAMEWORK_COMPONENT_NAMES,
    frameworkNamePatterns: options.frameworkComponentNamePatterns ?? [],
    frameworkPathPatterns: options.frameworkPathPatterns?.length
      ? [...FRAMEWORK_PATH_PATTERNS, ...options.frameworkPathPatterns]
      : FRAMEWORK_PATH_PATTERNS,
    hostSkipPrefixes: options.hostComponentSkipPrefixes ?? [],
    userOnlyStrict: options.userOnlyStrict === true,
    userAllowPatterns: options.userAllowPatterns ?? [],
  };

  // Install RSC payload interceptor for Next.js App Router detection (best-effort)
  try {
    const client = getWebSocketClient();
    installRscPayloadInterceptor(client);
  } catch {
    // Non-fatal
  }

  // Strategy 1: Try DevTools hook
  const hook = (globalThis as DevToolsHookGlobal).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (hook && typeof hook.onCommitFiberRoot === 'function') {
    originalOnCommitFiberRoot = hook.onCommitFiberRoot;

    hook.onCommitFiberRoot = (rendererID: number, root: FiberRoot, priority?: number) => {
      // Call original handler first (React DevTools)
      if (originalOnCommitFiberRoot) {
        try {
          originalOnCommitFiberRoot(rendererID, root, priority);
        } catch (error) {
          console.error('[FloTrace] Error in original onCommitFiberRoot:', error);
        }
      }

      if (hookedRendererID === null) {
        hookedRendererID = rendererID;
      }

      // Only track the first renderer
      if (rendererID !== hookedRendererID) return;

      // --- Render Cascade & Call Stack Tracing ---
      // Run synchronously at commit time (before debounce) so we have fiber.alternate
      // available for cascade classification and accurate trigger correlation.
      try {
        const client = getWebSocketClient();
        if (client.connected) {
          const triggers = peekTriggers();

          // Emit each pending trigger record first
          for (const trigger of triggers) {
            client.sendImmediate({ type: 'runtime:renderTrigger', trigger });
          }

          // Analyze cascade and emit if non-trivial
          const cascade = analyzeCascade(root, triggers);
          if (cascade) {
            client.sendImmediate({ type: 'runtime:renderCascade', cascade });
          }

          // Re-wrap dispatchers for the next render cycle (React creates new
          // dispatch functions after each commit for function components)
          wrapFiberDispatchers(root);

          // Clear triggers — they've been attributed to this commit
          clearTriggers();
        }
      } catch {
        // Never let cascade analysis break the fiber tree walker
      }

      scheduleSnapshot(root);
    };

    activeStrategy = 'devtools';
    console.log('[FloTrace] Fiber tree walker installed (DevTools hook strategy)');

    // Send an initial snapshot via DOM fallback (don't wait for next React commit)
    setTimeout(() => {
      try {
        const root = findFiberRootFromDOM();
        if (root) {
          scheduleSnapshot(root);
        }
      } catch (error) {
        console.error('[FloTrace] Error sending initial DevTools snapshot:', error);
      }
    }, 100);
  } else {
    // Strategy 2: DOM fallback - snapshots are triggered by requestTreeSnapshot()
    activeStrategy = 'dom';
    console.log('[FloTrace] Fiber tree walker installed (DOM fallback strategy)');

    // Send an initial snapshot immediately by finding the fiber root from DOM
    setTimeout(() => {
      try {
        const root = findFiberRootFromDOM();
        if (root) {
          scheduleSnapshot(root);
        }
      } catch (error) {
        console.error('[FloTrace] Error sending initial DOM fallback snapshot:', error);
      }
    }, 100);
  }

  return () => uninstallFiberTreeWalker();
}

/**
 * Get serialized props for a specific node by ID.
 * Looks up the fiber reference cached during the last tree walk and serializes
 * its current memoizedProps. Returns null if the node is not found (e.g., unmounted).
 */
export function getNodeProps(nodeId: string): Record<string, SerializedValue> | null {
  const fiber = fiberRefMap.get(nodeId);
  if (!fiber || !fiber.memoizedProps) {
    return null;
  }
  try {
    return serializeProps(fiber.memoizedProps);
  } catch (error) {
    console.error(`[FloTrace] Error serializing props for node "${nodeId}":`, error);
    return null;
  }
}

// ============================================================================
// Console-Free Debugging: Enhanced Render Reason, Hook/Effect Inspection
// ============================================================================

/**
 * Enhanced render reason with specific prop/state/context changes.
 * Called on-demand (not during tree walk) to avoid performance overhead.
 */
export function detectDetailedRenderReason(fiber: Fiber): DetailedRenderReason {
  if (!fiber.alternate) return { type: 'mount' };

  const prev = fiber.alternate;

  // 1. Check props changes with prev/next values
  if (shallowPropsChanged(prev.memoizedProps, fiber.memoizedProps)) {
    const changedProps = diffProps(prev.memoizedProps, fiber.memoizedProps);
    return { type: 'props-changed', changedProps };
  }

  // 2. Check state hooks by walking memoizedState linked list
  const changedHookIndices = diffHookStates(prev.memoizedState, fiber.memoizedState);
  if (changedHookIndices.length > 0) {
    return { type: 'state-changed', changedHookIndices };
  }

  // 3. Check context dependencies
  const changedContexts = detectContextChanges(fiber);
  if (changedContexts.length > 0) {
    return { type: 'context-changed', contextNames: changedContexts };
  }

  // 4. Parent render fallback
  const parentName = fiber.return ? getComponentName(fiber.return) : undefined;
  return { type: 'parent-render', parentName };
}

/**
 * Diff two props objects and return the specific keys that changed with values.
 */
function diffProps(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown> | null,
): PropChange[] {
  const changes: PropChange[] = [];
  if (!prev || !next) return changes;

  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    if (key === 'children' || key === FLOTRACE_SRC_ATTR) continue;
    if (!Object.is(prev[key], next[key])) {
      changes.push({
        key,
        prev: serializeValue(prev[key], 0, new WeakSet()),
        next: serializeValue(next[key], 0, new WeakSet()),
      });
    }
  }
  return changes;
}

/**
 * Walk two memoizedState linked lists in parallel, comparing by reference.
 * Returns indices of hooks whose memoizedState changed.
 */
function diffHookStates(prev: FiberHookState | null, next: FiberHookState | null): number[] {
  const changed: number[] = [];
  let prevHook = prev;
  let nextHook = next;
  let index = 0;

  while (prevHook && nextHook) {
    // Only compare hooks that have a queue (state hooks: useState, useReducer)
    // Skip effect/memo/ref hooks since their memoizedState changes don't mean "state update"
    if (prevHook.queue !== null || nextHook.queue !== null) {
      if (!Object.is(prevHook.memoizedState, nextHook.memoizedState)) {
        changed.push(index);
      }
    }
    prevHook = prevHook.next;
    nextHook = nextHook.next;
    index++;
  }

  return changed;
}

/**
 * Detect context changes by examining fiber.dependencies.
 * React 18+ stores context dependencies as a linked list.
 */
function detectContextChanges(fiber: Fiber): string[] {
  const changed: string[] = [];
  if (!fiber.dependencies?.firstContext) return changed;

  let ctx: FiberContextDependency | null = fiber.dependencies.firstContext;
  while (ctx) {
    try {
      // Compare memoized value (from last render) with current context value
      if (!Object.is(ctx.memoizedValue, ctx.context._currentValue)) {
        const name = ctx.context.displayName || 'UnknownContext';
        changed.push(name);
      }
    } catch {
      // Skip if context access fails
    }
    ctx = ctx.next;
  }

  return changed;
}

/**
 * Get detailed render reason for a specific node by ID.
 * Uses fiberRefMap to look up the cached fiber reference.
 */
export function getDetailedRenderReason(nodeId: string): DetailedRenderReason | null {
  const fiber = fiberRefMap.get(nodeId);
  if (!fiber) return null;
  try {
    return detectDetailedRenderReason(fiber);
  } catch (error) {
    console.error(`[FloTrace] Error detecting render reason for "${nodeId}":`, error);
    return null;
  }
}

/**
 * Get all hooks for a specific node by ID.
 * Returns null if the node is not found (e.g., unmounted).
 */
export function getNodeHooks(nodeId: string): HookInfo[] | null {
  const fiber = fiberRefMap.get(nodeId);
  if (!fiber) return null;
  try {
    return inspectHooks(fiber);
  } catch (error) {
    console.error(`[FloTrace] Error inspecting hooks for node "${nodeId}":`, error);
    return null;
  }
}

/**
 * Get all effects for a specific node by ID.
 * Returns null if the node is not found (e.g., unmounted).
 */
export function getNodeEffects(nodeId: string): EffectInfo[] | null {
  const fiber = fiberRefMap.get(nodeId);
  if (!fiber) return null;
  try {
    return inspectEffects(fiber);
  } catch (error) {
    console.error(`[FloTrace] Error inspecting effects for node "${nodeId}":`, error);
    return null;
  }
}

/**
 * Get the fiberRefMap for external use (e.g., console tracker fiber attribution).
 */
export function getFiberRefMap(): Map<string, Fiber> {
  return fiberRefMap;
}

/**
 * Uninstall the fiber tree walker, restoring the original hook.
 */
export function uninstallFiberTreeWalker(): void {
  if (!isInstalled) return;

  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  if (maxWaitTimer) {
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }
  cachedFiberRoot = null;

  // Restore DevTools hook if we wrapped it
  if (activeStrategy === 'devtools') {
    const hook = (globalThis as DevToolsHookGlobal).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook) {
      if (originalOnCommitFiberRoot) {
        hook.onCommitFiberRoot = originalOnCommitFiberRoot;
      } else {
        delete hook.onCommitFiberRoot;
      }
    }
  }

  originalOnCommitFiberRoot = null;
  hookedRendererID = null;
  activeStrategy = null;
  fiberRefMap = new Map();
  previousFlatTree = null;
  snapshotCounter = 0;
  diffSeq = 0;
  lastSnapshotSentTime = 0;
  isInstalled = false;
  walkerOptions = {};
  walkerFilterConfig = defaultFilterConfig();
  try {
    uninstallRscPayloadInterceptor();
  } catch {
    /* non-fatal */
  }
  clearActionStateCache();
  resetNextjsDetection();
  console.log('[FloTrace] Fiber tree walker uninstalled');
}
