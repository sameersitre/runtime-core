/**
 * Types for @flotrace/runtime package
 * These mirror the shared types from the extension but are standalone
 * to avoid importing from the extension package.
 */

// Re-exported from jsxRuntimeUtils so consumers can find LiveTreeNode +
// FlotraceJsxSource in one place; runtime-core's barrel re-exports both.
export type { FlotraceJsxSource } from './jsxRuntimeUtils';
import type { FlotraceJsxSource } from './jsxRuntimeUtils';

/**
 * Confidence tier for `LiveTreeNode` source attribution. Drives the
 * OriginBadge variant in the renderer:
 *
 *   - `'exact'`     — JSX-runtime symbol present OR `_debugSource.fileName`
 *                     populated (Babel JSX plugin / React 17–18 dev).
 *   - `'inferred'`  — path resolved via the owner-chain walk or
 *                     `_debugStack.stack` first-non-react frame (R19+).
 *   - `'package'`   — fiber classified as framework/library; user clicks won't
 *                     land in user code anyway.
 *   - `'unknown'`   — no signal at any tier. Renders an amber `?` pill so the
 *                     UI is honest about what it doesn't know.
 */
export type SourceConfidence = 'exact' | 'inferred' | 'package' | 'unknown';

/**
 * Serialized value for safe transmission over WebSocket
 */
export type SerializedValue =
  | null
  | boolean
  | number
  | string
  | SerializedValue[]
  | { [key: string]: SerializedValue }
  | { __type: 'function'; name?: string }
  | { __type: 'undefined' }
  | { __type: 'symbol'; description?: string }
  | { __type: 'circular' }
  | { __type: 'truncated'; originalType: string; length?: number };

/**
 * Messages sent from runtime to extension
 */
export type RuntimeMessage =
  | RuntimeReadyMessage
  | RuntimeRenderMessage
  | RuntimePropsUpdateMessage
  | RuntimeNodePropsMessage
  | RuntimeZustandUpdateMessage
  | RuntimeReduxUpdateMessage
  | RuntimeRouterUpdateMessage
  | RuntimeContextUpdateMessage
  | RuntimeDisconnectMessage
  | RuntimeTreeSnapshotMessage
  | RuntimeTreeDiffMessage
  | RuntimeNodeHooksMessage
  | RuntimeNodeEffectsMessage
  | RuntimeDetailedRenderReasonMessage
  | RuntimeTimelineEventMessage
  | RuntimeTanStackQueryUpdateMessage
  | RuntimeRenderTriggerMessage
  | RuntimeRenderCascadeMessage
  | RuntimePropDrillingMessage
  // React 19+ & Next.js SSR features
  | RuntimeActionStateMessage
  | RuntimeOptimisticDiffMessage
  | RuntimeNextjsContextMessage
  | RuntimeRscPayloadMessage
  | RuntimeHydrationEventMessage
  // JSX runtime (Milestone 8 Phase 4)
  | RuntimeCallSiteMetricsMessage
  | RuntimeDuplicateKeyMessage
  | RuntimeNetworkRequestMessage
  | RuntimeLocalStateCorrelationMessage
  | RuntimeValueTraceMessage
  | RuntimePongMessage;

export interface RuntimeReadyMessage {
  type: 'runtime:ready';
  appName?: string;
  reactVersion?: string;
  appUrl?: string;
  /** 'web' | 'ios' | 'android'. Populated by the adapter. Desktop uses it for badges
   *  and to disambiguate multi-app sessions (one iOS + one Android from the same monorepo). */
  platform?: 'web' | 'ios' | 'android';
  /** Stable app identifier. Pairs with platform to disambiguate simultaneous clients. */
  appId?: string;
  /** App version — shown in the desktop connection panel for diagnostic purposes. */
  appVersion?: string;
  /** Auto-detected framework family. Adapters populate this from runtime probes
   *  (DOM signals on web, optional-require on native). */
  frameworkName?: 'next' | 'expo' | 'rn-cli' | 'plain-react';
  /** Framework version when the adapter can resolve it (e.g. Next.js via
   *  `require('next/package.json').version`). Missing when unavailable. */
  frameworkVersion?: string;
  /** React Native version from `Platform.constants.reactNativeVersion`, formatted
   *  as "major.minor.patch". Native-only; web adapter leaves this undefined. */
  reactNativeVersion?: string;
  /** Version of the @flotrace/runtime or @flotrace/runtime-native package the
   *  user installed in their app. Lets the desktop diagnose runtime/desktop
   *  drift (e.g., user pinned an older runtime that lacks a new feature).
   *  Read from the adapter's own package.json at build time. The lockstep
   *  release script keeps runtime-core pinned identically, so a separate
   *  core-version field would be redundant. */
  runtimeVersion?: string;
  /**
   * Milestone 8 Phase 5 — adoption signal for the JSX-runtime opt-in
   * (`"jsxImportSource": "@flotrace/runtime-core"`). `true` when the dev
   * runtime's global sentinel has been set (i.e. at least one user
   * component went through `jsxDEV`). Desktop forwards to telemetry so
   * the admin dashboard can track rollout rate. No PII; one-time boolean.
   */
  jsxRuntimeActive?: boolean;
}

export interface RuntimeRenderMessage {
  type: 'runtime:render';
  componentName: string;
  filePath?: string;
  phase: 'mount' | 'update';
  actualDuration: number;
  baseDuration: number;
  timestamp: number;
  instanceId?: string;
}

