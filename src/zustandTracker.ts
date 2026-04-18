/**
 * Zustand Store Tracker for @flotrace/runtime
 *
 * Subscribes to explicitly registered Zustand stores and sends
 * state change notifications to the FloTrace VS Code extension.
 *
 * Design: User registers stores via the `stores` prop on <FloTraceProvider>.
 * We subscribe to each store's .subscribe() method and use .getState()
 * to capture state on change.
 *
 * Why explicit registration vs. automatic detection:
 * - Automatic detection requires patching Zustand internals (fragile across versions)
 * - Explicit registration is simple, reliable, and version-independent
 * - Users can control exactly which stores are tracked
 */

import { getChangedKeys } from './serializer';
import { serializeStoreState, buildCorrelatedRequests } from './storeUtils';
import type { FloTraceWebSocketClient } from './websocketClient';

/** Minimal Zustand store interface — only what we need to subscribe */
export interface ZustandStoreApi {
  subscribe: (listener: (state: Record<string, unknown>, prevState: Record<string, unknown>) => void) => () => void;
  getState: () => Record<string, unknown>;
}

// Module-level state (mirrors fiberTreeWalker pattern)
let activeUnsubscribers: Array<() => void> = [];
let isInstalled = false;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 200;

/**
 * Install Zustand store tracking.
 * Subscribes to each store and sends runtime:zustand messages on state change.
 */
export function installZustandTracker(
  stores: Record<string, ZustandStoreApi>,
  client: FloTraceWebSocketClient
): void {
  if (isInstalled) {
    console.warn('[FloTrace] Zustand tracker already installed, reinstalling');
    uninstallZustandTracker();
  }

  isInstalled = true;
  console.log('[FloTrace] Installing Zustand tracker for stores:', Object.keys(stores));

  for (const [storeName, store] of Object.entries(stores)) {
    // Validate that the value looks like a Zustand store (has getState + subscribe as functions).
    // Zustand hooks are functions with store API methods attached as properties,
    // so we accept both 'object' and 'function' types.
    if (
      !store ||
      (typeof store !== 'object' && typeof store !== 'function') ||
      typeof store.getState !== 'function' ||
      typeof store.subscribe !== 'function'
    ) {
      console.warn(
        `[FloTrace] Skipping "${storeName}" — not a valid Zustand store (missing getState/subscribe). ` +
        'Ensure you pass Zustand stores like: stores={{ myStore: useMyStore }}'
      );
      continue;
    }

    // Per-store try-catch so one bad store doesn't prevent tracking the others
    try {
      // Send initial state snapshot immediately
      const initialState = store.getState();
      sendStoreUpdate(storeName, initialState, Object.keys(initialState), client);

      // Subscribe to future changes with per-store debouncing
      const unsubscribe = store.subscribe((newState, prevState) => {
        try {
          scheduleStoreUpdate(storeName, prevState, newState, client);
        } catch (error) {
          console.error(`[FloTrace] Error in Zustand subscribe callback for "${storeName}":`, error);
        }
      });

      activeUnsubscribers.push(unsubscribe);
    } catch (error) {
      console.error(`[FloTrace] Failed to install tracker for Zustand store "${storeName}":`, error);
    }
  }
}

/**
 * Uninstall Zustand store tracking, unsubscribing from all stores.
 */
export function uninstallZustandTracker(): void {
  if (!isInstalled) return;

  // Clear all debounce timers
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();

  // Unsubscribe from all stores
  for (const unsubscribe of activeUnsubscribers) {
    try {
      unsubscribe();
    } catch (error) {
      console.error('[FloTrace] Error unsubscribing from Zustand store:', error);
    }
  }

  activeUnsubscribers = [];
  isInstalled = false;
  console.log('[FloTrace] Zustand tracker uninstalled');
}

/**
 * Schedule a debounced store update.
 * Per-store timers prevent one high-frequency store from blocking others.
 */
function scheduleStoreUpdate(
  storeName: string,
  prevState: Record<string, unknown>,
  newState: Record<string, unknown>,
  client: FloTraceWebSocketClient
): void {
  let changedKeys: string[];
  try {
    changedKeys = getChangedKeys(prevState, newState);
  } catch (error) {
    console.error(`[FloTrace] Error diffing Zustand state for "${storeName}":`, error);
    return;
  }
  if (changedKeys.length === 0) return;

  // Clear existing timer for this store
  const existing = debounceTimers.get(storeName);
  if (existing) clearTimeout(existing);

  debounceTimers.set(storeName, setTimeout(() => {
    debounceTimers.delete(storeName);
    sendStoreUpdate(storeName, newState, changedKeys, client);
  }, DEBOUNCE_MS));
}

/**
 * Serialize and send a store state snapshot via WebSocket.
 */
function sendStoreUpdate(
  storeName: string,
  state: Record<string, unknown>,
  changedKeys: string[],
  client: FloTraceWebSocketClient
): void {
  try {
    if (!client.connected) return;

    client.sendImmediate({
      type: 'runtime:zustand',
      storeName,
      state: serializeStoreState(state, `Zustand "${storeName}"`),
      changedKeys,
      correlatedRequests: buildCorrelatedRequests(state, changedKeys),
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error(`[FloTrace] Error sending Zustand update for "${storeName}":`, error);
  }
}
