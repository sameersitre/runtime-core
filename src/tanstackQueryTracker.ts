/**
 * TanStack Query Tracker for @flotrace/runtime
 *
 * Subscribes to QueryCache and MutationCache events and sends
 * query/mutation state snapshots to the FloTrace desktop app.
 *
 * Features:
 * - Cache state snapshots with config for health analysis
 * - Wasted refetch detection (data unchanged across fetches)
 * - Per-query state transition timeline (ring buffer)
 * - Mutation → query correlation (detects invalidation cascades)
 *
 * Uses duck-typed interface — no @tanstack/react-query dependency needed.
 */

import type {
  SerializedValue,
  TanStackQueryInfo,
  TanStackMutationInfo,
  TanStackQueryEvent,
  MutationCorrelation,
} from './types';
import { serializeValue } from './serializer';
import type { FloTraceWebSocketClient } from './websocketClient';
import { findFetchOrigin } from './fetchOriginRegistry';

// ============================================================================
// Duck-Typed Interfaces (no TanStack dependency)
// ============================================================================

/** Minimal Query interface — only what we need to read state */
interface DuckQuery {
  queryKey: unknown[];
  queryHash: string;
  state: {
    status: 'pending' | 'success' | 'error';
    fetchStatus: 'idle' | 'fetching' | 'paused';
    data: unknown;
    error: unknown;
    dataUpdatedAt: number;
    errorUpdatedAt: number;
    isInvalidated: boolean;
    fetchFailureCount: number;
    fetchFailureReason: unknown;
  };
  options: {
    staleTime?: number;
    gcTime?: number;
    retry?: number | boolean;
    refetchInterval?: number | false;
    refetchOnWindowFocus?: boolean | 'always';
    refetchOnMount?: boolean | 'always';
    refetchOnReconnect?: boolean | 'always';
    networkMode?: 'online' | 'always' | 'offlineFirst';
    enabled?: boolean;
    meta?: Record<string, unknown>;
  };
  getObserversCount(): number;
  isStale(): boolean;
  isActive(): boolean;
  isDisabled(): boolean;
}

/** Minimal Mutation interface */
interface DuckMutation {
  mutationId: number;
  state: {
    status: 'idle' | 'pending' | 'error' | 'success';
    isPaused: boolean;
    submittedAt: number;
    variables: unknown;
    error: unknown;
    failureCount: number;
  };
  options: {
    mutationKey?: unknown[];
    scope?: { id: string };
  };
}

/** Minimal QueryCache interface */
interface DuckQueryCache {
  getAll(): DuckQuery[];
  subscribe(cb: (event: { type: string; query?: DuckQuery }) => void): () => void;
}

/** Minimal MutationCache interface */
interface DuckMutationCache {
  getAll(): DuckMutation[];
  subscribe(cb: (event: { type: string; mutation?: DuckMutation }) => void): () => void;
}

/** Duck-typed QueryClient — what we need from the user */
export interface TanStackQueryClientApi {
  getQueryCache(): DuckQueryCache;
  getMutationCache(): DuckMutationCache;
}

// ============================================================================
// Module-Level State
// ============================================================================

let isInstalled = false;
let queryUnsubscribe: (() => void) | null = null;
let mutationUnsubscribe: (() => void) | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 300;

/**
 * Live reference to the tracked QueryClient. Populated during install, cleared
 * on uninstall. Used by the Value Lineage resolver to pull the **raw**
 * query-cache data (not serialized) for reference-identity + fingerprint
 * matching against component values.
 */
let trackedClient: TanStackQueryClientApi | null = null;

// ============================================================================
// Per-Query Tracking State (wasted refetch + timeline)
// ============================================================================

const MAX_EVENTS_PER_QUERY = 50;

