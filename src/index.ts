/**
 * @flotrace/runtime-core
 *
 * Platform-agnostic core for FloTrace runtime. Contains the fiber tree walker,
 * analyzers, trackers, serializers, and WebSocket client — everything that
 * does NOT directly touch a browser-only API. Consumed by @flotrace/runtime
 * (web adapter) and @flotrace/runtime-native (React Native adapter).
 *
 * This package is not intended to be installed directly by end users — it's
 * pulled in transitively by the platform adapter of their choice.
 */

// Configuration & shared types
export type {
  FloTraceConfig,
  ResolvedFloTraceConfig,
  TrackingOptions,
  SerializedValue,
  LiveTreeNode,
  NetworkRequestEntry,
} from './types';
export { DEFAULT_CONFIG } from './types';

// Console-Free Debugging types
export type {
  DetailedRenderReason,
  DetailedRenderReasonType,
  PropChange,
  HookType,
  HookInfo,
  EffectInfo,
  TimelineEventType,
  TimelineEvent,
  TanStackQueryInfo,
  TanStackMutationInfo,
  MutationCorrelation,
  TanStackQueryEvent,
  RuntimeTreeDiffMessage,
} from './types';

// Value Lineage (Variable Origin Tracing) types
export type {
  TraceConfidence,
  TraceStep,
  ValueTrace,
  RuntimeValueTraceMessage,
} from './types';

// React 19+ & Next.js SSR runtime message types
export type {
  ActionStateEntry,
  RscCacheStatus,
  RuntimeActionStateMessage,
  RuntimeOptimisticDiffMessage,
  RuntimeNextjsContextMessage,
  RuntimeRscPayloadMessage,
  RuntimeHydrationEventMessage,
} from './types';

// Value Lineage resolver
export { resolveValueTrace } from './valueTraceResolver';
export type { ValueTraceInput } from './valueTraceResolver';

// Fiber tree walker
export {
  installFiberTreeWalker,
  uninstallFiberTreeWalker,
  requestTreeSnapshot,
  requestFullSnapshot,
  getNodeProps,
  getNodeHooks,
  getNodeEffects,
  getDetailedRenderReason,
  getFiberRefMap,
} from './fiberTreeWalker';
export type {
  Fiber,
  FiberHookState,
  FiberEffect,
  FiberTreeWalkerOptions,
} from './fiberTreeWalker';

// Fiber attribution helpers (used by network trackers)
export {
  getCurrentRenderingFiber,
  getComponentNameFromFiber,
  buildAncestorChain,
} from './fiberAttribution';

// Hook & effect inspectors
export { inspectHooks } from './hookInspector';
export { inspectEffects } from './effectInspector';

// Store trackers
export {
  installZustandTracker,
  uninstallZustandTracker,
  getZustandSnapshot,
} from './zustandTracker';
export type { ZustandStoreApi } from './zustandTracker';
export {
  installReduxTracker,
  uninstallReduxTracker,
  isReduxStore,
  getReduxSnapshot,
} from './reduxTracker';
export type { ReduxStoreApi } from './reduxTracker';
export {
  installTanStackQueryTracker,
  uninstallTanStackQueryTracker,
  isTanStackQueryClient,
  getTanstackSnapshot,
} from './tanstackQueryTracker';
export type { TanStackQueryClientApi } from './tanstackQueryTracker';

// Timeline tracker
export {
  installTimelineTracker,
  uninstallTimelineTracker,
  recordTimelineEvent,
  getTimeline,
} from './timelineTracker';

// Serializer
export { serializeValue, serializeProps, getChangedKeys } from './serializer';

// WebSocket client
export {
  getWebSocketClient,
  disposeWebSocketClient,
  FloTraceWebSocketClient,
} from './websocketClient';

// API → Store causal correlation registry (shared between web & RN network trackers)
export {
  tagFetchData,
  findFetchOrigin,
  hasActiveTags,
  clearFetchOriginTags,
} from './fetchOriginRegistry';

// Next.js / RSC detection (no-op on non-web platforms)
export {
  detectServerComponent,
  maybeEmitNextjsContext,
  resetNextjsDetection,
} from './nextjsDetector';

// Framework + version detection (web adapter use)
export { detectWebFramework } from './frameworkDetect';
export type { FrameworkInfo } from './frameworkDetect';
export {
  installRscPayloadInterceptor,
  uninstallRscPayloadInterceptor,
} from './rscPayloadInterceptor';
