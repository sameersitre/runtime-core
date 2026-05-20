/**
 * Coverage target for rscPayloadInterceptor.ts:
 * - Statements : 100%
 * - Branches   : 100%
 * - Functions  : 100% (install/uninstall + extractRoute + parseCacheStatus
 *                exercised through the wrapper)
 *
 * The module patches globalThis.fetch and keeps process-level state
 * (isInstalled, originalFetch, patchedFetchRef, interceptorClient).
 * Every test explicitly uninstalls in afterEach so the global is clean.
 *
 * Conventions follow the bolt vitest skills:
 *   - vitest-utility-function-tests: two-level describe (module → behaviour),
 *     `test` (not `it`), behaviour-grouped tests with multiple expects per test,
 *     `test.each` for parameterised input/expected rows.
 *   - vitest-faker-utilities: `create<Entity>(override?)` typed builders
 *     — extracted to `rscPayloadInterceptor.test.builders.ts`.
 *   - vitest-dry-and-refactoring: setup helpers (stub client, stub response,
 *     fetch save/restore) live in a co-located `.test.builders.ts` file
 *     because the test-only setup grew past the ~50-line threshold.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  installRscPayloadInterceptor,
  uninstallRscPayloadInterceptor,
} from './rscPayloadInterceptor';
import type { RuntimeMessage } from './types';
import {
  createStubClient,
  createStubResponse,
  restoreFetch,
  savedFetch,
  type StubResponseInit,
} from './rscPayloadInterceptor.test.builders';

// --- Local typed helpers for narrowing message shapes in assertions ---

interface RscPayloadMessage {
  type: string;
  route: string;
  payloadSizeBytes: number;
  cacheStatus: string;
  timestamp: number;
}

const asMessage = (msg: unknown): RscPayloadMessage => msg as RscPayloadMessage;

// ============================================================================
// Module-level describe (vitest-utility-function-tests two-level convention)
// ============================================================================

describe('rscPayloadInterceptor', () => {
  describe('install / uninstall lifecycle', () => {
    beforeEach(() => savedFetch());
    afterEach(() => {
      uninstallRscPayloadInterceptor();
      restoreFetch();
    });

    test('replaces globalThis.fetch on install and restores on uninstall', () => {
      // Behaviour-grouped: install/uninstall are inverses on the happy path.
      const client = createStubClient();
      const original = (async () => createStubResponse()) as typeof fetch;
      globalThis.fetch = original;

      installRscPayloadInterceptor(client);
      expect(globalThis.fetch).not.toBe(original);

      uninstallRscPayloadInterceptor();
      expect(globalThis.fetch).toBe(original);
    });

    test('is idempotent — calling install twice keeps the same wrapper', () => {
      const client = createStubClient();
      globalThis.fetch = (async () => createStubResponse()) as typeof fetch;
      installRscPayloadInterceptor(client);
      const firstWrapper = globalThis.fetch;
      installRscPayloadInterceptor(client);
      expect(globalThis.fetch).toBe(firstWrapper);
    });

    test('install + uninstall are no-ops in degenerate cases', () => {
      // Behaviour-grouped: both "fetch is not a function" and "never installed"
      // share the same defensive no-op behaviour.
      const client = createStubClient();
      (globalThis as { fetch?: unknown }).fetch = undefined;
      expect(() => installRscPayloadInterceptor(client)).not.toThrow();
      expect(() => uninstallRscPayloadInterceptor()).not.toThrow();

      // Uninstall without prior install
      expect(() => uninstallRscPayloadInterceptor()).not.toThrow();
    });

    test('does NOT restore fetch if a sibling patch is on top (chain preserved)', () => {
      const client = createStubClient();
      const original = (async () => createStubResponse()) as typeof fetch;
      globalThis.fetch = original;
      installRscPayloadInterceptor(client);

      // Sibling patch wraps our wrapper
      const ourWrapper = globalThis.fetch;
      const sibling = (async (input: RequestInfo | URL, init?: RequestInit) =>
        ourWrapper.call(globalThis, input, init)) as typeof fetch;
      globalThis.fetch = sibling;

      uninstallRscPayloadInterceptor();
      // We should NOT have stomped on the sibling
      expect(globalThis.fetch).toBe(sibling);
    });
  });

  describe('patched fetch — pass-through behaviour', () => {
    beforeEach(() => savedFetch());
    afterEach(() => {
      uninstallRscPayloadInterceptor();
      restoreFetch();
    });

    test('always calls the original fetch and returns its response', async () => {
      const expected = createStubResponse();
      const original = vi.fn(async () => expected);
      globalThis.fetch = original as unknown as typeof fetch;
      installRscPayloadInterceptor(createStubClient());

      const result = await globalThis.fetch('https://example.com/foo');
      expect(result).toBe(expected);
      expect(original).toHaveBeenCalledTimes(1);
    });

    test('does not emit for non-RSC URLs', async () => {
      const original = (async () => createStubResponse()) as typeof fetch;
      globalThis.fetch = original;
      const client = createStubClient();
      installRscPayloadInterceptor(client);

      await globalThis.fetch('https://example.com/api/users');
      expect(client.sent).toEqual([]);
    });

    test('passes the original input + init through unchanged', async () => {
      const original = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        createStubResponse(),
      );
      globalThis.fetch = original as unknown as typeof fetch;
      installRscPayloadInterceptor(createStubClient());

      const init = { method: 'POST', body: 'x' } as RequestInit;
      await globalThis.fetch('https://example.com/foo', init);
      expect(original).toHaveBeenCalledWith('https://example.com/foo', init);
    });
  });

  describe('patched fetch — RSC pattern detection', () => {
    beforeEach(() => savedFetch());
    afterEach(() => {
      uninstallRscPayloadInterceptor();
      restoreFetch();
    });

    test.each([
      'https://example.com/dashboard?_rsc=abc123',
      'https://example.com/legacy?__RSC__=xyz',
      'https://example.com/_next/data/build123/page.json',
      'https://example.com/__nextjs_original-stack-frame?file=foo',
    ])('emits runtime:rscPayload for matching URL: %s', async (url) => {
      globalThis.fetch = (async () => createStubResponse()) as typeof fetch;
      const client = createStubClient();
      installRscPayloadInterceptor(client);

      await globalThis.fetch(url);
      expect(client.sent).toHaveLength(1);
      expect(asMessage(client.sent[0]).type).toBe('runtime:rscPayload');
    });

    test('accepts URL and Request objects as input', async () => {
      // Behaviour-grouped: both URL and Request inputs route through the same
      // string-extraction path (URL toString / req.url).
      globalThis.fetch = (async () => createStubResponse()) as typeof fetch;
      const client = createStubClient();
      installRscPayloadInterceptor(client);

      await globalThis.fetch(new URL('https://example.com/x?_rsc=1'));
      await globalThis.fetch({ url: 'https://example.com/y?_rsc=1' } as Request);
      expect(client.sent).toHaveLength(2);
    });
  });

  describe('patched fetch — payload metadata', () => {
    beforeEach(() => savedFetch());
    afterEach(() => {
      uninstallRscPayloadInterceptor();
      restoreFetch();
    });

    /**
     * Installs the interceptor with a stub response, fires one matching fetch,
     * returns the emitted message. Uninstalls any previously-active interceptor
     * first because `installRscPayloadInterceptor` is idempotent — calling it
     * again with a new client otherwise leaves the OLD client wired up.
     */
    async function emitOnce(
      init: StubResponseInit,
      url = 'https://example.com/dashboard?_rsc=1',
    ): Promise<RuntimeMessage> {
      uninstallRscPayloadInterceptor();
      globalThis.fetch = (async () => createStubResponse(init)) as typeof fetch;
      const client = createStubClient();
      installRscPayloadInterceptor(client);
      await globalThis.fetch(url);
      return client.sent[0];
    }

    test('parses content-length header into payloadSizeBytes', async () => {
      const msg = asMessage(await emitOnce({ contentLength: '4096' }));
      expect(msg.payloadSizeBytes).toBe(4096);
    });

    test('falls back to 0 for missing or non-numeric content-length', async () => {
      // Behaviour-grouped: both "header absent" and "header present but NaN"
      // collapse to the same `0` fallback via the parseInt + isFinite guard.
      const missing = asMessage(await emitOnce({}));
      expect(missing.payloadSizeBytes).toBe(0);

      const nonNumeric = asMessage(await emitOnce({ contentLength: 'not-a-number' }));
      expect(nonNumeric.payloadSizeBytes).toBe(0);
    });

    test.each([
      ['HIT', 'HIT'],
      ['MISS', 'MISS'],
      ['STALE', 'STALE'],
      ['hit', 'HIT'],
      ['miss', 'MISS'],
      ['stale', 'STALE'],
    ])('parses x-nextjs-cache=%s as cacheStatus=%s', async (input, expected) => {
      const msg = asMessage(
        await emitOnce({ cacheHeader: { name: 'x-nextjs-cache', value: input } }),
      );
      expect(msg.cacheStatus).toBe(expected);
    });

    test("returns 'unknown' for unrecognized values or missing cache header", async () => {
      // Behaviour-grouped: any cache-header shape that doesn't normalise to
      // HIT/MISS/STALE collapses to the 'unknown' fallback.
      const unrecognised = asMessage(
        await emitOnce({ cacheHeader: { name: 'x-nextjs-cache', value: 'BYPASS' } }),
      );
      expect(unrecognised.cacheStatus).toBe('unknown');

      const missing = asMessage(await emitOnce({}));
      expect(missing.cacheStatus).toBe('unknown');
    });

    test('falls back to x-vercel-cache when x-nextjs-cache is absent', async () => {
      const msg = asMessage(
        await emitOnce({ cacheHeader: { name: 'x-vercel-cache', value: 'HIT' } }),
      );
      expect(msg.cacheStatus).toBe('HIT');
    });

    test('extracts pathname from the URL (handles fully-qualified and relative)', async () => {
      // Behaviour-grouped: query stripping works for both `https://...` URLs
      // (parsed via URL constructor) and `/path?...` strings (via the fallback
      // split path).
      const fullyQualified = asMessage(await emitOnce({}, 'https://example.com/dashboard?_rsc=1'));
      expect(fullyQualified.route).toBe('/dashboard');

      const relative = asMessage(await emitOnce({}, '/api/data?_rsc=1'));
      expect(relative.route).toBe('/api/data');
    });

    test('emits a numeric timestamp within the call window', async () => {
      const before = Date.now();
      const msg = asMessage(await emitOnce({}));
      const after = Date.now();
      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('patched fetch — connection gating', () => {
    beforeEach(() => savedFetch());
    afterEach(() => {
      uninstallRscPayloadInterceptor();
      restoreFetch();
    });

    test('does not emit when client.connected is false', async () => {
      globalThis.fetch = (async () => createStubResponse()) as typeof fetch;
      const client = createStubClient({ connected: false });
      installRscPayloadInterceptor(client);

      await globalThis.fetch('https://example.com/x?_rsc=1');
      expect(client.sent).toEqual([]);
    });

    test('captured wrapper still works after uninstall, but does not emit', async () => {
      // Behaviour-grouped: post-uninstall, sibling-captured wrappers still
      // pass through (closure survives) but the client gate is null → no emit.
      const original = vi.fn(async () => createStubResponse());
      globalThis.fetch = original as unknown as typeof fetch;
      const client = createStubClient();
      installRscPayloadInterceptor(client);

      const wrapperBeforeUninstall = globalThis.fetch;
      uninstallRscPayloadInterceptor();

      const result = await wrapperBeforeUninstall('https://example.com/x?_rsc=1');
      expect(result).toBeDefined();
      expect(original).toHaveBeenCalled();
      // After uninstall, interceptorClient is null → gate fails → no emit
      expect(client.sent).toEqual([]);
    });

    test('uses batched send (not sendImmediate)', async () => {
      globalThis.fetch = (async () => createStubResponse()) as typeof fetch;
      const client = createStubClient();
      const sendSpy = vi.spyOn(client, 'send');
      const sendImmediateSpy = vi.spyOn(client, 'sendImmediate');
      installRscPayloadInterceptor(client);

      await globalThis.fetch('https://example.com/x?_rsc=1');
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendImmediateSpy).not.toHaveBeenCalled();
    });
  });

  describe('patched fetch — error tolerance', () => {
    beforeEach(() => savedFetch());
    afterEach(() => {
      uninstallRscPayloadInterceptor();
      restoreFetch();
    });

    test('swallows errors in send/headers parsing without breaking the response', async () => {
      const expected = createStubResponse({ contentLength: '100' });
      globalThis.fetch = (async () => expected) as typeof fetch;
      const client = createStubClient();
      // Replace send with a thrower
      client.send = () => {
        throw new Error('send broken');
      };
      installRscPayloadInterceptor(client);

      // Wrapper must NOT propagate the error; it returns the response
      const result = await globalThis.fetch('https://example.com/x?_rsc=1');
      expect(result).toBe(expected);
    });
  });
});