export interface RuntimePropsUpdateMessage {
  type: 'runtime:props';
  componentName: string;
  instanceId?: string;
  props: Record<string, SerializedValue>;
  changedKeys?: string[];
  timestamp: number;
}

export interface RuntimeNodePropsMessage {
  type: 'runtime:nodeProps';
  /** Path-based node ID (e.g., "App-0/Dashboard-0/Card-2") */
  nodeId: string;
  /** Serialized props from fiber.memoizedProps */
  props: Record<string, SerializedValue>;
  timestamp: number;
}

export interface RuntimeZustandUpdateMessage {
  type: 'runtime:zustand';
  storeName: string;
  state: Record<string, SerializedValue>;
  changedKeys: string[];
  /** Per-request causal correlation: each entry maps a requestId to the specific store keys
   *  whose values came from that fetch response (WeakMap causal correlation). */
  correlatedRequests?: Array<{ requestId: string; storeKeys: string[] }>;
  timestamp: number;
}

export interface RuntimeReduxUpdateMessage {
  type: 'runtime:redux';
  /** Current state snapshot */
  state: Record<string, SerializedValue>;
  /** Keys that changed */
  changedKeys: string[];
  /** Per-request causal correlation: each entry maps a requestId to the specific store keys
   *  whose values came from that fetch response (WeakMap causal correlation). */
  correlatedRequests?: Array<{ requestId: string; storeKeys: string[] }>;
  timestamp: number;
}

export interface RuntimeRouterUpdateMessage {
  type: 'runtime:router';
  pathname: string;
  params: Record<string, string>;
  searchParams: Record<string, string>;
  timestamp: number;
}

export interface RuntimeContextUpdateMessage {
  type: 'runtime:context';
  contextName: string;
  value: SerializedValue;
  consumers?: string[];
  timestamp: number;
}

export interface RuntimeDisconnectMessage {
  type: 'runtime:disconnect';
  reason?: string;
}

/**
 * Heartbeat response. The desktop pings every few seconds; the runtime replies
 * with a pong so the server can detect native-crash scenarios where the JS
 * thread is frozen but the socket is still technically open.
 */
export interface RuntimePongMessage {
  type: 'runtime:pong';
  timestamp: number;
}

export interface RuntimeTreeSnapshotMessage {
  type: 'runtime:treeSnapshot';
  /** Full component tree from fiber traversal */
  tree: LiveTreeNode;
  /** Timestamp when snapshot was taken */
  timestamp: number;
}

/**
 * Incremental tree diff — sent instead of a full snapshot when the tree
 * structure hasn't changed dramatically. Reduces WebSocket payload by ~80-95%
 * compared to sending the full tree every time.
 *
 * The extension reconstructs the full tree by applying diffs to its cached copy.
 * A full snapshot is sent every FULL_SNAPSHOT_INTERVAL (10) diffs to prevent drift,
 * and whenever the extension detects a sequence gap.
 */
export interface RuntimeTreeDiffMessage {
  type: 'runtime:treeDiff';
  /** Monotonic sequence number — extension uses this to detect missed diffs */
  seq: number;
  /** Nodes added since last snapshot (includes parentId for tree insertion) */
  added: Array<LiveTreeNode & { parentId: string }>;
  /** Node IDs removed since last snapshot */
  removed: string[];
  /** Nodes whose mutable fields changed (renderDuration, renderPhase, renderReason) */
  updated: Array<{
    id: string;
    renderDuration?: number;
    renderPhase?: 'mount' | 'update';
    renderReason?: 'mount' | 'props-changed' | 'state-or-context' | 'parent';
  }>;
  timestamp: number;
}

// ============================================================================
// Live Tree Types
// ============================================================================

/**
 * React Compiler memoization status for a component.
 * Detected by checking for the React Compiler memo cache sentinel in fiber state.
 * Mirrors the CompilerStatus type in src/shared/liveMessages.ts.
 */
export type CompilerStatus = 'compiled' | 'manual' | 'unoptimized' | 'de-opted';

/**
 * A node in the live component tree captured from React fiber tree.
 * Path-based IDs ensure stability across snapshots for React Flow animations.
 */
