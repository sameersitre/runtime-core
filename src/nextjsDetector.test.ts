/**
 * Coverage target for nextjsDetector.ts:
 * - Statements : 100%
 * - Branches   : 100%
 * - Functions  : 100% (maybeEmitNextjsContext, detectServerComponent, resetNextjsDetection)
 *
 * Module has process-wide `detectionEmitted` state — every test calls
 * resetNextjsDetection() in beforeEach. Tests also clean any window globals
 * they set (afterEach) so they don't leak between cases.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  maybeEmitNextjsContext,
  detectServerComponent,
  resetNextjsDetection,
} from './nextjsDetector';
import type { FloTraceWebSocketClient } from './websocketClient';
import type { RuntimeMessage } from './types';

// ============================================================================
// Fixture helpers
// ============================================================================

function makeStubClient(): FloTraceWebSocketClient & { sent: RuntimeMessage[] } {
  const sent: RuntimeMessage[] = [];
  const stub = {
    sent,
    send: (msg: RuntimeMessage) => sent.push(msg),
    sendImmediate: (msg: RuntimeMessage) => sent.push(msg),
    connected: true,
  };
  return stub as unknown as FloTraceWebSocketClient & { sent: RuntimeMessage[] };
}

const NEXT_GLOBALS = ['__NEXT_DATA__', '__next_router_state_tree__', 'next'] as const;

/** Snapshot any pre-existing globals so tests can restore them */
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

