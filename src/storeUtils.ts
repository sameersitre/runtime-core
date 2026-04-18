/**
 * Shared utilities for state store trackers (Zustand, Redux).
 * Handles per-key serialization and API → store causal correlation.
 */

import type { SerializedValue } from './types';
import { serializeValue } from './serializer';
import { findFetchOrigin } from './fetchOriginRegistry';

/**
 * Serialize a record of state values individually.
 * Per-key try-catch ensures one bad value doesn't block the rest.
 */
export function serializeStoreState(
  state: Record<string, unknown>,
  logPrefix: string,
): Record<string, SerializedValue> {
  const serialized: Record<string, SerializedValue> = {};
  for (const [key, value] of Object.entries(state)) {
    try {
      serialized[key] = serializeValue(value);
    } catch (error) {
      console.error(`[FloTrace] Error serializing ${logPrefix} key "${key}":`, error);
      serialized[key] = { __type: 'error', value: 'Serialization failed' };
    }
  }
  return serialized;
}

/**
 * Build a `correlatedRequests` array by scanning each changed state key for a
 * WeakMap-tagged API response origin. Groups multiple keys by their requestId.
 * Returns undefined (not an empty array) when no correlations found, so callers
 * can omit the field from the message entirely.
 */
export function buildCorrelatedRequests(
  state: Record<string, unknown>,
  changedKeys: string[],
): Array<{ requestId: string; storeKeys: string[] }> | undefined {
  const byRequestId = new Map<string, string[]>();
  for (const key of changedKeys) {
    try {
      const rid = findFetchOrigin(state[key]);
      if (rid) {
        const keys = byRequestId.get(rid) ?? [];
        keys.push(key);
        byRequestId.set(rid, keys);
      }
    } catch {
      // Best-effort: state[key] may be a Proxy or have getter side effects
    }
  }
  if (byRequestId.size === 0) return undefined;
  return Array.from(byRequestId, ([requestId, storeKeys]) => ({ requestId, storeKeys }));
}