export interface LiveTreeNode {
  /** Path-based ID: "App-0/Dashboard-0/Card-2" (component name + child index among same-type siblings) */
  id: string;
  /** Component display name */
  name: string;
  /** Child components (host elements like div/span are filtered out) */
  children: LiveTreeNode[];
  /** Serialized props (functions filtered, values truncated) */
  props?: Record<string, SerializedValue>;
  /** Fiber tag: 0=Function, 1=Class, 11=ForwardRef, 14=Memo, 15=SimpleMemo */
  fiberTag: number;
  /** Mount on first render, update on re-render */
  renderPhase?: 'mount' | 'update';
  /** Render duration in ms (from Profiler) */
  renderDuration?: number;
  /** Source file path from _debugSource (dev mode only) */
  filePath?: string;
  /** Source line number from _debugSource (dev mode only) */
  lineNumber?: number;
  /** Why this component rendered (detected via fiber.alternate props comparison) */
  renderReason?: 'mount' | 'props-changed' | 'state-or-context' | 'parent';
  /** True if this component is a framework/library wrapper (Next.js, React Router, etc.) */
  isFramework?: boolean;
  /** React key prop (only string keys, used to differentiate same-name siblings in search) */
  reactKey?: string;
  /** TanStack Query hashes observed by this component (detected from useRef → QueryObserver) */
  queryHashes?: string[];
  /** Number of hooks in this component (counted from memoizedState linked list) */
  hookCount?: number;
  /** True if any hook is useContext (indicates data may come from context, not just props) */
  hasContextHook?: boolean;
  // --- Feature C: Concurrent Updates ---
  /** True if a useTransition hook on this component currently has isPending=true */
  isTransitionPending?: boolean;
  /** True if this component is currently rendering inside a Suspense fallback branch */
  isSuspenseFallback?: boolean;
  // --- Feature D: React Compiler ---
  /** React Compiler memoization status (undefined = not analyzed / compiler not detected) */
  compilerStatus?: CompilerStatus;
  // --- Feature E: Next.js App Router ---
  /** True if this is detected as a Next.js Server Component (heuristic) */
  isServerComponent?: boolean;
  /** True if this is the first client component below a server component boundary */
  isClientBoundary?: boolean;
  // --- Library detection ---
  /** True if this component is from a third-party library, not user-defined code */
  isLibrary?: boolean;
  /** Short display label for the library source (e.g. 'framer', 'fontawesome', 'sonner') */
  libraryName?: string;
  // --- Feature: JSX runtime source attribution (Milestone 8) ---
  /**
   * Source attribution captured at JSX-creation time by the optional
   * `@flotrace/runtime-core/jsx-dev-runtime` opt-in. Present only when the
   * user has set `"jsxImportSource": "@flotrace/runtime-core"` in their
   * tsconfig.json — the highest-confidence source signal available.
   *
   * When present, `filePath` / `lineNumber` are filled from `jsxSource` so
   * existing consumers (click-to-IDE, breadcrumb path display) keep working
   * without changes.
   */
  jsxSource?: FlotraceJsxSource;
  /**
   * Confidence tier of the resolved source. See `SourceConfidence` doc-comment
   * for the four tiers and what each means for the UI.
   */
  sourceConfidence?: SourceConfidence;
}

// ============================================================================
// Console-Free Debugging Types
// ============================================================================

/**
 * Enhanced render reason with specific prop/state/context changes.
 */
export type DetailedRenderReasonType =
  | 'mount'
  | 'props-changed'
  | 'state-changed'
  | 'context-changed'
  | 'parent-render'
  | 'force-update';

export interface PropChange {
  key: string;
  prev: SerializedValue;
  next: SerializedValue;
}

export type DetailedRenderReason =
  | { type: 'mount' }
  | { type: 'props-changed'; changedProps: PropChange[] }
  | { type: 'state-changed'; changedHookIndices: number[] }
  | { type: 'context-changed'; contextNames: string[] }
  | { type: 'parent-render'; parentName?: string }
  | { type: 'force-update' };

/**
 * Hook type classification — inferred from fiber.memoizedState shape.
 */
export type HookType =
  | 'useState'
  | 'useReducer'
  | 'useRef'
  | 'useMemo'
  | 'useCallback'
  | 'useEffect'
  | 'useLayoutEffect'
  | 'useInsertionEffect'
  | 'useContext'
  | 'useImperativeHandle'
  | 'useDebugValue'
  | 'useTransition'
  | 'useDeferredValue'
  | 'useId'
  | 'useSyncExternalStore'
  | 'useOptimistic'
  | 'useFormStatus'
  | 'unknown';

/**
 * Information about a single hook in a component's hook linked list.
 */
export interface HookInfo {
  /** Position in the hook linked list (0-based) */
  index: number;
  /** Classified hook type */
  type: HookType;
  /** Serialized current value (state for useState, ref.current for useRef, etc.) */
  value: SerializedValue;
  /** For useMemo/useCallback/useEffect: serialized dependency array */
  deps?: SerializedValue[];
  /** Hook name hint from _debugHookTypes if available */
  debugLabel?: string;
}

/**
 * Information about a single effect (useEffect/useLayoutEffect/useInsertionEffect).
 */
export interface EffectInfo {
  /** Position in the effect circular list (0-based) */
  index: number;
  /** Corresponding hook index in the memoizedState list */
  hookIndex: number;
  /** Effect type derived from tag bitmask */
  type: 'useEffect' | 'useLayoutEffect' | 'useInsertionEffect';
  /** Current dependency array (null = no deps, runs every render) */
  deps: SerializedValue[] | null;
  /** Previous dependency array from fiber.alternate */
  prevDeps: SerializedValue[] | null;
  /** Indices of deps that changed (triggering this effect to run) */
  changedDepIndices: number[];
  /** Whether this effect will execute on this render */
  willRun: boolean;
  /** Whether the previous effect returned a cleanup function */
  hasCleanup: boolean;
}

/**
 * Component lifecycle event types for the timeline.
 */
export type TimelineEventType =
  | 'mount'
  | 'unmount'
  | 'render'
  | 'effect-run'
  | 'effect-cleanup'
  | 'state-update'
  | 'props-change';

/**
 * A single event in a component's lifecycle timeline.
 */
export interface TimelineEvent {
  type: TimelineEventType;
  timestamp: number;
  /** Render duration in ms (for render events) */
  duration?: number;
  /** Additional context (e.g., which hook, which prop) */
  detail?: SerializedValue;
}

// ============================================================================
// New Runtime Messages (Console-Free Debugging)
// ============================================================================

