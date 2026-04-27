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
 * Timestamps for when each requestId's data was tagged. The default TTL gate
 * in `findFetchOrigin` rejects matches older than FETCH_ORIGIN_TTL_MS to keep
 * the live network panel's API → Store correlation from mis-attributing later
 * unrelated mutations to old fetches. Callers that want the causal origin
 * regardless of age (e.g. value-lineage resolver) pass `{ ignoreTTL: true }`.
 */
const requestTagTimestamps = new Map<string, number>();
const FETCH_ORIGIN_TTL_MS = 3000;

/**
 * Recursion depth ceiling for both tagging and lookup. Symmetric on purpose:
 * `tagFetchData` only writes down to this depth, so `findFetchOrigin` can't
 * usefully read deeper. Bumped from 2 → 4 to cover common API shapes like
 * `{ data: { items: [{...}] } }` that pin user values 4 levels below the
 * response root.
 */
const FETCH_ORIGIN_SCAN_DEPTH = 4;

/**
 * Per-array iteration caps. Asymmetric on purpose — tagging happens once per
 * fetch response (cheap to be generous) while scanning runs on every tracked
 * store mutation (hot path, keep tight). Both sample at the array head.
 */
const FETCH_ORIGIN_TAG_ARRAY_LIMIT = 50;
const FETCH_ORIGIN_SCAN_ARRAY_LIMIT = 20;

/** Tag an object and its nested children (depth ≤ FETCH_ORIGIN_SCAN_DEPTH) with the requestId. */
export function tagFetchData(obj: unknown, requestId: string, depth = 0): void {
  if (depth > FETCH_ORIGIN_SCAN_DEPTH || obj === null || typeof obj !== 'object') return;
  fetchDataOrigin.set(obj as object, requestId);
  if (depth === 0) requestTagTimestamps.set(requestId, Date.now());
  if (Array.isArray(obj)) {
    const limit = Math.min(obj.length, FETCH_ORIGIN_TAG_ARRAY_LIMIT);
    for (let i = 0; i < limit; i++) tagFetchData(obj[i], requestId, depth + 1);
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
 * Scan an object (and nested children up to FETCH_ORIGIN_SCAN_DEPTH) for a
 * WeakMap-tagged fetch origin. Returns the requestId if this object was the
 * result of a tracked fetch, else undefined.
 *
 * By default the result must be within FETCH_ORIGIN_TTL_MS of the original
 * fetch. Network-panel features (live API → Store correlation in
 * `storeUtils.buildCorrelatedRequests`, `tanstackQueryTracker.updateQueryTracking`,
 * `fiberTreeWalker.scanFiberStateForOrigin`) rely on this gate to avoid
 * mis-attributing later mutations.
 *
 * Pass `{ ignoreTTL: true }` to bypass the gate. Used by the value-lineage
 * resolver, which wants the *causal* origin regardless of how long ago the
 * fetch resolved (the trace UI displays an "expired" hint for old origins).
 */
export function findFetchOrigin(
  obj: unknown,
  options?: { ignoreTTL?: boolean },
): string | undefined {
  return scanForOrigin(obj, 0, options?.ignoreTTL === true);
}

/** Internal recursive scan — depth is module-private, never an external knob. */
function scanForOrigin(obj: unknown, depth: number, ignoreTTL: boolean): string | undefined {
  if (depth > FETCH_ORIGIN_SCAN_DEPTH || obj === null || typeof obj !== 'object') return undefined;

  // --- Direct hit on this object ---
  const rid = fetchDataOrigin.get(obj as object);
  if (rid) {
    if (ignoreTTL) return rid;
    const tagTime = requestTagTimestamps.get(rid);
    if (tagTime && Date.now() - tagTime <= FETCH_ORIGIN_TTL_MS) return rid;
    // Prune expired entry so the timestamp map stays bounded. Skipped on the
    // ignoreTTL path because the resolver call would otherwise wipe entries
    // that the next TTL-respecting caller still needs.
    requestTagTimestamps.delete(rid);
  }

  // --- Recurse into children ---
  if (Array.isArray(obj)) {
    const limit = Math.min(obj.length, FETCH_ORIGIN_SCAN_ARRAY_LIMIT);
    for (let i = 0; i < limit; i++) {
      const found = scanForOrigin(obj[i], depth + 1, ignoreTTL);
      if (found) return found;
    }
    return undefined;
  }

  for (const val of Object.values(obj as Record<string, unknown>)) {
    const found = scanForOrigin(val, depth + 1, ignoreTTL);
    if (found) return found;
  }
  return undefined;
}