// ============================================================================
// maybeEmitNextjsContext
// ============================================================================

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

  it('does not emit when no Next.js globals are present', () => {
    const client = makeStubClient();
    maybeEmitNextjsContext(client);
    expect(client.sent).toEqual([]);
  });

  it('emits when only __NEXT_DATA__ is present', () => {
    setGlobal('__NEXT_DATA__', { buildId: 'abc123', page: '/about' });
    const client = makeStubClient();
    maybeEmitNextjsContext(client);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toMatchObject({
      type: 'runtime:nextjsContext',
      detected: true,
      version: 'abc123',
      initialRoute: '/about',
      isAppRouter: false,
    });
  });

  it('emits with isAppRouter=true when __next_router_state_tree__ is present', () => {
    setGlobal('__next_router_state_tree__', { children: [] });
    const client = makeStubClient();
    maybeEmitNextjsContext(client);
    expect(client.sent).toHaveLength(1);
    expect((client.sent[0] as { isAppRouter: boolean }).isAppRouter).toBe(true);
  });

  it("emits when only `next` global is present and is non-null", () => {
    setGlobal('next', { something: true });
    const client = makeStubClient();
    maybeEmitNextjsContext(client);
    expect(client.sent).toHaveLength(1);
  });

  it('does NOT emit when `next` global is set to null (explicit null fails truthiness check)', () => {
    setGlobal('next', null);
    const client = makeStubClient();
    maybeEmitNextjsContext(client);
    expect(client.sent).toEqual([]);
  });

  it('emits exactly once across repeat calls (one-shot guard)', () => {
    setGlobal('__NEXT_DATA__', { buildId: 'b' });
    const client = makeStubClient();
    maybeEmitNextjsContext(client);
    maybeEmitNextjsContext(client);
    maybeEmitNextjsContext(client);
    expect(client.sent).toHaveLength(1);
  });

  it('resetNextjsDetection() permits a re-emit', () => {
    setGlobal('__NEXT_DATA__', { buildId: 'b' });
    const client = makeStubClient();
    maybeEmitNextjsContext(client);
    expect(client.sent).toHaveLength(1);

    resetNextjsDetection();
    maybeEmitNextjsContext(client);
    expect(client.sent).toHaveLength(2);
  });

  it('uses sendImmediate, not batched send', () => {
    setGlobal('__NEXT_DATA__', { buildId: 'b' });
    const client = makeStubClient();
    const sendImmediateSpy = vi.spyOn(client, 'sendImmediate');
    const sendSpy = vi.spyOn(client, 'send');
    maybeEmitNextjsContext(client);
    expect(sendImmediateSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('leaves version undefined when buildId is not a string', () => {
    setGlobal('__NEXT_DATA__', { buildId: 42 });
    const client = makeStubClient();
    maybeEmitNextjsContext(client);
    expect((client.sent[0] as { version?: string }).version).toBeUndefined();
  });

  it('leaves initialRoute undefined when page is not a string', () => {
    setGlobal('__NEXT_DATA__', { page: { obj: true } });
    const client = makeStubClient();
    maybeEmitNextjsContext(client);
    expect((client.sent[0] as { initialRoute?: string }).initialRoute).toBeUndefined();
  });

  it('still emits when __NEXT_DATA__ is present but throws on access (inner try/catch swallows)', () => {
    // Create a global where reading buildId throws
    Object.defineProperty(globalThis, '__NEXT_DATA__', {
      configurable: true,
      get() {
        throw new Error('access denied');
      },
    });
    const client = makeStubClient();
    expect(() => maybeEmitNextjsContext(client)).not.toThrow();
    // Detection set the flag and proceeded; outer try wrapped the whole function
    // It depends on where the throw lands. With a getter throwing on first access
    // (the `'__NEXT_DATA__' in win` check), `in` operator does NOT trigger getters,
    // so this passes the membership check but throws inside the inner try.
    // Result: detectionEmitted set true, inner try swallows, outer sendImmediate runs
    // with version/initialRoute undefined.
    expect(client.sent).toHaveLength(1);
    // Cleanup the getter
    delete (globalThis as Record<string, unknown>).__NEXT_DATA__;
  });

  it('emits when all three globals are present (any-of triggers detection)', () => {
    setGlobal('__NEXT_DATA__', { buildId: 'x' });
    setGlobal('__next_router_state_tree__', {});
    setGlobal('next', {});
    const client = makeStubClient();
    maybeEmitNextjsContext(client);
    expect(client.sent).toHaveLength(1);
    expect((client.sent[0] as { isAppRouter: boolean }).isAppRouter).toBe(true);
  });

  it('emits a numeric timestamp', () => {
    setGlobal('__NEXT_DATA__', { buildId: 'x' });
    const before = Date.now();
    const client = makeStubClient();
    maybeEmitNextjsContext(client);
    const after = Date.now();
    const ts = (client.sent[0] as { timestamp: number }).timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

// ============================================================================
// detectServerComponent
// ============================================================================

describe('detectServerComponent', () => {
  it('returns false for a fiber with no type and no debug source', () => {
    expect(detectServerComponent({ type: null })).toBe(false);
  });

  it('returns false when displayName/name do not match server reference patterns', () => {
    const type = { displayName: 'UserProfile', name: 'UserProfile' };
    expect(detectServerComponent({ type })).toBe(false);
  });

  it('returns true when displayName ends with _ServerReference', () => {
    const type = { displayName: 'getUser_ServerReference' };
    expect(detectServerComponent({ type })).toBe(true);
  });

  it('returns true when displayName starts with RSC_', () => {
    const type = { displayName: 'RSC_payload' };
    expect(detectServerComponent({ type })).toBe(true);
  });

  it('falls back to type.name when displayName is missing', () => {
    const type = { name: 'foo_ServerReference' };
    expect(detectServerComponent({ type })).toBe(true);
  });

  it('treats empty displayName/name as non-matching', () => {
    expect(detectServerComponent({ type: { displayName: '', name: '' } })).toBe(false);
  });

  it.each([
    'src/components/Foo.server.tsx',
    'src/components/Foo.server.ts',
    'src/components/Foo.server.jsx',
    'src/components/Foo.server.js',
  ])('returns true for explicit server file extension: %s', (fileName) => {
    expect(
      detectServerComponent({ type: null, _debugSource: { fileName, lineNumber: 1 } }),
    ).toBe(true);
  });

  it.each([
    '/repo/app/users/page.tsx',
    '/repo/app/users/page.jsx',
    '/repo/app/users/layout.tsx',
    '/repo/app/users/loading.tsx',
    '/repo/app/users/error.tsx',
  ])('returns true for Next.js App Router file: %s', (fileName) => {
    expect(
      detectServerComponent({ type: null, _debugSource: { fileName, lineNumber: 1 } }),
    ).toBe(true);
  });

  it('matches Windows-style backslash paths', () => {
    const fileName = String.raw`C:\repo\app\users\page.tsx`;
    expect(
      detectServerComponent({ type: null, _debugSource: { fileName, lineNumber: 1 } }),
    ).toBe(true);
  });

  it('returns false for non-app-router page files (e.g. pages/ router or src/)', () => {
    const fileName = '/repo/src/components/Button.tsx';
    expect(
      detectServerComponent({ type: null, _debugSource: { fileName, lineNumber: 1 } }),
    ).toBe(false);
  });

  it('returns false for app/ files that are NOT page/layout/loading/error', () => {
    // The patterns require a specific filename suffix — generic files don't match
    const fileName = '/repo/app/utils/helper.tsx';
    expect(
      detectServerComponent({ type: null, _debugSource: { fileName, lineNumber: 1 } }),
    ).toBe(false);
  });

  it('returns false when _debugSource is null', () => {
    expect(
      detectServerComponent({ type: null, _debugSource: null }),
    ).toBe(false);
  });

  it('returns false when _debugSource is undefined', () => {
    expect(detectServerComponent({ type: null })).toBe(false);
  });

  it('display-name match short-circuits before fileName check', () => {
    // Both could match — verify display-name path is checked first via short-circuit
    const type = { displayName: 'getUser_ServerReference' };
    const _debugSource = { fileName: '/repo/src/components/Btn.tsx', lineNumber: 1 };
    expect(detectServerComponent({ type, _debugSource })).toBe(true);
  });

  it('returns false when type is a non-object value (e.g. string for host components)', () => {
    // type is `unknown` — host fibers carry strings like 'div'. The `as FiberType | null`
    // cast makes type.displayName undefined, which falls through to ''.
    expect(detectServerComponent({ type: 'div' })).toBe(false);
  });
});