export interface RuntimeNodeHooksMessage {
  type: 'runtime:nodeHooks';
  nodeId: string;
  hooks: HookInfo[];
  timestamp: number;
}

export interface RuntimeNodeEffectsMessage {
  type: 'runtime:nodeEffects';
  nodeId: string;
  effects: EffectInfo[];
  timestamp: number;
}

export interface RuntimeDetailedRenderReasonMessage {
  type: 'runtime:detailedRenderReason';
  nodeId: string;
  reason: DetailedRenderReason;
  timestamp: number;
}

export interface RuntimeTimelineEventMessage {
  type: 'runtime:timelineEvent';
  nodeId: string;
  componentName: string;
  event: TimelineEvent;
}

// ============================================================================
// TanStack Query Types
// ============================================================================

/** Serialized query info sent over WebSocket */
export interface TanStackQueryInfo {
  queryKey: SerializedValue;
  queryHash: string;
  status: 'pending' | 'error' | 'success';
  fetchStatus: 'idle' | 'fetching' | 'paused';
  dataUpdatedAt: number;
  errorUpdatedAt: number;
  isInvalidated: boolean;
  isStale: boolean;
  isActive: boolean;
  isDisabled: boolean;
  failureCount: number;
  errorMessage?: string;
  observerCount: number;
  /** Config values */
  staleTime?: number;
  gcTime?: number;
  /** Additional config for health analysis */
  refetchInterval?: number | false;
  refetchOnWindowFocus?: boolean | 'always';
  refetchOnMount?: boolean | 'always';
  refetchOnReconnect?: boolean | 'always';
  networkMode?: string;
  enabled?: boolean;
  retry?: number | boolean;
  /** Data shape descriptor (key names + types, no values) */
  dataShape?: SerializedValue;
  /** Number of times query refetched but data was identical */
  wastedRefetchCount?: number;
  /** Total number of fetches tracked */
  totalFetchCount?: number;
  /** Per-query state transition history (ring buffer, max 50) */
  events?: TanStackQueryEvent[];
  /** requestId of the API call whose response was stored in this query's cache (WeakMap causal) */
  correlatedRequestId?: string;
}

/** A state transition event for a TanStack Query */
export interface TanStackQueryEvent {
  timestamp: number;
  /** Status before the transition */
  fromStatus: string;
  /** Status after the transition */
  toStatus: string;
  /** Fetch status before the transition */
  fromFetchStatus: string;
  /** Fetch status after the transition */
  toFetchStatus: string;
  /** Whether the data changed during this transition */
  dataChanged: boolean;
}

/** Serialized mutation info sent over WebSocket */
export interface TanStackMutationInfo {
  mutationId: number;
  status: 'idle' | 'pending' | 'error' | 'success';
  isPaused: boolean;
  submittedAt: number;
  failureCount: number;
  errorMessage?: string;
  mutationKey?: SerializedValue;
  scope?: string;
  /** Correlation ID linking this mutation to queries it triggered */
  lastCorrelationId?: string;
}

/** Mutation → query invalidation → refetch correlation event */
export interface MutationCorrelation {
  /** Unique ID for this correlation event */
  correlationId: string;
  /** The mutation that triggered the cascade */
  mutationId: number;
  /** Mutation key (if provided) for display */
  mutationKey?: SerializedValue;
  /** Timestamp when mutation completed (status → 'success') */
  mutationCompletedAt: number;
  /** Queries that started fetching within the correlation window */
  affectedQueries: Array<{
    queryHash: string;
    queryKey: SerializedValue;
    /** When the query started fetching */
    fetchStartedAt: number;
    /** Latency: fetchStartedAt - mutationCompletedAt */
    latencyMs: number;
    /** Whether the refetch actually changed data */
    dataChanged?: boolean;
  }>;
  /** Timestamp when the correlation window closed */
  resolvedAt: number;
}

export interface RuntimeTanStackQueryUpdateMessage {
  type: 'runtime:tanstackQuery';
  queries: TanStackQueryInfo[];
  mutations: TanStackMutationInfo[];
  /** New correlation events since last snapshot */
  correlations?: MutationCorrelation[];
  timestamp: number;
}

// ============================================================================
// Render Cascade & Call Stack Tracing Types
// ============================================================================

export interface StackFrame {
  functionName: string | null;
  fileName: string | null;
  lineNumber: number | null;
  columnNumber: number | null;
  /** false for node_modules / react-dom / react-reconciler frames */
  isUserCode: boolean;
}

export interface TriggerRecord {
  triggerId: string;
  fiberId: string;
  componentName: string;
  hookIndex: number;
  hookType: 'state' | 'reducer' | 'setState' | 'forceUpdate';
  stack: StackFrame[];
  timestamp: number;
  action: SerializedValue | null;
  batchId: string | null;
}

export type CascadeReason =
  | 'state-update'
  | 'context-update'
  | 'props-changed'
  | 'parent-cascade'
  | 'force-update'
  | 'bailed-out';

export interface CascadeNode {
  nodeId: string;
  componentName: string;
  reason: CascadeReason;
  renderDuration: number;
  subtreeDuration: number;
  changedProps?: string[];
  hookIndex?: number;
  triggerId?: string;
  children: CascadeNode[];
  depth: number;
  isMemoized: boolean;
  /** JSX-runtime attribution (Milestone 8 Phase 6) — mirror of shared LiveTreeNode field. */
  jsxSource?: FlotraceJsxSource;
}

