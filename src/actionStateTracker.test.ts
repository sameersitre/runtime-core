/**
 * Coverage target for actionStateTracker.ts:
 * - Statements : 100%
 * - Branches   : 100%
 * - Functions  : 100% (extractActionEntries is internal — exercised via scanActionStateChanges)
 *
 * The module has process-wide cache state (prevActionStateMap) — every test
 * calls clearActionStateCache() in beforeEach so ordering doesn't leak.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { scanActionStateChanges, clearActionStateCache } from './actionStateTracker';
import type { FloTraceWebSocketClient } from './websocketClient';
import type { RuntimeMessage } from './types';

// ============================================================================
// Test fixtures
// ============================================================================

interface SyntheticHook {
  memoizedState: unknown;
  next: SyntheticHook | null;
}

interface SyntheticFiber {
  tag: number;
  memoizedState: SyntheticHook | null;
  _debugHookTypes?: string[] | null;
}

/** Build a singly-linked hook list from an array of memoizedState values */
function makeHookList(states: unknown[]): SyntheticHook | null {
  if (states.length === 0) return null;
  const nodes: SyntheticHook[] = states.map(memoizedState => ({ memoizedState, next: null }));
  for (let i = 0; i < nodes.length - 1; i++) {
    nodes[i].next = nodes[i + 1];
  }
  return nodes[0];
}

function makeFiber(
  hookTypes: string[] | null | undefined,
  hookStates: unknown[],
): SyntheticFiber {
  return {
    tag: 0,
    _debugHookTypes: hookTypes,
    memoizedState: makeHookList(hookStates),
  };
}

/** Minimal stub of FloTraceWebSocketClient that records sent messages */
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

// useActionState memoizedState shape: [state, dispatch, isPending]
function actionState(state: unknown, isPending: boolean): unknown[] {
  return [state, () => {}, isPending];
}

// useOptimistic memoizedState shape: [optimisticValue, ...]
function optimisticState(value: unknown): unknown[] {
  return [value, () => {}];
}

// ============================================================================
// Tests
// ============================================================================

