/**
 * Coverage target for actionStateTracker.ts:
 * - Statements : 100%
 * - Branches   : 100%
 * - Functions  : 100% (extractActionEntries is internal — exercised via scanActionStateChanges)
 *
 * The module has process-wide cache state (prevActionStateMap) — every test
 * calls clearActionStateCache() in beforeEach so ordering doesn't leak.
 *
 * Conventions follow the bolt vitest skills:
 *   - vitest-utility-function-tests: two-level describe (module → behaviour),
 *     `test` (not `it`), behaviour-grouped tests with multiple expects per test,
 *     `test.each` for parameterised input/expected rows.
 *   - vitest-default-dummy-data: `Default<Entity>` typed baselines annotated
 *     with `Required<T>` — extracted to `actionStateTracker.test.fixtures.ts`.
 *   - vitest-faker-utilities: `create<Entity>(override?)` typed builders
 *     — extracted to `actionStateTracker.test.builders.ts`.
 *   - vitest-dry-and-refactoring: per-component test data lives in co-located
 *     `*.test.fixtures.ts` / `*.test.builders.ts` files (test-only, scoped to
 *     this one test file).
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { clearActionStateCache, scanActionStateChanges } from './actionStateTracker';
import type { SyntheticFiber } from './actionStateTracker.test.fixtures';
import {
  createActionState,
  createOptimisticState,
  createStubClient,
  createSyntheticFiber,
} from './actionStateTracker.test.builders';

// --- Local typed helpers for narrowing message shapes in assertions ---

interface ActionEntry {
  hookKind: 'action' | 'optimistic';
  isPending: boolean;
  hookIndex: number;
  state?: unknown;
}

interface ActionStateMessage {
  type: string;
  nodeId: string;
  componentName: string;
  actions: ActionEntry[];
  timestamp: number;
}

const asMessage = (msg: unknown): ActionStateMessage => msg as ActionStateMessage;

// ============================================================================
// Module-level describe (vitest-utility-function-tests two-level convention)
// ============================================================================

describe('actionStateTracker', () => {
  beforeEach(() => {
    clearActionStateCache();
  });

  describe('fiber filtering — _debugHookTypes presence', () => {
    test('skips fibers when _debugHookTypes is missing or only declares non-action types', () => {
      // Behaviour-grouped: every shape that the filter rejects collapses to
      // "no message emitted" — undefined types, null types, no action hooks.
      const client = createStubClient();
      scanActionStateChanges(
        new Map([['App/Undef-1', createSyntheticFiber(undefined, [createActionState(0, false)])]]),
        client,
      );
      scanActionStateChanges(
        new Map([['App/Null-1', createSyntheticFiber(null, [createActionState(0, false)])]]),
        client,
      );
      scanActionStateChanges(
        new Map([
          [
            'App/NoAction-1',
            createSyntheticFiber(['useState', 'useEffect', 'useMemo'], [42, undefined, 'cached']),
          ],
        ]),
        client,
      );
      expect(client.sent).toEqual([]);
    });

    test('breaks gracefully when hook list ends before the type list', () => {
      // hookTypes claims 3 hooks but memoizedState only has 1 → loop breaks at index 1
      const client = createStubClient();
      const fiber = createSyntheticFiber(
        ['useActionState', 'useState', 'useOptimistic'],
        [createActionState('a', false)],
      );
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toHaveLength(1);
      expect(asMessage(client.sent[0]).actions).toHaveLength(1);
    });
  });

  describe('useActionState hook extraction', () => {
    test('emits a runtime:actionState message with the correct envelope', () => {
      const client = createStubClient();
      const fiber = createSyntheticFiber(
        ['useActionState'],
        [createActionState({ foo: 'bar' }, false)],
      );
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);

      expect(client.sent).toHaveLength(1);
      const msg = asMessage(client.sent[0]);
      expect(msg.type).toBe('runtime:actionState');
      expect(msg.nodeId).toBe('App/Foo-1');
      expect(msg.componentName).toBe('Foo');
      expect(msg.actions).toHaveLength(1);
      expect(msg.actions[0]).toMatchObject({
        hookKind: 'action',
        isPending: false,
        hookIndex: 0,
      });
      expect(typeof msg.timestamp).toBe('number');
    });

    test.each([
      [createActionState('s', true), true, 'strictly true'],
      [createActionState('s', false), false, 'false'],
      [['s', () => {}, 1], false, 'truthy non-true (1)'],
      [['s', () => {}, 'yes'], false, 'truthy non-true ("yes")'],
    ])(
      'isPending detection uses strict === true: %#-th-slot=%s → isPending=%s (%s)',
      (memoizedState, expected) => {
        const client = createStubClient();
        const fiber = createSyntheticFiber(['useActionState'], [memoizedState]);
        scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
        expect(asMessage(client.sent[0]).actions[0].isPending).toBe(expected);
      },
    );

    test('skips a useActionState whose memoizedState is not an array of length >= 3', () => {
      // Behaviour-grouped: both non-array shape and short-array shape fail the
      // same length+isArray guard — collapse to a single test.
      const objectShape = createSyntheticFiber(['useActionState'], [{ pending: true, data: null }]);
      const shortArrayShape = createSyntheticFiber(['useActionState'], [['state', () => {}]]);

      const client = createStubClient();
      scanActionStateChanges(new Map([['App/Obj-1', objectShape]]), client);
      scanActionStateChanges(new Map([['App/Short-1', shortArrayShape]]), client);
      expect(client.sent).toEqual([]);
    });

    test('serializes the state value (not the dispatch or isPending)', () => {
      const client = createStubClient();
      const fiber = createSyntheticFiber(
        ['useActionState'],
        [createActionState({ a: 1, b: [2, 3] }, false)],
      );
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(asMessage(client.sent[0]).actions[0].state).toEqual({ a: 1, b: [2, 3] });
    });
  });

  describe('useOptimistic hook extraction', () => {
    test('emits an entry with isPending=false (optimistic values are immediate)', () => {
      const client = createStubClient();
      const fiber = createSyntheticFiber(['useOptimistic'], [createOptimisticState('predicted')]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toHaveLength(1);
      expect(asMessage(client.sent[0]).actions[0]).toMatchObject({
        hookKind: 'optimistic',
        isPending: false,
        state: 'predicted',
      });
    });

    test('skips a useOptimistic whose memoizedState is not an array', () => {
      const client = createStubClient();
      const fiber = createSyntheticFiber(['useOptimistic'], [{ current: ['x'] }]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toEqual([]);
    });

    test('extracts the first array element regardless of length (no length floor)', () => {
      // Single-element optimistic arrays are valid
      const client = createStubClient();
      const fiber = createSyntheticFiber(['useOptimistic'], [['only-element']]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(asMessage(client.sent[0]).actions[0].state).toBe('only-element');
    });
  });

  describe('mixed hook lists', () => {
    test('preserves correct hookIndex for action hooks interleaved with non-action hooks', () => {
      const client = createStubClient();
      // Layout: [useState, useActionState, useEffect, useOptimistic] — indices 0,1,2,3
      const fiber = createSyntheticFiber(
        ['useState', 'useActionState', 'useEffect', 'useOptimistic'],
        [42, createActionState('action-state', true), undefined, createOptimisticState('opt')],
      );
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(asMessage(client.sent[0]).actions).toEqual([
        expect.objectContaining({ hookIndex: 1, hookKind: 'action' }),
        expect.objectContaining({ hookIndex: 3, hookKind: 'optimistic' }),
      ]);
    });

    test('emits one message containing multiple action entries on the same fiber', () => {
      const client = createStubClient();
      const fiber = createSyntheticFiber(
        ['useActionState', 'useActionState'],
        [createActionState('a', true), createActionState('b', false)],
      );
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toHaveLength(1);
      expect(asMessage(client.sent[0]).actions).toHaveLength(2);
    });
  });

  describe('change detection / deduplication', () => {
    test('does not re-emit when state is unchanged across calls', () => {
      const client = createStubClient();
      const fiber = createSyntheticFiber(['useActionState'], [createActionState('same', false)]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toHaveLength(1);
    });

    test('re-emits when isPending flips or state value changes', () => {
      // Behaviour-grouped: any field that is part of the cache key triggers
      // a re-emit. Two scenarios — pending flip + state change — share the
      // same code path.
      const client = createStubClient();
      const before = createSyntheticFiber(['useActionState'], [createActionState('s', false)]);
      const afterPending = createSyntheticFiber(['useActionState'], [createActionState('s', true)]);
      scanActionStateChanges(new Map([['App/Pending-1', before]]), client);
      scanActionStateChanges(new Map([['App/Pending-1', afterPending]]), client);
      expect(asMessage(client.sent[1]).actions[0].isPending).toBe(true);

      const v1 = createSyntheticFiber(['useActionState'], [createActionState({ count: 1 }, false)]);
      const v2 = createSyntheticFiber(['useActionState'], [createActionState({ count: 2 }, false)]);
      scanActionStateChanges(new Map([['App/Value-1', v1]]), client);
      scanActionStateChanges(new Map([['App/Value-1', v2]]), client);
      expect(client.sent).toHaveLength(4); // 2 from pending block + 2 from value block
    });

    test('deduplicates per-nodeId independently — two fibers with same payload each emit once', () => {
      const client = createStubClient();
      const fA = createSyntheticFiber(['useActionState'], [createActionState('x', false)]);
      const fB = createSyntheticFiber(['useActionState'], [createActionState('x', false)]);
      scanActionStateChanges(
        new Map([
          ['App/A-1', fA],
          ['App/B-1', fB],
        ]),
        client,
      );
      expect(client.sent).toHaveLength(2);
      expect(client.sent.map((m) => asMessage(m).nodeId).sort()).toEqual(['App/A-1', 'App/B-1']);
    });

    test('clearActionStateCache forces the next identical scan to re-emit', () => {
      const client = createStubClient();
      const fiber = createSyntheticFiber(['useActionState'], [createActionState('s', false)]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toHaveLength(1);

      clearActionStateCache();
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);
      expect(client.sent).toHaveLength(2);
    });
  });

  describe('componentName extraction from nodeId', () => {
    test.each([
      ['App/Foo-1', 'Foo'],
      ['App/Dashboard/Button-12', 'Button'],
      ['Standalone', 'Standalone'],
      ['App/With-Dash-3', 'With-Dash'],
      ['App/NoTrailingDigits', 'NoTrailingDigits'],
    ])('nodeId=%s → componentName=%s', (nodeId, expectedName) => {
      const client = createStubClient();
      const fiber = createSyntheticFiber(['useActionState'], [createActionState('x', false)]);
      scanActionStateChanges(new Map([[nodeId, fiber]]), client);
      expect(asMessage(client.sent[0]).componentName).toBe(expectedName);
    });

    test("falls back to '' when nodeId tail is empty (trailing slash)", () => {
      // 'App/Foo/' → split → ['App','Foo',''] → pop → '' → replace → ''
      // Empty string is the actual extracted name (?? fallback only triggers on null/undefined).
      const client = createStubClient();
      const fiber = createSyntheticFiber(['useActionState'], [createActionState('x', false)]);
      scanActionStateChanges(new Map([['App/Foo/', fiber]]), client);
      expect(asMessage(client.sent[0]).componentName).toBe('');
    });
  });

  describe('error tolerance', () => {
    /** Builds a fiber whose `_debugHookTypes` getter throws — simulates corruption. */
    const createCorruptFiber = (): SyntheticFiber => {
      const corrupt = {} as SyntheticFiber;
      Object.defineProperty(corrupt, '_debugHookTypes', {
        get() {
          throw new Error('boom');
        },
      });
      return corrupt;
    };

    test('swallows exceptions thrown during iteration without rethrowing', () => {
      const client = createStubClient();
      const corrupt = createCorruptFiber();
      expect(() => {
        scanActionStateChanges(new Map([['App/Foo-1', corrupt]]), client);
      }).not.toThrow();
    });

    test('aborts the rest of the batch after a corrupt fiber (try/catch wraps the for-of)', () => {
      // Documents the current behaviour: try/catch wraps the entire for-of loop,
      // so a throw aborts the whole batch. Tests both orderings:
      //  - corrupt-first → emits 0 (ok-fiber after never reached)
      //  - ok-first      → emits 1 (corrupt aborts only what's after it)
      const ok = createSyntheticFiber(['useActionState'], [createActionState('x', false)]);

      const corruptFirst = createStubClient();
      scanActionStateChanges(
        new Map<string, SyntheticFiber>([
          ['App/Bad-1', createCorruptFiber()],
          ['App/Ok-1', ok],
        ]),
        corruptFirst,
      );
      expect(corruptFirst.sent).toHaveLength(0);

      const okFirst = createStubClient();
      scanActionStateChanges(
        new Map<string, SyntheticFiber>([
          ['App/Ok-1', ok],
          ['App/Bad-1', createCorruptFiber()],
        ]),
        okFirst,
      );
      expect(okFirst.sent).toHaveLength(1);
    });
  });

  describe('scan with empty inputs', () => {
    test('does nothing when fiber map is empty', () => {
      const client = createStubClient();
      scanActionStateChanges(new Map(), client);
      expect(client.sent).toEqual([]);
    });
  });

  describe('clearActionStateCache', () => {
    test('is idempotent — repeated calls on an empty cache do not throw', () => {
      expect(() => clearActionStateCache()).not.toThrow();
      expect(() => clearActionStateCache()).not.toThrow();
    });
  });

  describe('client transport — uses batched send, not sendImmediate', () => {
    test('action-state updates fan out via send() (batched, channel-friendly)', () => {
      const client = createStubClient();
      const sendSpy = vi.spyOn(client, 'send');
      const sendImmediateSpy = vi.spyOn(client, 'sendImmediate');

      const fiber = createSyntheticFiber(['useActionState'], [createActionState('x', false)]);
      scanActionStateChanges(new Map([['App/Foo-1', fiber]]), client);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(sendImmediateSpy).not.toHaveBeenCalled();
    });
  });
});