export type LanePriority =
  | 'sync'
  | 'discrete'
  | 'continuous'
  | 'default'
  | 'transition'
  | 'deferred'
  | 'idle'
  | 'offscreen';

export interface LaneInfo {
  priority: LanePriority;
  lanes: number;
  isTransition: boolean;
  isBlocking: boolean;
}

export interface CascadeRecord {
  commitId: string;
  timestamp: number;
  totalDuration: number;
  totalComponents: number;
  avoidableCount: number;
  avoidableDuration: number;
  rootCauses: CascadeNode[];
  lane: LaneInfo;
  triggerIds: string[];
}

export interface RuntimeRenderTriggerMessage {
  type: 'runtime:renderTrigger';
  trigger: TriggerRecord;
}

export interface RuntimeRenderCascadeMessage {
  type: 'runtime:renderCascade';
  cascade: CascadeRecord;
}

// ============================================================================
// Prop Drilling Types (runtime-local mirror of shared types)
// ============================================================================

export interface PropDrillingChainNode {
  nodeId: string;
  componentName: string;
  propKey: string;
  role: 'source' | 'passthrough' | 'consumer';
  hookCount: number;
  hasContextHook: boolean;
  /** JSX-runtime attribution (Milestone 8 Phase 6). */
  jsxSource?: FlotraceJsxSource;
}

export interface PropDrillingChain {
  chainId: string;
  propName: string;
  sourceNodeId: string;
  sourceComponentName: string;
  consumerNodeIds: string[];
  consumerComponentNames: string[];
  path: PropDrillingChainNode[];
  depth: number;
  passthroughCount: number;
  severity: 'info' | 'warning' | 'critical';
  renames: Array<{ atNodeId: string; fromKey: string; toKey: string }>;
}

export interface RuntimePropDrillingMessage {
  type: 'runtime:propDrilling';
  payload: {
    chains: PropDrillingChain[];
    passthroughNodeIds: string[];
    analysisTimestamp: number;
    treeSize: number;
  };
}

// ============================================================================
// React 19+ & Next.js SSR Runtime Messages
// ============================================================================

/**
 * State of a single useActionState / useOptimistic hook instance on a fiber.
 * Mirror of `ActionStateEntry` in flotrace-desktop's `shared/liveMessages.ts`
 * — keep the field set in sync.
 */
export interface ActionStateEntry {
  hookIndex: number;
  hookKind: 'action' | 'optimistic';
  isPending: boolean;
  state: SerializedValue;
  error?: SerializedValue;
  pendingSince?: number;
  durationMs?: number;
}

/** Sent whenever a useActionState or useOptimistic hook changes on any fiber */
export interface RuntimeActionStateMessage {
  type: 'runtime:actionState';
  nodeId: string;
  componentName: string;
  /** One entry per useActionState / useOptimistic hook on this fiber */
  actions: ActionStateEntry[];
  timestamp: number;
}

/** Sent when a useOptimistic value diverges from its underlying actual value */
export interface RuntimeOptimisticDiffMessage {
  type: 'runtime:optimisticDiff';
  nodeId: string;
  componentName: string;
  hookIndex: number;
  optimisticValue: SerializedValue;
  actualValue: SerializedValue;
  timestamp: number;
}

/** Sent once on mount when the Next.js environment is detected */
export interface RuntimeNextjsContextMessage {
  type: 'runtime:nextjsContext';
  detected: boolean;
  version?: string;
  isAppRouter: boolean;
  initialRoute?: string;
  timestamp: number;
}

/**
 * RSC / Next.js cache header status. Mirror of the union in
 * `shared/liveMessages.ts`'s `RscPayloadEntry.cacheStatus` — keep in sync.
 */
export type RscCacheStatus = 'HIT' | 'MISS' | 'STALE' | 'unknown';

/** Sent when an RSC / Next.js data fetch is intercepted (metadata only, no values) */
export interface RuntimeRscPayloadMessage {
  type: 'runtime:rscPayload';
  route: string;
  payloadSizeBytes: number;
  cacheStatus: RscCacheStatus;
  timestamp: number;
}

/** Sent when React hydration completes or a mismatch is detected */
export interface RuntimeHydrationEventMessage {
  type: 'runtime:hydrationEvent';
  kind: 'complete' | 'mismatch';
  durationMs?: number;
  errorMessage?: string;
  timestamp: number;
}

// ============================================================================
// JSX Runtime — Milestone 8 Phase 4 (Hot Call Sites + Duplicate Keys)
// ============================================================================

/**
 * Per-callsite render frequency snapshot. Emitted at most once per second by
 * the runtime when the JSX-runtime opt-in is active — the ring buffer in
 * `jsxRuntimeUtils.ts` is the source of truth, this message is a periodic
 * compaction of the buffer into "renders/sec over last 5s" so the desktop
 * doesn't need to mirror the buffer.
 *
 * Independent of the React Profiler — works in concurrent rendering where the
 * Profiler may miss commits. Only emitted when there's at least one callsite
 * with non-zero recent activity (no metric-flood on idle apps).
 */
export interface RuntimeCallSiteMetricsMessage {
  type: 'runtime:callSiteMetrics';
  /** Map of callSiteId → renders/sec over the last 5-second window. */
  metrics: Record<string, number>;
  timestamp: number;
}

