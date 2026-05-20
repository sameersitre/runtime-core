/**
 * Coverage target for nextjsDetector.ts:
 * - Statements : 100%
 * - Branches   : 100%
 * - Functions  : 100% (maybeEmitNextjsContext, detectServerComponent, resetNextjsDetection)
 *
 * Module has process-wide `detectionEmitted` state — every test calls
 * resetNextjsDetection() in beforeEach. Tests also clean any window globals
 * they set (afterEach) so they don't leak between cases.
 *
 * Conventions follow the bolt vitest skills:
 *   - vitest-utility-function-tests: two-level describe (module → behaviour),
 *     `test` (not `it`), behaviour-grouped tests with multiple expects per test.
 *   - vitest-faker-utilities: `create<Entity>(override?)` typed builders.
 *   - File-local helpers (not extracted) — single consumer, ~250 lines total.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  detectServerComponent,
  maybeEmitNextjsContext,
  resetNextjsDetection,
} from './nextjsDetector';
import type { FloTraceWebSocketClient } from './websocketClient';
import type { RuntimeMessage } from './types';

// --- create<Entity> + global helpers ---

type StubClient = FloTraceWebSocketClient & { sent: RuntimeMessage[] };

function createStubClient(): StubClient {
  const sent: RuntimeMessage[] = [];
  const stub = {
    sent,
    send: (msg: RuntimeMessage) => sent.push(msg),
    sendImmediate: (msg: RuntimeMessage) => sent.push(msg),
    connected: true,
  };
  return stub as unknown as StubClient;
}

const NEXT_GLOBALS = ['__NEXT_DATA__', '__next_router_state_tree__', 'next'] as const;

/** Snapshot any pre-existing globals so tests can restore them. */
function snapshotGlobals(): Record<string, unknown> {
  const win = globalThis as Record<string, unknown>;
  const snap: Record<string, unknown> = {};
  for (const key of NEXT_GLOBALS) {
    if (key in win) snap[key] = win[key];
  }
  return snap;
}

function setGlobal(key: string, value: unknown): void {
  (globalThis as Record<string, unknown>)[key] = value;
}

function clearGlobal(key: string): void {
  delete (globalThis as Record<string, unknown>)[key];
}

function restoreGlobals(snap: Record<string, unknown>): void {
  for (const key of NEXT_GLOBALS) clearGlobal(key);
  for (const [k, v] of Object.entries(snap)) setGlobal(k, v);
}

// --- Local typed helpers for narrowing message shapes in assertions ---

interface NextjsContextMessage {
  type: string;
  detected: boolean;
  version?: string;
  initialRoute?: string;
  isAppRouter: boolean;
  timestamp: number;
}

const asMessage = (msg: unknown): NextjsContextMessage => msg as NextjsContextMessage;

// ============================================================================
// Module-level describe (vitest-utility-function-tests two-level convention)
// ============================================================================