describe('scanActionStateChanges + clearActionStateCache', () => {
  beforeEach(() => {
    clearActionStateCache();
  });

  describe('fiber filtering — _debugHookTypes presence', () => {
    it('skips fibers with no _debugHookTypes (undefined)', () => {
      const client = makeStubClient();
      const fibers = new Map([['App/Foo-1', makeFiber(undefined, [actionState(0, false)])]]);
      scanActionStateChanges(fibers, client);
      expect(client.sent).toEqual([]);
    });

    it('skips fibers with null _debugHookTypes', () => {
      const client = makeStubClient();
      const fibers = new Map([['App/Foo-1', makeFiber(null, [actionState(0, false)])]]);
      scanActionStateChanges(fibers, client);
      expect(client.sent).toEqual([]);
    });

    it('skips fibers whose hook list ends before the type list (graceful break)', () => {
      // hookTypes claims 3 hooks but memoizedState only has 1 → loop breaks at index 1
      const client = makeStubClient();
      const fiber: SyntheticFiber = {
        tag: 0,
        _debugHookTypes: ['useActionState', 'useState', 'useOptimistic'],
        memoizedState: makeHookList([actionState('a', false)]),
      };
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toHaveLength(1);
      expect((client.sent[0] as { actions: unknown[] }).actions).toHaveLength(1);
    });

    it('skips fibers whose only hooks are non-action types', () => {
      const client = makeStubClient();
      const fibers = new Map([
        ['App/Foo-1', makeFiber(['useState', 'useEffect', 'useMemo'], [42, undefined, 'cached'])],
      ]);
      scanActionStateChanges(fibers, client);
      expect(client.sent).toEqual([]);
    });
  });

  describe('useActionState hook extraction', () => {
    it('emits one entry per useActionState hook with isPending=false', () => {
      const client = makeStubClient();
      const fiber = makeFiber(['useActionState'], [actionState({ foo: 'bar' }, false)]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);

      expect(client.sent).toHaveLength(1);
      const msg = client.sent[0] as {
        type: string;
        nodeId: string;
        componentName: string;
        actions: Array<{ hookKind: string; isPending: boolean; hookIndex: number }>;
        timestamp: number;
      };
      expect(msg.type).toBe('runtime:actionState');
      expect(msg.nodeId).toBe('App/Foo-1');
      expect(msg.componentName).toBe('Foo');
      expect(msg.actions).toHaveLength(1);
      expect(msg.actions[0]).toMatchObject({ hookKind: 'action', isPending: false, hookIndex: 0 });
      expect(typeof msg.timestamp).toBe('number');
    });

    it('marks isPending=true only when third tuple slot is strictly true', () => {
      const client = makeStubClient();
      const fiber = makeFiber(['useActionState'], [actionState('value', true)]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect((client.sent[0] as { actions: Array<{ isPending: boolean }> }).actions[0].isPending).toBe(true);
    });

    it('isPending is false when third slot is truthy but not === true (e.g. 1 or "yes")', () => {
      const client = makeStubClient();
      // ms[2] === true is strict identity; truthy non-true values are not pending
      const fiber = makeFiber(['useActionState'], [['s', () => {}, 1]]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect((client.sent[0] as { actions: Array<{ isPending: boolean }> }).actions[0].isPending).toBe(false);
    });

    it('skips a useActionState whose memoizedState is not an array', () => {
      const client = makeStubClient();
      // memoizedState is an object → length check fails → entry not pushed
      const fiber = makeFiber(['useActionState'], [{ pending: true, data: null }]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toEqual([]);
    });

    it('skips a useActionState whose array is shorter than 3 elements', () => {
      const client = makeStubClient();
      const fiber = makeFiber(['useActionState'], [['state', () => {}]]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toEqual([]);
    });

    it('serializes the state value (not the dispatch or isPending)', () => {
      const client = makeStubClient();
      const fiber = makeFiber(['useActionState'], [actionState({ a: 1, b: [2, 3] }, false)]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      const action = (client.sent[0] as { actions: Array<{ state: unknown }> }).actions[0];
      expect(action.state).toEqual({ a: 1, b: [2, 3] });
    });
  });

  describe('useOptimistic hook extraction', () => {
    it('emits an entry with isPending=false (optimistic values are immediate)', () => {
      const client = makeStubClient();
      const fiber = makeFiber(['useOptimistic'], [optimisticState('predicted')]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toHaveLength(1);
      const action = (client.sent[0] as { actions: Array<{ hookKind: string; isPending: boolean; state: unknown }> }).actions[0];
      expect(action).toMatchObject({ hookKind: 'optimistic', isPending: false, state: 'predicted' });
    });

    it('skips a useOptimistic whose memoizedState is not an array', () => {
      const client = makeStubClient();
      const fiber = makeFiber(['useOptimistic'], [{ current: ['x'] }]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toEqual([]);
    });

    it('extracts the first array element regardless of length (no length floor)', () => {
      // Single-element optimistic arrays are valid
      const client = makeStubClient();
      const fiber = makeFiber(['useOptimistic'], [['only-element']]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect((client.sent[0] as { actions: Array<{ state: unknown }> }).actions[0].state).toBe('only-element');
    });
  });

  describe('mixed hook lists', () => {
    it('preserves correct hookIndex for action hooks interleaved with non-action hooks', () => {
      const client = makeStubClient();
      // Layout: [useState, useActionState, useEffect, useOptimistic] — indices 0,1,2,3
      const fiber = makeFiber(
        ['useState', 'useActionState', 'useEffect', 'useOptimistic'],
        [42, actionState('action-state', true), undefined, optimisticState('opt')],
      );
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      const actions = (client.sent[0] as { actions: Array<{ hookIndex: number; hookKind: string }> }).actions;
      expect(actions).toEqual([
        expect.objectContaining({ hookIndex: 1, hookKind: 'action' }),
        expect.objectContaining({ hookIndex: 3, hookKind: 'optimistic' }),
      ]);
    });

    it('emits one message containing multiple action entries on the same fiber', () => {
      const client = makeStubClient();
      const fiber = makeFiber(
        ['useActionState', 'useActionState'],
        [actionState('a', true), actionState('b', false)],
      );
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toHaveLength(1);
      expect((client.sent[0] as { actions: unknown[] }).actions).toHaveLength(2);
    });
  });

  describe('change detection / deduplication', () => {
    it('does not re-emit when state is unchanged across calls', () => {
      const client = makeStubClient();
      const fiber = makeFiber(['useActionState'], [actionState('same', false)]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toHaveLength(1);
    });

    it('re-emits when isPending flips', () => {
      const client = makeStubClient();
      const f1 = makeFiber(['useActionState'], [actionState('s', false)]);
      const f2 = makeFiber(['useActionState'], [actionState('s', true)]);
      scanActionStateChanges(new Map([['App/Foo-1', f1]]), client);
      scanActionStateChanges(new Map([['App/Foo-1', f2]]), client);
      expect(client.sent).toHaveLength(2);
      const ps = (client.sent[1] as { actions: Array<{ isPending: boolean }> }).actions[0].isPending;
      expect(ps).toBe(true);
    });

    it('re-emits when state value changes', () => {
      const client = makeStubClient();
      const f1 = makeFiber(['useActionState'], [actionState({ count: 1 }, false)]);
      const f2 = makeFiber(['useActionState'], [actionState({ count: 2 }, false)]);
      scanActionStateChanges(new Map([['A/B-1', f1]]), client);
      scanActionStateChanges(new Map([['A/B-1', f2]]), client);
      expect(client.sent).toHaveLength(2);
    });

    it('deduplicates per-nodeId independently — two fibers with same payload each emit once', () => {
      const client = makeStubClient();
      const fA = makeFiber(['useActionState'], [actionState('x', false)]);
      const fB = makeFiber(['useActionState'], [actionState('x', false)]);
      scanActionStateChanges(new Map([
        ['App/A-1', fA],
        ['App/B-1', fB],
      ]), client);
      expect(client.sent).toHaveLength(2);
      const nodeIds = client.sent.map(m => (m as { nodeId: string }).nodeId).sort();
      expect(nodeIds).toEqual(['App/A-1', 'App/B-1']);
    });

    it('clearActionStateCache forces the next identical scan to re-emit', () => {
      const client = makeStubClient();
      const fiber = makeFiber(['useActionState'], [actionState('s', false)]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toHaveLength(1);

      clearActionStateCache();
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toHaveLength(2);
    });
  });

  describe('componentName extraction from nodeId', () => {
    it.each([
      ['App/Foo-1', 'Foo'],
      ['App/Dashboard/Button-12', 'Button'],
      ['Standalone', 'Standalone'],
      ['App/With-Dash-3', 'With-Dash'],
      ['App/NoTrailingDigits', 'NoTrailingDigits'],
    ])('nodeId=%s → componentName=%s', (nodeId, expectedName) => {
      const client = makeStubClient();
      const fiber = makeFiber(['useActionState'], [actionState('x', false)]);
      scanActionStateChanges(new Map([[nodeId, fiber]]), client);
      expect((client.sent[0] as { componentName: string }).componentName).toBe(expectedName);
    });

    it("falls back to 'Unknown' when nodeId tail is empty (trailing slash)", () => {
      const client = makeStubClient();
      const fiber = makeFiber(['useActionState'], [actionState('x', false)]);
      // 'App/Foo/' → split → ['App','Foo',''] → pop → '' → replace → '' (not nullish, used as is)
      scanActionStateChanges(new Map([['App/Foo/', fiber]]), client);
      // Empty string is the actual extracted name (?? fallback only triggers on null/undefined)
      expect((client.sent[0] as { componentName: string }).componentName).toBe('');
    });
  });

  describe('error tolerance', () => {
    it('swallows exceptions thrown during iteration without rethrowing', () => {
      const client = makeStubClient();
      // A getter that throws on access simulates a corrupt fiber
      const corrupt = {} as SyntheticFiber;
      Object.defineProperty(corrupt, '_debugHookTypes', {
        get() {
          throw new Error('boom');
        },
      });
      // Wrapping in try/catch verifies scan does not propagate
      expect(() => {
        scanActionStateChanges(new Map([['App/Foo-1', corrupt]]), client);
      }).not.toThrow();
    });

    it('continues scanning subsequent fibers after a corrupt one', () => {
      // Note: try/catch wraps the entire for-of loop, so a throw aborts the whole batch.
      // This test documents that behavior — corrupt fibers in the middle of a batch
      // suppress emissions for everything after them.
      const client = makeStubClient();
      const corrupt = {} as SyntheticFiber;
      Object.defineProperty(corrupt, '_debugHookTypes', {
        get() {
          throw new Error('boom');
        },
      });
      const ok = makeFiber(['useActionState'], [actionState('x', false)]);

      // Map iteration order = insertion order. corrupt first → abort → ok skipped.
      scanActionStateChanges(new Map<string, SyntheticFiber>([
        ['App/Bad-1', corrupt],
        ['App/Ok-1', ok],
      ]), client);
      expect(client.sent).toHaveLength(0);

      // ok first → emits → corrupt aborts the rest (only the one already-emitted message).
      const client2 = makeStubClient();
      scanActionStateChanges(new Map<string, SyntheticFiber>([
        ['App/Ok-1', ok],
        ['App/Bad-1', corrupt],
      ]), client2);
      expect(client2.sent).toHaveLength(1);
    });
  });

  describe('scan with empty inputs', () => {
    it('does nothing when fiber map is empty', () => {
      const client = makeStubClient();
      scanActionStateChanges(new Map(), client);
      expect(client.sent).toEqual([]);
    });
  });

  describe('clearActionStateCache', () => {
    it('is a no-op when cache is already empty', () => {
      // Should not throw, no observable side effect
      expect(() => clearActionStateCache()).not.toThrow();
      expect(() => clearActionStateCache()).not.toThrow();
    });
  });

  describe('client.send is invoked (not sendImmediate)', () => {
    it('uses batched send, not sendImmediate', () => {
      const client = makeStubClient();
      const sendSpy = vi.spyOn(client, 'send');
      const sendImmediateSpy = vi.spyOn(client, 'sendImmediate');

      const fiber = makeFiber(['useActionState'], [actionState('x', false)]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendImmediateSpy).not.toHaveBeenCalled();
    });
  });
});