/**
 * Duplicate-key warning. Emitted by the JSX runtime when it observes the same
 * `(callSiteId, key)` pair on two or more JSX calls within a single commit —
 * the classic `{items.map(item => <Row key={item.id} />)}` pattern where
 * `item.id` repeats. React logs a console warning for this; we surface it
 * with full file:line attribution so the user can navigate directly to the
 * map call site.
 *
 * One message per (callSiteId, duplicateKey) per emission window — the
 * runtime de-duplicates so a list with 100 duplicate rows doesn't spam 100
 * messages.
 */
export interface RuntimeDuplicateKeyMessage {
  type: 'runtime:duplicateKey';
  /** The JSX call site that produced the duplicates. */
  callSiteId: string;
  fileName: string;
  lineNumber: number;
  columnNumber: number;
  /** The key value that appeared more than once. */
  duplicateKey: string;
  /** How many times the same key fired at this call site in the commit. */
  occurrences: number;
  timestamp: number;
}

// ============================================================================
// Network Request Tracking
// ============================================================================

/** Metadata for a single intercepted network request. Privacy-first: no bodies, no query params, no auth headers. */
export interface NetworkRequestEntry {
  /** Incrementing request ID */
  requestId: string;
  /** HTTP method (GET, POST, PUT, DELETE, PATCH, etc.) */
  method: string;
  /** URL path only — query params stripped for privacy */
  urlPath: string;
  /** URL host for endpoint grouping */
  urlHost: string;
  /** HTTP status code (0 if pending/aborted) */
  status: number;
  /** Request duration in ms (null if still pending) */
  durationMs: number | null;
  /** Response size from Content-Length header (null if unavailable) */
  responseSizeBytes: number | null;
  /** React component that initiated this request (if attributable) */
  componentName?: string;
  /** Ancestor chain of the initiating component (last 3) */
  ancestorChain?: string[];
  /** True if fetch was called during React render phase (anti-pattern) */
  initiatedDuringRender: boolean;
  /** True if fetch was called inside a useEffect callback */
  initiatedInEffect: boolean;
  /** Request lifecycle state */
  state: 'pending' | 'success' | 'error' | 'aborted';
  /** Deduplication key: `${method}:${normalizedPath}` for duplicate detection */
  dedupeKey: string;
  /** True if another request with same dedupeKey was made within 2s */
  isDuplicate?: boolean;
  /** True if this is a Next.js Server Action (POST with Next-Action header) */
  isServerAction?: boolean;
  /** True if this is a Next.js RSC prefetch (Next-Router-Prefetch header) */
  isPrefetch?: boolean;
  /** Error message if request failed */
  errorMessage?: string;
  /** Timestamp (Date.now()) */
  timestamp: number;
}

/** Batched network request message sent to FloTrace server */
export interface RuntimeNetworkRequestMessage {
  type: 'runtime:networkRequest';
  requests: NetworkRequestEntry[];
  timestamp: number;
}

/** Emitted when a fiber's useState/useReducer hook holds API response data (WeakMap causal) */
export interface RuntimeLocalStateCorrelationMessage {
  type: 'runtime:localStateCorrelation';
  requestId: string;
  componentName: string;
  hookIndex: number;
  timestamp: number;
}

// ============================================================================
// Value Lineage (Variable Origin Tracing)
// ============================================================================

/**
 * Confidence of a single trace step boundary.
 * - `exact`: reference identity (`===`) preserved across the step.
 * - `fingerprint-match`: only structural match via valueFingerprint(). Primitive
 *   collisions are possible here (e.g., `count: 5` at multiple call sites).
 */
export type TraceConfidence = 'exact' | 'fingerprint-match';

/**
 * A single step in a value-origin chain.
 * Chain ordering: consumer first, origin last.
 */
export type TraceStep =
  | {
      kind: 'prop';
      nodeId: string;
      componentName: string;
      /** Dot-path into the component's props (e.g., ['user', 'profile', 'avatarUrl']). */
      propPath: string[];
      /** If this step came via a rename edge in the drilling graph. */
      renamedFrom?: string;
      confidence: TraceConfidence;
      /**
       * JSX-runtime attribution of the PARENT fiber that wrote the value into
       * this prop (Milestone 8 Phase 6). Captured by `readJsxSourceFromFiber`
       * on the ancestor at trace-resolution time. Undefined when the parent
       * fiber lacks attribution.
       */
      callSiteOfParentJsx?: FlotraceJsxSource;
    }
  | {
      kind: 'hook-state';
      nodeId: string;
      componentName: string;
      hookIndex: number;
      hookType: HookType;
      /** Sub-path into the hook's current value, when the traced leaf is nested. */
      subPath?: string[];
      confidence: TraceConfidence;
    }
  | {
      kind: 'store';
      source: 'zustand' | 'redux' | 'tanstack-query';
      storeName: string;
      /** Key path into the store state where the matching value lives. */
      keyPath: string[];
      confidence: TraceConfidence;
    }
  | {
      kind: 'api';
      requestId: string;
      method: string;
      /** URL path only — query params stripped for privacy. */
      urlPath: string;
      status?: number;
      /** Age of the fetch at trace resolution time. */
      ageMs: number;
      /** True when the 3s FETCH_ORIGIN_TTL_MS window has lapsed. */
      expired?: boolean;
    }
  | {
      kind: 'context';
      contextName: string;
      providerNodeId?: string;
      confidence: TraceConfidence;
    }
  | {
      /** Value is the cached result of a useMemo/useCallback on the same fiber.
       *  `depCount` tells the UI how many upstream inputs the memo depends on
       *  (one of which the user may want to click-trace next). */
      kind: 'derived';
      nodeId: string;
      componentName: string;
      hookIndex: number;
      hookType: 'useMemo' | 'useCallback';
      depCount: number;
      confidence: TraceConfidence;
    };