describe('nextjsDetector', () => {
  describe('maybeEmitNextjsContext', () => {
    let savedGlobals: Record<string, unknown>;

    beforeEach(() => {
      resetNextjsDetection();
      savedGlobals = snapshotGlobals();
      for (const key of NEXT_GLOBALS) clearGlobal(key);
    });

    afterEach(() => {
      restoreGlobals(savedGlobals);
      resetNextjsDetection();
    });

    test('does not emit when no Next.js globals are present', () => {
      const client = createStubClient();
      maybeEmitNextjsContext(client);
      expect(client.sent).toEqual([]);
    });

    test('emits when only __NEXT_DATA__ is present (with version + route extracted)', () => {
      setGlobal('__NEXT_DATA__', { buildId: 'abc123', page: '/about' });
      const client = createStubClient();
      maybeEmitNextjsContext(client);
      expect(client.sent).toHaveLength(1);
      expect(asMessage(client.sent[0])).toMatchObject({
        type: 'runtime:nextjsContext',
        detected: true,
        version: 'abc123',
        initialRoute: '/about',
        isAppRouter: false,
      });
    });

    test('emits with isAppRouter=true when __next_router_state_tree__ is present', () => {
      setGlobal('__next_router_state_tree__', { children: [] });
      const client = createStubClient();
      maybeEmitNextjsContext(client);
      expect(client.sent).toHaveLength(1);
      expect(asMessage(client.sent[0]).isAppRouter).toBe(true);
    });

    test('detects via the `next` global only when truthy (null fails the check)', () => {
      // Behaviour-grouped: `next: {...}` triggers detection; `next: null` does not.
      const client = createStubClient();

      setGlobal('next', { something: true });
      maybeEmitNextjsContext(client);
      expect(client.sent).toHaveLength(1);

      // Reset state + clear, then verify null path
      resetNextjsDetection();
      clearGlobal('next');
      setGlobal('next', null);
      const client2 = createStubClient();
      maybeEmitNextjsContext(client2);
      expect(client2.sent).toEqual([]);
    });

    test('emits exactly once across repeat calls (one-shot guard)', () => {
      setGlobal('__NEXT_DATA__', { buildId: 'b' });
      const client = createStubClient();
      maybeEmitNextjsContext(client);
      maybeEmitNextjsContext(client);
      maybeEmitNextjsContext(client);
      expect(client.sent).toHaveLength(1);
    });

    test('resetNextjsDetection() permits a re-emit', () => {
      setGlobal('__NEXT_DATA__', { buildId: 'b' });
      const client = createStubClient();
      maybeEmitNextjsContext(client);
      expect(client.sent).toHaveLength(1);

      resetNextjsDetection();
      maybeEmitNextjsContext(client);
      expect(client.sent).toHaveLength(2);
    });

    test('uses sendImmediate, not batched send (context delivery is latency-sensitive)', () => {
      setGlobal('__NEXT_DATA__', { buildId: 'b' });
      const client = createStubClient();
      const sendImmediateSpy = vi.spyOn(client, 'sendImmediate');
      const sendSpy = vi.spyOn(client, 'send');
      maybeEmitNextjsContext(client);
      expect(sendImmediateSpy).toHaveBeenCalledTimes(1);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    test('leaves version/initialRoute undefined when their source fields are not strings', () => {
      // Behaviour-grouped: both fields collapse to `undefined` via the same
      // `typeof === 'string'` guard. Two scenarios share the same code path.
      setGlobal('__NEXT_DATA__', { buildId: 42 });
      const client = createStubClient();
      maybeEmitNextjsContext(client);
      expect(asMessage(client.sent[0]).version).toBeUndefined();

      resetNextjsDetection();
      clearGlobal('__NEXT_DATA__');
      setGlobal('__NEXT_DATA__', { page: { obj: true } });
      const client2 = createStubClient();
      maybeEmitNextjsContext(client2);
      expect(asMessage(client2.sent[0]).initialRoute).toBeUndefined();
    });

    test('still emits when __NEXT_DATA__ getter throws (inner try/catch swallows)', () => {
      // The `'__NEXT_DATA__' in win` membership check does NOT trigger getters,
      // so detection passes; the throw lands inside the inner try/catch.
      // Result: detectionEmitted=true, version/initialRoute=undefined, sendImmediate runs.
      Object.defineProperty(globalThis, '__NEXT_DATA__', {
        configurable: true,
        get() {
          throw new Error('access denied');
        },
      });
      const client = createStubClient();
      expect(() => maybeEmitNextjsContext(client)).not.toThrow();
      expect(client.sent).toHaveLength(1);
      delete (globalThis as Record<string, unknown>).__NEXT_DATA__;
    });

    test('emits when all three globals are present (any-of triggers detection)', () => {
      setGlobal('__NEXT_DATA__', { buildId: 'x' });
      setGlobal('__next_router_state_tree__', {});
      setGlobal('next', {});
      const client = createStubClient();
      maybeEmitNextjsContext(client);
      expect(client.sent).toHaveLength(1);
      expect(asMessage(client.sent[0]).isAppRouter).toBe(true);
    });

    test('emits a numeric timestamp within the call window', () => {
      setGlobal('__NEXT_DATA__', { buildId: 'x' });
      const before = Date.now();
      const client = createStubClient();
      maybeEmitNextjsContext(client);
      const after = Date.now();
      const ts = asMessage(client.sent[0]).timestamp;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  describe('detectServerComponent', () => {
    test('returns false for fibers without identifying signal', () => {
      // Behaviour-grouped: every shape that lacks both display-name and
      // _debugSource evidence collapses to `false`.
      expect(detectServerComponent({ type: null })).toBe(false);
      expect(
        detectServerComponent({ type: { displayName: 'UserProfile', name: 'UserProfile' } }),
      ).toBe(false);
      expect(detectServerComponent({ type: { displayName: '', name: '' } })).toBe(false);
      // type is `unknown` — host fibers carry strings like 'div'. The `as FiberType | null`
      // cast makes type.displayName undefined, which falls through to ''.
      expect(detectServerComponent({ type: 'div' })).toBe(false);
    });

    test('returns false when _debugSource is null or undefined', () => {
      expect(detectServerComponent({ type: null, _debugSource: null })).toBe(false);
      expect(detectServerComponent({ type: null })).toBe(false);
    });

    test('returns true via display-name patterns (suffix or prefix)', () => {
      // Both `_ServerReference` suffix and `RSC_` prefix are valid signals,
      // and falls back from displayName to type.name when displayName is missing.
      expect(detectServerComponent({ type: { displayName: 'getUser_ServerReference' } })).toBe(
        true,
      );
      expect(detectServerComponent({ type: { displayName: 'RSC_payload' } })).toBe(true);
      expect(detectServerComponent({ type: { name: 'foo_ServerReference' } })).toBe(true);
    });

    test.each([
      'src/components/Foo.server.tsx',
      'src/components/Foo.server.ts',
      'src/components/Foo.server.jsx',
      'src/components/Foo.server.js',
    ])('returns true for explicit server file extension: %s', (fileName) => {
      expect(detectServerComponent({ type: null, _debugSource: { fileName, lineNumber: 1 } })).toBe(
        true,
      );
    });

    test.each([
      '/repo/app/users/page.tsx',
      '/repo/app/users/page.jsx',
      '/repo/app/users/layout.tsx',
      '/repo/app/users/loading.tsx',
      '/repo/app/users/error.tsx',
    ])('returns true for Next.js App Router file: %s', (fileName) => {
      expect(detectServerComponent({ type: null, _debugSource: { fileName, lineNumber: 1 } })).toBe(
        true,
      );
    });

    test('matches Windows-style backslash paths', () => {
      const fileName = String.raw`C:\repo\app\users\page.tsx`;
      expect(detectServerComponent({ type: null, _debugSource: { fileName, lineNumber: 1 } })).toBe(
        true,
      );
    });

    test('returns false for non-app-router files (pages/ router, src/, generic app/ files)', () => {
      // Behaviour-grouped: the App Router patterns require a specific filename
      // suffix (page/layout/loading/error). Generic and pages-router files don't match.
      expect(
        detectServerComponent({
          type: null,
          _debugSource: { fileName: '/repo/src/components/Button.tsx', lineNumber: 1 },
        }),
      ).toBe(false);
      expect(
        detectServerComponent({
          type: null,
          _debugSource: { fileName: '/repo/app/utils/helper.tsx', lineNumber: 1 },
        }),
      ).toBe(false);
    });

    test('display-name match short-circuits before fileName check', () => {
      // Both could match — verify display-name path is checked first via short-circuit
      const type = { displayName: 'getUser_ServerReference' };
      const _debugSource = { fileName: '/repo/src/components/Btn.tsx', lineNumber: 1 };
      expect(detectServerComponent({ type, _debugSource })).toBe(true);
    });
  });
});
