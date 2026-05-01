/**
 * Typed `create<Entity>(override?)` builders + lifecycle helpers for
 * rscPayloadInterceptor tests.
 *
 * Convention (bolt vitest-faker-utilities + vitest-dry-and-refactoring):
 *   - `createStubClient(overrides?)` produces a recording stub of
 *     FloTraceWebSocketClient with assertions on emitted messages.
 *   - `createStubResponse(init?)` produces a minimal Response with a
 *     case-insensitive headers shim — enough for the interceptor's reads.
 *   - `savedFetch()` / `restoreFetch()` capture and reinstate the original
 *     `globalThis.fetch` so install/uninstall tests don't leak.
 *   - File is `.test.builders.ts` per the per-component test-data convention
 *     (vitest-dry-and-refactoring) — co-located, scoped to this one test.
 */
import type { FloTraceWebSocketClient } from './websocketClient';
import type { RuntimeMessage } from './types';

// --- Stub client ---

export type StubClient = FloTraceWebSocketClient & { sent: RuntimeMessage[] };

const DefaultStubClientOverrides: { connected: boolean } = {
  connected: true,
};

export function createStubClient(
  overrides: Partial<{ connected: boolean }> = {},
): StubClient {
  const sent: RuntimeMessage[] = [];
  const stub = {
    sent,
    send: (msg: RuntimeMessage) => sent.push(msg),
    sendImmediate: (msg: RuntimeMessage) => sent.push(msg),
    connected: overrides.connected ?? DefaultStubClientOverrides.connected,
  };
  return stub as unknown as StubClient;
}

// --- Stub response ---

export interface StubResponseInit {
  contentLength?: string | null;
  cacheHeader?: { name?: string; value?: string };
}

/** Build a Response stub with a case-insensitive `headers.get` shim. */
export function createStubResponse(init: StubResponseInit = {}): Response {
  const map = new Map<string, string>();
  if (init.contentLength != null) map.set('content-length', init.contentLength);
  if (init.cacheHeader?.name && init.cacheHeader.value !== undefined) {
    map.set(init.cacheHeader.name, init.cacheHeader.value);
  }
  const headers = {
    get(name: string): string | null {
      return map.get(name.toLowerCase()) ?? null;
    },
  } as unknown as Headers;
  return { headers } as Response;
}

// --- Fetch save/restore lifecycle ---

let originalFetchBackup: typeof globalThis.fetch | undefined;

export function savedFetch(): void {
  originalFetchBackup = globalThis.fetch;
}

export function restoreFetch(): void {
  if (originalFetchBackup === undefined) {
    delete (globalThis as { fetch?: unknown }).fetch;
  } else {
    globalThis.fetch = originalFetchBackup;
  }
  originalFetchBackup = undefined;
}