/**
 * Result of a single value-trace request.
 */
export interface ValueTrace {
  /** Round-trip ID — mirrors the requestId from ext:traceValue. */
  requestId: string;
  rootNodeId: string;
  /** Dot-path from the component when tracing a prop (e.g., ['user','profile','avatarUrl']). */
  rootPropPath?: string[];
  /** When tracing a hook value, addresses hook index + optional sub-path inside its value. */
  rootHookPath?: { hookIndex: number; subPath?: string[] };
  /** Ordered steps — index 0 is the consumer, last index is the origin. */
  steps: TraceStep[];
  /** Wall-clock time the resolver completed. */
  resolvedAtMs: number;
  /**
   * Optional error hint for friendly empty states.
   * - `value-not-found`: target path doesn't exist on the current fiber.
   * - `no-fiber`: nodeId no longer present in fiberRefMap (component unmounted).
   */
  error?: 'value-not-found' | 'no-fiber';
}

export interface RuntimeValueTraceMessage {
  type: 'runtime:valueTrace';
  trace: ValueTrace;
  timestamp: number;
}

/**
 * Messages received from extension
 */
export type ExtensionToRuntimeMessage =
  | { type: 'ext:ping' }
  | { type: 'ext:startTracking'; options?: TrackingOptions }
  | { type: 'ext:stopTracking' }
  | { type: 'ext:requestState'; componentName?: string }
  | { type: 'ext:requestNodeProps'; nodeId: string }
  | { type: 'ext:startTreeTracking' }
  | { type: 'ext:stopTreeTracking' }
  | { type: 'ext:requestFullSnapshot' }
  | { type: 'ext:requestNodeHooks'; nodeId: string }
  | { type: 'ext:requestNodeEffects'; nodeId: string }
  | { type: 'ext:requestDetailedRenderReason'; nodeId: string }
  | { type: 'ext:requestTimeline'; nodeId: string }
  | { type: 'ext:startNetworkCapture' }
  | { type: 'ext:stopNetworkCapture' }
  // Individual tracker start/stop for sidebar panel hide/show
  | { type: 'ext:startReduxTracking' }
  | { type: 'ext:stopReduxTracking' }
  | { type: 'ext:startRouterTracking' }
  | { type: 'ext:stopRouterTracking' }
  | { type: 'ext:startZustandTracking' }
  | { type: 'ext:stopZustandTracking' }
  | { type: 'ext:startTanstackTracking' }
  | { type: 'ext:stopTanstackTracking' }
  /**
   * Value Lineage — resolve the origin of a specific prop or hook value.
   * Either `propPath` or `hookPath` must be set (exactly one).
   */
  | {
      type: 'ext:traceValue';
      /** Round-trip ID — echoed back in runtime:valueTrace. */
      requestId: string;
      nodeId: string;
      /** When tracing a prop: dot-path like ['user','profile','avatarUrl']. Index 0 is the top-level prop key. */
      propPath?: string[];
      /** When tracing a hook value: hook index + optional nested sub-path inside its value. */
      hookPath?: { hookIndex: number; subPath?: string[] };
    };

export interface TrackingOptions {
  trackAllRenders?: boolean;
  componentFilter?: string[];
  includeProps?: boolean;
  trackZustand?: boolean;
  trackRedux?: boolean;
  trackRouter?: boolean;
  trackContext?: boolean;
  trackTanstackQuery?: boolean;
  trackNetwork?: boolean;
  batchSize?: number;
  batchDelayMs?: number;
}

/**
 * FloTrace provider configuration
 */