interface QueryTrackingState {
  /**
   * Reference to the last known data (for wasted-refetch detection). Compared by
   * reference identity — see `dataReferenceChanged`. Holding the reference does not
   * retain anything the live cache wouldn't already hold (same object TanStack keeps).
   */
  lastData: unknown;
  /** Last known dataUpdatedAt timestamp */
  lastDataUpdatedAt: number;
  /** Previous status for transition detection */
  prevStatus: string;
  /** Previous fetchStatus for transition detection */
  prevFetchStatus: string;
  /** Total fetches observed */
  totalFetchCount: number;
  /** Fetches where data didn't change */
  wastedRefetchCount: number;
  /** State transition ring buffer */
  events: TanStackQueryEvent[];
  /** requestId of the API call whose response landed in this query's cache (one-shot, cleared after send) */
  pendingCorrelationId?: string;
}

/** Per-query tracking state keyed by queryHash */
const queryTracking = new Map<string, QueryTrackingState>();

// ============================================================================
// Phase 5: Mutation → Query Correlation State
// ============================================================================

const CORRELATION_WINDOW_MS = 500;
const MAX_COMPLETED_CORRELATIONS = 20;
let correlationCounter = 0;

interface PendingCorrelation {
  correlationId: string;
  mutationId: number;
  mutationKey?: unknown[];
  completedAt: number;
  /** queryHashes that were idle before mutation completed */
  idleQueryHashes: Set<string>;
  /** Queries that started fetching within the window */
  affectedQueries: Map<string, { fetchStartedAt: number; queryKey: unknown[] }>;
  timeoutId: ReturnType<typeof setTimeout>;
}

/** Active correlation windows keyed by correlationId */
const pendingCorrelations = new Map<string, PendingCorrelation>();
/** Completed correlations ready to send (ring buffer) */
let completedCorrelations: MutationCorrelation[] = [];
/** Per-mutation previous status for transition detection */
const mutationPrevStatus = new Map<number, string>();
/** Maps mutationId → last correlationId for UI cross-reference */
const mutationCorrelationMap = new Map<number, string>();

// ============================================================================
// Validation
// ============================================================================

/** Validate that an object looks like a TanStack QueryClient */
export function isTanStackQueryClient(obj: unknown): obj is TanStackQueryClientApi {
  if (!obj || typeof obj !== 'object') return false;
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.getQueryCache === 'function' &&
    typeof candidate.getMutationCache === 'function'
  );
}

// ============================================================================
// Install / Uninstall
// ============================================================================

/**
 * Install TanStack Query tracking.
 * Subscribes to QueryCache and MutationCache and sends runtime:tanstackQuery messages.
 */
export function installTanStackQueryTracker(
  queryClient: TanStackQueryClientApi,
  client: FloTraceWebSocketClient,
): void {
  if (isInstalled) {
    console.warn('[FloTrace] TanStack Query tracker already installed, reinstalling');
    uninstallTanStackQueryTracker();
  }

  isInstalled = true;
  console.log('[FloTrace] Installing TanStack Query tracker');

  try {
    trackedClient = queryClient;
    const queryCache = queryClient.getQueryCache();
    const mutationCache = queryClient.getMutationCache();
    // Initialize tracking state for new queries only (preserve existing counts across reinstalls)
    for (const query of queryCache.getAll()) {
      if (!queryTracking.has(query.queryHash)) {
        initQueryTracking(query);
      }
    }

    // Initialize mutation previous status
    for (const mutation of mutationCache.getAll()) {
      mutationPrevStatus.set(mutation.mutationId, mutation.state.status);
    }

    // Send initial snapshot
    sendSnapshot(queryCache, mutationCache, client);

    // Subscribe to query cache events
    queryUnsubscribe = queryCache.subscribe((event) => {
      try {
        if (event.type === 'added' || event.type === 'removed' || event.type === 'updated') {
          if (event.query) {
            updateQueryTracking(event.query, event.type);
          }
          scheduleSnapshot(queryCache, mutationCache, client);
        }
      } catch (error) {
        console.error('[FloTrace] Error in TanStack Query cache subscribe callback:', error);
      }
    });

    // Subscribe to mutation cache events (track status transitions for correlation)
    mutationUnsubscribe = mutationCache.subscribe((event) => {
      try {
        if (event.mutation) {
          updateMutationTracking(event.mutation, queryCache, mutationCache, client);
        }
        scheduleSnapshot(queryCache, mutationCache, client);
      } catch (error) {
        console.error('[FloTrace] Error in TanStack Mutation cache subscribe callback:', error);
      }
    });
  } catch (error) {
    console.error('[FloTrace] Failed to install TanStack Query tracker:', error);
    isInstalled = false;
  }
}

