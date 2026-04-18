/**
 * Shared WeakMap registry for API response → requestId causal correlation.
 *
 * Written by the platform-specific network tracker (`networkTracker` on web,
 * `networkTrackerNative` on React Native) when a fetch response is parsed,
 * and read by store trackers (Zustand/Redux/TanStack Query) inside their
 * synchronous subscribe callbacks so we can attribute a store mutation to
 * the fetch that produced the data.
 *
 * State lives here — in platform-agnostic core — so both the web and native
 * network trackers can write to the same registry that the analyzers read.
 */

/**
 * Tags parsed JSON response objects with their requestId.
 * WeakMap keys are held weakly — GC cleans up automatically when data is replaced.
 */
const fetchDataOrigin = new WeakMap<object, string>();

/**
 * Timestamps for when each requestId's data was tagged. findFetchOrigin() only
 * returns a match within FETCH_ORIGIN_TTL_MS to prevent stale correlations from
 * old response objects still held in the Redux/Zustand store.
 */
const requestTagTimestamps = new Map<string, number>();
const FETCH_ORIGIN_TTL_MS = 3000;

/** Tag an object and its nested children (depth ≤ 2) with the requestId. */
export function tagFetchData(obj: unknown, requestId: string, depth = 0): void {
  if (depth > 2 || obj === null || typeof obj !== 'object') return;
  fetchDataOrigin.set(obj as object, requestId);
  if (depth === 0) requestTagTimestamps.set(requestId, Date.now());
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 50); i++) tagFetchData(obj[i], requestId, depth + 1);
  } else {
    for (const val of Object.values(obj as Record<string, unknown>)) tagFetchData(val, requestId, depth + 1);
  }
}

/** Returns true if any API request's response data is currently tagged (within TTL window). */
export function hasActiveTags(): boolean {
  return requestTagTimestamps.size > 0;
}

/**
 * Clear the timestamp tag map — fetchDataOrigin (WeakMap) self-cleans via GC.
 * Called by network trackers on uninstall so stale tags don't survive into a
 * fresh session.
 */
export function clearFetchOriginTags(): void {
  requestTagTimestamps.clear();
}

/**
 * Scan an object (and nested children up to depth 2) for a WeakMap-tagged fetch origin.
 * Called by Zustand/Redux trackers synchronously in their subscribe callbacks.
 * Returns the requestId if this object was the result of a tracked fetch within the TTL
 * window, else undefined. TTL prevents stale entries from matching on later store updates
 * that reuse the same object references (immutable store pattern).
 */
export function findFetchOrigin(obj: unknown, depth = 0): string | undefined {
  if (depth > 2 || obj === null || typeof obj !== 'object') return undefined;
  const rid = fetchDataOrigin.get(obj as object);
  if (rid) {
    const tagTime = requestTagTimestamps.get(rid);
    if (tagTime && Date.now() - tagTime <= FETCH_ORIGIN_TTL_MS) return rid;
    requestTagTimestamps.delete(rid); // prune expired entry — prevent unbounded growth
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 20); i++) {
      const found = findFetchOrigin(obj[i], depth + 1);
      if (found) return found;
    }
  } else {
    for (const val of Object.values(obj as Record<string, unknown>)) {
      const found = findFetchOrigin(val, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}