export interface FloTraceConfig {
  /** WebSocket server port (default: 3457) */
  port?: number;
  /** App name to display in FloTrace */
  appName?: string;
  /** Enable/disable tracking (default: true in development) */
  enabled?: boolean;
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Reconnect interval in ms (default: 2000) */
  reconnectInterval?: number;
  /** Track all renders or only specific components */
  trackAllRenders?: boolean;
  /** Include props in render events (default: true) */
  includeProps?: boolean;
  /** Track Zustand stores (default: true) */
  trackZustand?: boolean;
  /** Track Redux store (default: true) */
  trackRedux?: boolean;
  /** Track React Router (default: true) */
  trackRouter?: boolean;
  /** Track Context (default: true) */
  trackContext?: boolean;
  /** Track TanStack Query (default: true) */
  trackTanstackQuery?: boolean;
  /** Resolver for the app URL included in the `runtime:ready` message.
   *  Web adapter passes `() => window.location.href`; native adapters pass undefined
   *  (no browser URL on React Native). */
  getAppUrl?: () => string | undefined;
  /** Runtime platform — set by adapters. Web passes 'web'; native derives from `Platform.OS`.
   *  Surfaced on `runtime:ready` so the desktop can badge nodes + disambiguate multi-app sessions. */
  platform?: 'web' | 'ios' | 'android';
  /** Stable app identifier. Used by the desktop to disambiguate simultaneously-connected
   *  clients (e.g., one iOS + one Android from the same monorepo). */
  appId?: string;
  /** App version — surfaced on `runtime:ready` for diagnostic display. */
  appVersion?: string;
  /** WebSocket host override. Native adapter sets this to the resolved Metro host
   *  (e.g., "10.0.2.2" on Android emulator, LAN IP for physical devices).
   *  Defaults to '127.0.0.1' when unset. */
  host?: string;
  /** LAN auth token for connections to `0.0.0.0`-bound desktop servers.
   *  Ignored for loopback (`127.0.0.1`) connections. Paste from desktop Settings. */
  authToken?: string;
  /** **Experimental (runtime-native only).** Default-deny filter: a component is
   *  treated as framework unless its fiber has positive source-path evidence
   *  (`_debugSource`, owner-chain `_debugSource`, or `_debugStack` first non-react
   *  frame) pointing outside `node_modules`. Eliminates most per-library
   *  wrapper-name maintenance. Default: `true` on native, `false` on web. Pass
   *  `false` to fall back to the name-list-based framework filter. */
  userOnlyStrict?: boolean;
  /** Regex patterns that mark paths as user code even when they would otherwise
   *  be hidden by strict mode (e.g. monorepo packages resolved into
   *  `node_modules/@workspace/ui`). Only consulted when `userOnlyStrict` is on. */
  userAllowPatterns?: RegExp[];
  /** Auto-detected framework family. Adapters set this via platform-specific probes
   *  (DOM signals on web; optional-require on native). Not a user-facing knob. */
  frameworkName?: 'next' | 'expo' | 'rn-cli' | 'plain-react';
  /** Framework version when the adapter can resolve it. Not a user-facing knob. */
  frameworkVersion?: string;
  /** React Native version from `Platform.constants.reactNativeVersion`, formatted
   *  "major.minor.patch". Native adapter only. */
  reactNativeVersion?: string;
  /** Version of the active runtime adapter (`@flotrace/runtime` on web,
   *  `@flotrace/runtime-native` on RN). Adapters auto-populate from their
   *  own package.json. Surfaced on `runtime:ready` for diagnostics. */
  runtimeVersion?: string;
}

/** Keys that stay optional in DEFAULT_CONFIG. These are populated by adapters (web/native)
 *  at call-time — the default object should not pretend to know a platform or LAN token. */
type OptionalConfigKeys =
  | 'getAppUrl'
  | 'platform'
  | 'appId'
  | 'appVersion'
  | 'host'
  | 'authToken'
  | 'userOnlyStrict'
  | 'userAllowPatterns'
  | 'frameworkName'
  | 'frameworkVersion'
  | 'reactNativeVersion'
  | 'runtimeVersion';

export type ResolvedFloTraceConfig = Required<Omit<FloTraceConfig, OptionalConfigKeys>> &
  Pick<FloTraceConfig, OptionalConfigKeys>;

/**
 * Default configuration
 */
/**
 * Build-time production detection. Shared by `DEFAULT_CONFIG.enabled` and the web/native
 * providers' production no-op early-return so a consumer's shipped app pays nothing.
 *
 * Why the BARE `process.env.NODE_ENV` token (not `globalThis.process.env.NODE_ENV`):
 * bundlers — Webpack DefinePlugin, Vite, esbuild `define` — statically replace ONLY the
 * bare member expression `process.env.NODE_ENV` with a string literal at build time. They
 * do NOT match `globalThis.process.env.NODE_ENV`. The previous `globalThis.process?.env?.`
 * heuristic therefore never got folded and silently failed OPEN in production on bundlers
 * that don't expose a runtime `process` shim (Vite / Rsbuild / Webpack `node:false`) — every
 * end user then ran the full fiber walker. Referencing the bare token lets the bundler fold
 * this to a constant and dead-code-eliminate the disabled path.
 *
 * The `try/catch` is deliberate and NOT a `typeof process` guard: a `typeof process` check
 * would short-circuit BEFORE the replaced token on Vite (where `process` is undefined at
 * runtime even though the token WAS replaced at build time), defeating the fold. With
 * try/catch, a raw-ESM / no-bundler context where `process` is genuinely undefined throws a
 * ReferenceError that we swallow → fail OPEN (treated as development), preserving the
 * "works out of the box in dev" guarantee.
 */
export function isProductionBuild(): boolean {
  try {
    if (process.env.NODE_ENV === 'production') {
      return true;
    }
  } catch {
    // `process` undefined and the bundler didn't replace the token (raw ESM / no bundler) —
    // not a production signal; fall through to the runtime-shim check below.
  }
  // Fallback: some setups expose a runtime `globalThis.process` shim instead of replacing
  // the token. This can't be statically folded, so it only ever runs in unbundled contexts.
  const shimmed = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
    ?.NODE_ENV;
  return shimmed === 'production';
}

export const DEFAULT_CONFIG: ResolvedFloTraceConfig = {
  port: 3457,
  appName: 'React App',
  // Default-on in development, off in production. See `isProductionBuild` for the bundler
  // mechanics. The web/native providers ALSO early-return in production (a defence-in-depth
  // strip that lets bundlers dead-code-eliminate the install entirely), so this default and
  // the provider strip together close the "shipped a live runtime to end users" gap.
  enabled: !isProductionBuild(),
  autoReconnect: true,
  reconnectInterval: 2000,
  trackAllRenders: true,
  includeProps: true,
  trackZustand: true,
  trackRedux: true,
  trackRouter: true,
  trackContext: true,
  trackTanstackQuery: true,
  getAppUrl: undefined,
};