/**
 * Uninstall TanStack Query tracking.
 */
export function uninstallTanStackQueryTracker(): void {
  if (!isInstalled) return;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (queryUnsubscribe) {
    try {
      queryUnsubscribe();
    } catch (e) {
      console.error('[FloTrace] Error unsubscribing from QueryCache:', e);
    }
    queryUnsubscribe = null;
  }

  if (mutationUnsubscribe) {
    try {
      mutationUnsubscribe();
    } catch (e) {
      console.error('[FloTrace] Error unsubscribing from MutationCache:', e);
    }
    mutationUnsubscribe = null;
  }

  // Clear pending correlation timeouts
  for (const pending of pendingCorrelations.values()) {
    clearTimeout(pending.timeoutId);
  }
  pendingCorrelations.clear();

  // Preserve queryTracking, mutationPrevStatus, completedCorrelations, and
  // mutationCorrelationMap across reinstalls — accumulated over the session.
  trackedClient = null;
  isInstalled = false;
  console.log('[FloTrace] TanStack Query tracker uninstalled');
}

/**
 * Snapshot of every cached query's **raw** data (not serialized) keyed by
 * queryHash. Used by the Value Lineage resolver to match component values
 * against TanStack Query cache via reference identity + structural fingerprint,
 * and to pass raw references into `findFetchOrigin()`.
 *
 * Returns an empty map when the tracker isn't installed.
 */
export function getTanstackSnapshot(): Map<string, { queryKey: unknown[]; data: unknown }> {
  const snapshot = new Map<string, { queryKey: unknown[]; data: unknown }>();
  if (!trackedClient) return snapshot;
  try {
    const queryCache = trackedClient.getQueryCache();
    for (const query of queryCache.getAll()) {
      if (query.state.data !== undefined) {
        snapshot.set(query.queryHash, { queryKey: query.queryKey, data: query.state.data });
      }
    }
  } catch {
    // QueryCache access threw — return whatever we've accumulated so far.
  }
  return snapshot;
}

// ============================================================================
// Per-Query Tracking Logic
// ============================================================================

/**
 * Whether a query's data changed since we last saw it.
 *
 * Compared by REFERENCE (`Object.is`), NOT a `JSON.stringify` content hash. TanStack
 * Query's default `structuralSharing` returns the SAME object reference when a refetch
 * yields structurally-identical data, so reference identity is an O(1), allocation-free,
 * size-independent signal for "did the data actually change" — exactly what wasted-refetch
 * detection needs. The previous content hash ran an UNCAPPED `JSON.stringify` over the full
 * payload on every status transition (≥2 per fetch), a synchronous main-thread cost that
 * scaled with cache size — a multi-MB cached list could drop frames on the JS-thread-bound
 * React Native renderer during a focus-triggered refetch.
 *
 * Trade-off: a consumer who sets `structuralSharing: false` gets a fresh reference on every
 * fetch, so wasted refetches are OVER-reported (never under-reported) — a safe, cheap
 * degradation rather than a crash or a size-proportional stall.
 */
function dataReferenceChanged(prev: unknown, current: unknown): boolean {
  return !Object.is(prev, current);
}

function initQueryTracking(query: DuckQuery): QueryTrackingState {
  const state: QueryTrackingState = {
    lastData: query.state.data,
    lastDataUpdatedAt: query.state.dataUpdatedAt,
    prevStatus: query.state.status,
    prevFetchStatus: query.state.fetchStatus,
    totalFetchCount: 0,
    wastedRefetchCount: 0,
    events: [],
  };
  queryTracking.set(query.queryHash, state);
  return state;
}

