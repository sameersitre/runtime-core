/**
 * RSC payload fetch interceptor for Next.js App Router.
 * Patches globalThis.fetch to detect Next.js data / RSC fetch requests,
 * captures metadata (route, cache status, size), and emits runtime:rscPayload.
 *
 * Privacy guarantee: only metadata is captured (URL path, headers, size).
 * Response bodies are never read or transmitted.
 */
import type { FloTraceWebSocketClient } from "./websocketClient";

/** URL patterns that identify Next.js RSC / data fetches */
const RSC_URL_PATTERNS: RegExp[] = [
  /\?_rsc=/,           // App Router RSC param
  /\?__RSC__=/,        // Older Next.js RSC param
  /\/_next\/data\//,   // Pages Router getServerSideProps / getStaticProps
  /\/__nextjs_original-stack-frame/,
];

/** Extract cache status from response headers */
function parseCacheStatus(headers: Headers): 'HIT' | 'MISS' | 'STALE' | 'unknown' {
  const raw = headers.get('x-nextjs-cache') || headers.get('x-vercel-cache') || '';
  switch (raw.toUpperCase()) {
    case 'HIT': return 'HIT';
    case 'MISS': return 'MISS';
    case 'STALE': return 'STALE';
    default: return 'unknown';
  }
}

/** Extract the route path (without RSC query params) */
function extractRoute(url: string): string {
  try {
    const u = new URL(url, globalThis.location?.href ?? 'http://localhost');
    return u.pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

let originalFetch: typeof fetch | null = null;
let interceptorClient: FloTraceWebSocketClient | null = null;
let isInstalled = false;
/** Sentinel reference to our installed wrapper, so a sibling patch
 *  (e.g. networkTracker) tearing down between our install/uninstall doesn't
 *  cause us to overwrite the native fetch with a stale closure. */
let patchedFetchRef: typeof fetch | null = null;

/**
 * Install the RSC payload interceptor.
 * Safe to call multiple times — installs once.
 */
export function installRscPayloadInterceptor(client: FloTraceWebSocketClient): void {
  if (isInstalled || typeof globalThis.fetch !== 'function') return;
  isInstalled = true;
  interceptorClient = client;

  originalFetch = globalThis.fetch;

  const patchedFetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input
      : input instanceof URL ? input.href
      : (input as Request).url;

    // Delegate non-RSC requests immediately to avoid any overhead
    const isRscRequest = RSC_URL_PATTERNS.some(p => p.test(url));

    // Always call the original fetch — we never block requests
    const response = await originalFetch!.call(globalThis, input, init);

    if (isRscRequest && interceptorClient?.connected) {
      try {
        const sizeHeader = response.headers.get('content-length');
        const payloadSizeBytes = sizeHeader ? parseInt(sizeHeader, 10) : 0;

        interceptorClient.send({
          type: 'runtime:rscPayload',
          route: extractRoute(url),
          payloadSizeBytes: isNaN(payloadSizeBytes) ? 0 : payloadSizeBytes,
          cacheStatus: parseCacheStatus(response.headers),
          timestamp: Date.now(),
        });
      } catch {
        // Non-fatal — interception is best-effort
      }
    }

    return response;
  };

  patchedFetchRef = patchedFetch;
  globalThis.fetch = patchedFetch;
}

/** Remove the RSC payload interceptor and restore original fetch */
export function uninstallRscPayloadInterceptor(): void {
  if (!isInstalled || !originalFetch) return;
  // Only restore if our wrapper is still installed — otherwise a sibling
  // patch (networkTracker) is on top of us and we'd be stomping its install.
  if (globalThis.fetch === patchedFetchRef) {
    globalThis.fetch = originalFetch;
  }
  originalFetch = null;
  patchedFetchRef = null;
  interceptorClient = null;
  isInstalled = false;
}
