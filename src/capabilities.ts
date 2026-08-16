/**
 * What this runtime build can actually produce.
 *
 * The desktop cannot infer this from data alone: an empty Errors category means
 * either "no errors happened" or "this runtime is too old to report them", and
 * those deserve very different UI. Version sniffing is not an answer either —
 * users install adapters independently and a consumer can opt trackers out.
 *
 * So trackers DECLARE themselves on install and the set rides along on
 * `runtime:ready`. Read at send time rather than captured at import, because
 * reconnects re-send `runtime:ready` after trackers have come and gone.
 *
 * The mirror image of `ext:hello` (desktop -> runtime, in websocketClient.ts):
 * each side states what it understands rather than guessing at the other's
 * version.
 */

/** Capability tokens. Values are wire strings — do not rename casually. */
export type RuntimeCapability =
  'errorCapture' | 'interactionTiming' | 'routeTracking' | 'networkCapture';

const installed = new Set<RuntimeCapability>();

export function registerCapability(cap: RuntimeCapability): void {
  installed.add(cap);
}

export function unregisterCapability(cap: RuntimeCapability): void {
  installed.delete(cap);
}

/** Snapshot for the `runtime:ready` payload. Sorted so the frame is stable. */
export function getCapabilities(): RuntimeCapability[] {
  return [...installed].sort();
}

/** Test-only. */
export function __resetCapabilitiesForTesting(): void {
  installed.clear();
}