function updateQueryTracking(query: DuckQuery, eventType: string): void {
  let tracking = queryTracking.get(query.queryHash);

  if (eventType === 'removed') {
    queryTracking.delete(query.queryHash);
    return;
  }

  if (!tracking) {
    tracking = initQueryTracking(query);
  }

  const currentStatus = query.state.status;
  const currentFetchStatus = query.state.fetchStatus;

  // Detect state transitions for timeline
  const statusChanged = tracking.prevStatus !== currentStatus;
  const fetchStatusChanged = tracking.prevFetchStatus !== currentFetchStatus;

  if (statusChanged || fetchStatusChanged) {
    // Check if data changed during this transition (O(1) reference compare).
    const dataChanged = dataReferenceChanged(tracking.lastData, query.state.data);

    // Record timeline event
    const event: TanStackQueryEvent = {
      timestamp: Date.now(),
      fromStatus: tracking.prevStatus,
      toStatus: currentStatus,
      fromFetchStatus: tracking.prevFetchStatus,
      toFetchStatus: currentFetchStatus,
      dataChanged,
    };
    tracking.events.push(event);
    if (tracking.events.length > MAX_EVENTS_PER_QUERY) {
      tracking.events.shift();
    }

    // Wasted refetch detection: fetch completed (fetching → idle) with success but data unchanged
    if (
      tracking.prevFetchStatus === 'fetching' &&
      currentFetchStatus === 'idle' &&
      currentStatus === 'success'
    ) {
      tracking.totalFetchCount++;
      if (!dataChanged) {
        tracking.wastedRefetchCount++;
      }
      // Update last-seen data reference after fetch completes
      tracking.lastData = query.state.data;
      tracking.lastDataUpdatedAt = query.state.dataUpdatedAt;

      // Causal API→TanStack correlation via WeakMap tag
      if (query.state.data !== null && query.state.data !== undefined) {
        const rid = findFetchOrigin(query.state.data);
        if (rid) tracking.pendingCorrelationId = rid;
      }
    }

    // Correlation: query started fetching → check pending correlation windows
    if (tracking.prevFetchStatus === 'idle' && currentFetchStatus === 'fetching') {
      const now = Date.now();
      for (const pending of pendingCorrelations.values()) {
        if (pending.idleQueryHashes.has(query.queryHash)) {
          pending.affectedQueries.set(query.queryHash, {
            fetchStartedAt: now,
            queryKey: query.queryKey,
          });
        }
      }
    }

    tracking.prevStatus = currentStatus;
    tracking.prevFetchStatus = currentFetchStatus;
  }
}

// ============================================================================
// Phase 5: Mutation Correlation Logic
// ============================================================================

/**
 * Called when a mutation transitions to 'success'. Opens a correlation window
 * and watches for queries that start fetching within CORRELATION_WINDOW_MS.
 */
function openCorrelationWindow(
  mutation: DuckMutation,
  queryCache: DuckQueryCache,
  mutationCache: DuckMutationCache,
  client: FloTraceWebSocketClient,
): void {
  const correlationId = `corr-${++correlationCounter}`;
  const now = Date.now();

  // Snapshot all currently-idle query hashes as baseline
  const idleQueryHashes = new Set<string>();
  for (const query of queryCache.getAll()) {
    if (query.state.fetchStatus === 'idle') {
      idleQueryHashes.add(query.queryHash);
    }
  }

  const timeoutId = setTimeout(() => {
    resolveCorrelation(correlationId, queryCache, mutationCache, client);
  }, CORRELATION_WINDOW_MS);

  pendingCorrelations.set(correlationId, {
    correlationId,
    mutationId: mutation.mutationId,
    mutationKey: mutation.options.mutationKey,
    completedAt: now,
    idleQueryHashes,
    affectedQueries: new Map(),
    timeoutId,
  });

  mutationCorrelationMap.set(mutation.mutationId, correlationId);
}

/**
 * Resolve a correlation window — build the MutationCorrelation and push to completed.
 */
