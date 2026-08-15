/**
 * Epoch-comparable high-resolution time.
 *
 * ## Why this exists
 *
 * `cascadeAnalyzer` and `dispatchWrapper` stamped their events with
 * `performance.now()` — milliseconds since page load — while every other
 * producer used `Date.now()`. The two are not comparable, so cascades and
 * triggers could not be bucketed into route windows alongside network requests
 * and errors. Route-scoped analysis needs one clock.
 *
 * ## Why fix it here rather than in the desktop
 *
 * Correcting on receipt is wrong by an unbounded amount: the WebSocket client
 * batches with a 100ms flush, and network latency sits on top of that. The
 * offset has to be captured in the same process that took the reading.
 *
 * `TIME_ORIGIN` is computed once at module init and never re-read, so the value
 * keeps `performance.now()`'s monotonic, sub-millisecond resolution while being
 * directly comparable to `Date.now()`.
 */

/** Wall-clock epoch ms corresponding to `performance.now() === 0`. */
const TIME_ORIGIN = Date.now() - performance.now();

/**
 * Current time as epoch milliseconds, at `performance.now()` resolution.
 *
 * Prefer this over `Date.now()` anywhere the value is used for ordering or
 * duration, and over bare `performance.now()` anywhere the value crosses the
 * wire.
 */
export function nowEpochMs(): number {
  return TIME_ORIGIN + performance.now();
}

/** Exposed for tests only — NOT re-exported from index.ts. */
export function __getTimeOriginForTesting(): number {
  return TIME_ORIGIN;
}
