/**
 * Redux Store Tracker for @flotrace/runtime
 *
 * Subscribes to a Redux store and sends state change notifications
 * to the FloTrace VS Code extension.
 *
 * Design: User passes their Redux store via the `reduxStore` prop on <FloTraceProvider>.
 * We subscribe via store.subscribe() and use store.getState() to capture state.
 *
 * Key difference from Zustand tracker:
 * - Redux store.subscribe() callback receives no arguments
 * - We must call store.getState() manually and diff against previous snapshot
 * - Redux is a single global store (no multi-store record)
 */

import { getChangedKeys } from './serializer';
import { serializeStoreState, buildCorrelatedRequests } from './storeUtils';
import type { FloTraceWebSocketClient } from './websocketClient';

/** Minimal Redux store interface — only what we need to subscribe */
export interface ReduxStoreApi {
  subscribe: (listener: () => void) => () => void;
  getState: () => Record<string, unknown>;
}

// Module-level state (mirrors zustandTracker pattern)
let activeUnsubscribe: (() => void) | null = null;
let isInstalled = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let previousState: Record<string, unknown> | null = null;
const DEBOUNCE_MS = 200;

/**
 * Validate that an object looks like a Redux store.
 * Checks for getState, subscribe, and dispatch as functions.
 */
export function isReduxStore(obj: unknown): obj is ReduxStoreApi {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    typeof (obj as Record<string, unknown>).getState === 'function' &&
    typeof (obj as Record<string, unknown>).subscribe === 'function' &&
    typeof (obj as Record<string, unknown>).dispatch === 'function'
  );
}

/**
 * Install Redux store tracking.
 * Subscribes to the store and sends runtime:redux messages on state change.
 */
export function installReduxTracker(
  store: ReduxStoreApi,
  client: FloTraceWebSocketClient
): void {
  if (isInstalled) {
    console.warn('[FloTrace] Redux tracker already installed, reinstalling');
    uninstallReduxTracker();
  }

  isInstalled = true;
  console.log('[FloTrace] Installing Redux tracker');

  try {
    // Capture initial state
    const initialState = store.getState();
    previousState = initialState;
    sendReduxUpdate(initialState, Object.keys(initialState), client);

    // Subscribe to future changes — Redux subscribe() takes no-arg callback
    activeUnsubscribe = store.subscribe(() => {
      try {
        const newState = store.getState();
        scheduleReduxUpdate(newState, client);
      } catch (error) {
        console.error('[FloTrace] Error in Redux subscribe callback:', error);
      }
    });
  } catch (error) {
    console.error('[FloTrace] Failed to install Redux tracker:', error);
    isInstalled = false;
  }
}

/**
 * Uninstall Redux store tracking.
 */
export function uninstallReduxTracker(): void {
  if (!isInstalled) return;

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  if (activeUnsubscribe) {
    try {
      activeUnsubscribe();
    } catch (error) {
      console.error('[FloTrace] Error unsubscribing from Redux store:', error);
    }
    activeUnsubscribe = null;
  }

  previousState = null;
  isInstalled = false;
  console.log('[FloTrace] Redux tracker uninstalled');
}

/**
 * Schedule a debounced store update.
 * Diffs against previous snapshot since Redux subscribe() gives no args.
 */
function scheduleReduxUpdate(
  newState: Record<string, unknown>,
  client: FloTraceWebSocketClient
): void {
  let changedKeys: string[];
  try {
    changedKeys = getChangedKeys(previousState ?? {}, newState);
  } catch (error) {
    console.error('[FloTrace] Error diffing Redux state:', error);
    return;
  }
  if (changedKeys.length === 0) return;

  // Update previous state reference immediately to capture rapid changes
  previousState = newState;

  if (debounceTimer) clearTimeout(debounceTimer);

  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    sendReduxUpdate(newState, changedKeys, client);
  }, DEBOUNCE_MS);
}

/**
 * Serialize and send a Redux state snapshot via WebSocket.
 */
function sendReduxUpdate(
  state: Record<string, unknown>,
  changedKeys: string[],
  client: FloTraceWebSocketClient
): void {
  try {
    if (!client.connected) return;

    client.sendImmediate({
      type: 'runtime:redux',
      state: serializeStoreState(state, 'Redux'),
      changedKeys,
      correlatedRequests: buildCorrelatedRequests(state, changedKeys),
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('[FloTrace] Error sending Redux update:', error);
  }
}