function resolveCorrelation(
  correlationId: string,
  queryCache: DuckQueryCache,
  mutationCache: DuckMutationCache,
  client: FloTraceWebSocketClient,
): void {
  const pending = pendingCorrelations.get(correlationId);
  if (!pending) return;
  pendingCorrelations.delete(correlationId);

  // Only emit if at least one query was affected
  if (pending.affectedQueries.size === 0) return;

  const affectedQueries: MutationCorrelation['affectedQueries'] = [];
  for (const [queryHash, info] of pending.affectedQueries) {
    // Check if data changed by looking at tracking state
    const tracking = queryTracking.get(queryHash);
    let queryKeySerialized: SerializedValue;
    try {
      queryKeySerialized = serializeValue(info.queryKey);
    } catch {
      queryKeySerialized = '[serialization failed]';
    }
    affectedQueries.push({
      queryHash,
      queryKey: queryKeySerialized,
      fetchStartedAt: info.fetchStartedAt,
      latencyMs: info.fetchStartedAt - pending.completedAt,
      // dataChanged is resolved from the latest tracking state if the fetch completed
      dataChanged: tracking?.events.length
        ? tracking.events[tracking.events.length - 1].dataChanged
        : undefined,
    });
  }

  let mutationKeySerialized: SerializedValue | undefined;
  if (pending.mutationKey) {
    try {
      mutationKeySerialized = serializeValue(pending.mutationKey);
    } catch {
      mutationKeySerialized = '[serialization failed]';
    }
  }

  const correlation: MutationCorrelation = {
    correlationId,
    mutationId: pending.mutationId,
    mutationKey: mutationKeySerialized,
    mutationCompletedAt: pending.completedAt,
    affectedQueries,
    resolvedAt: Date.now(),
  };

  completedCorrelations.push(correlation);
  if (completedCorrelations.length > MAX_COMPLETED_CORRELATIONS) {
    completedCorrelations = completedCorrelations.slice(-MAX_COMPLETED_CORRELATIONS);
  }

  // Immediately send a snapshot with the new correlation
  scheduleSnapshot(queryCache, mutationCache, client);
}

/**
 * Track mutation status transitions for correlation detection.
 */
function updateMutationTracking(
  mutation: DuckMutation,
  queryCache: DuckQueryCache,
  mutationCache: DuckMutationCache,
  client: FloTraceWebSocketClient,
): void {
  const currentStatus = mutation.state.status;
  const prevStatus = mutationPrevStatus.get(mutation.mutationId);
  mutationPrevStatus.set(mutation.mutationId, currentStatus);

  // Open correlation window when mutation succeeds
  if (prevStatus && prevStatus !== 'success' && currentStatus === 'success') {
    openCorrelationWindow(mutation, queryCache, mutationCache, client);
  }
}

// ============================================================================
// Snapshot Scheduling
// ============================================================================

function scheduleSnapshot(
  queryCache: DuckQueryCache,
  mutationCache: DuckMutationCache,
  client: FloTraceWebSocketClient,
): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    sendSnapshot(queryCache, mutationCache, client);
  }, DEBOUNCE_MS);
}

// ============================================================================
// Snapshot Serialization
// ============================================================================

function serializeQueryData(data: unknown): SerializedValue {
  if (data === null || data === undefined) return null;
  try {
    return serializeValue(data);
  } catch {
    return { __type: 'truncated', originalType: typeof data };
  }
}

function extractErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'Unknown error';
  }
}

function serializeQuery(query: DuckQuery): TanStackQueryInfo {
  let queryKeySerialized: SerializedValue;
  try {
    queryKeySerialized = serializeValue(query.queryKey);
  } catch {
    queryKeySerialized = '[serialization failed]';
  }

  const errorMessage = query.state.error ? extractErrorMessage(query.state.error) : undefined;
  const tracking = queryTracking.get(query.queryHash);

  // One-shot: include pending correlation ID then clear it so it's only sent once
  const correlatedRequestId = tracking?.pendingCorrelationId;
  if (correlatedRequestId && tracking) {
    tracking.pendingCorrelationId = undefined;
  }

  return {
    queryKey: queryKeySerialized,
    queryHash: query.queryHash,
    status: query.state.status,
    fetchStatus: query.state.fetchStatus,
    dataUpdatedAt: query.state.dataUpdatedAt,
    errorUpdatedAt: query.state.errorUpdatedAt,
    isInvalidated: query.state.isInvalidated,
    isStale: safeCall(() => query.isStale(), false),
    isActive: safeCall(() => query.isActive(), false),
    isDisabled: safeCall(() => query.isDisabled(), false),
    failureCount: query.state.fetchFailureCount,
    errorMessage,
    observerCount: safeCall(() => query.getObserversCount(), 0),
    staleTime: query.options.staleTime,
    gcTime: query.options.gcTime,
    // Phase 1: additional config for health analysis
    refetchInterval: query.options.refetchInterval,
    refetchOnWindowFocus: query.options.refetchOnWindowFocus,
    refetchOnMount: query.options.refetchOnMount,
    refetchOnReconnect: query.options.refetchOnReconnect,
    networkMode: query.options.networkMode,
    enabled: query.options.enabled,
    retry: query.options.retry,
    dataShape: serializeQueryData(query.state.data),
    // Phase 2: wasted refetch tracking
    wastedRefetchCount: tracking?.wastedRefetchCount,
    totalFetchCount: tracking?.totalFetchCount,
    // Phase 3: query timeline
    events: tracking?.events.length ? [...tracking.events] : undefined,
    correlatedRequestId,
  };
}

function serializeMutation(mutation: DuckMutation): TanStackMutationInfo {
  const errorMessage = mutation.state.error ? extractErrorMessage(mutation.state.error) : undefined;

  let mutationKey: SerializedValue | undefined;
  if (mutation.options.mutationKey) {
    try {
      mutationKey = serializeValue(mutation.options.mutationKey);
    } catch {
      mutationKey = '[serialization failed]';
    }
  }

  return {
    mutationId: mutation.mutationId,
    status: mutation.state.status,
    isPaused: mutation.state.isPaused,
    submittedAt: mutation.state.submittedAt,
    failureCount: mutation.state.failureCount,
    errorMessage,
    mutationKey,
    scope: mutation.options.scope?.id,
    lastCorrelationId: mutationCorrelationMap.get(mutation.mutationId),
  };
}

function sendSnapshot(
  queryCache: DuckQueryCache,
  mutationCache: DuckMutationCache,
  client: FloTraceWebSocketClient,
): void {
  try {
    if (!client.connected) return;

    const queries: TanStackQueryInfo[] = [];
    for (const query of queryCache.getAll()) {
      try {
        queries.push(serializeQuery(query));
      } catch (error) {
        console.error(`[FloTrace] Error serializing query "${query.queryHash}":`, error);
      }
    }

    const mutations: TanStackMutationInfo[] = [];
    const activeMutationIds = new Set<number>();
    for (const mutation of mutationCache.getAll()) {
      try {
        activeMutationIds.add(mutation.mutationId);
        mutations.push(serializeMutation(mutation));
      } catch (error) {
        console.error(`[FloTrace] Error serializing mutation ${mutation.mutationId}:`, error);
      }
    }

    // Clean up tracking maps for mutations no longer in the cache
    for (const id of mutationPrevStatus.keys()) {
      if (!activeMutationIds.has(id)) {
        mutationPrevStatus.delete(id);
        mutationCorrelationMap.delete(id);
      }
    }

    // Flush completed correlations
    const correlations = completedCorrelations.length > 0 ? [...completedCorrelations] : undefined;
    if (correlations) {
      completedCorrelations = [];
    }

    client.sendImmediate({
      type: 'runtime:tanstackQuery',
      queries,
      mutations,
      correlations,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('[FloTrace] Error sending TanStack Query snapshot:', error);
  }
}

// ============================================================================
// Helpers
// ============================================================================

function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
