/**
 * Typed `create<Entity>(override?)` builders for actionStateTracker tests.
 *
 * Convention (bolt vitest-faker-utilities + vitest-dry-and-refactoring):
 *   - Each builder accepts a `Partial<T>` override (or specific args for
 *     domain-specific shapes like the useActionState tuple) and returns a
 *     fully-populated value.
 *   - `createStubClient()` produces a recording stub of FloTraceWebSocketClient
 *     for assertions on emitted messages.
 *   - File is `.test.builders.ts` per the per-component test-data convention
 *     (vitest-dry-and-refactoring) — co-located, scoped to this one test.
 */
import type { FloTraceWebSocketClient } from './websocketClient';
import type { RuntimeMessage } from './types';
import {
  DefaultSyntheticFiber,
  type SyntheticFiber,
  type SyntheticHook,
} from './actionStateTracker.test.fixtures';

// --- Hook-list construction ---

/** Build a singly-linked hook list from an array of memoizedState values. */
export function createHookList(states: unknown[]): SyntheticHook | null {
  if (states.length === 0) return null;
  const nodes: SyntheticHook[] = states.map((memoizedState) => ({
    memoizedState,
    next: null,
  }));
  for (let i = 0; i < nodes.length - 1; i++) {
    nodes[i].next = nodes[i + 1];
  }
  return nodes[0];
}

// --- create<Entity>(override?) typed builders ---

/**
 * Builds a synthetic fiber from a `_debugHookTypes` list and matching
 * `memoizedState` values. Spread the Default baseline first so future
 * shape extensions stay backward-compatible.
 */
export function createSyntheticFiber(
  hookTypes: string[] | null | undefined,
  hookStates: unknown[],
): SyntheticFiber {
  return {
    ...DefaultSyntheticFiber,
    _debugHookTypes: hookTypes,
    memoizedState: createHookList(hookStates),
  };
}

/** Stub of FloTraceWebSocketClient that records sent messages for assertions. */
export type StubClient = FloTraceWebSocketClient & { sent: RuntimeMessage[] };

export function createStubClient(): StubClient {
  const sent: RuntimeMessage[] = [];
  const stub = {
    sent,
    send: (msg: RuntimeMessage) => sent.push(msg),
    sendImmediate: (msg: RuntimeMessage) => sent.push(msg),
    connected: true,
  };
  return stub as unknown as StubClient;
}

// --- Hook memoizedState shape builders ---

/**
 * useActionState memoizedState shape: [state, dispatch, isPending].
 * The third slot is strictly compared against `=== true` to flag pending.
 */
export function createActionState(state: unknown, isPending: boolean): unknown[] {
  return [state, () => {}, isPending];
}

/**
 * useOptimistic memoizedState shape: [optimisticValue, ...].
 * Length floor is 1 — the tracker only reads the first element.
 */
export function createOptimisticState(value: unknown): unknown[] {
  return [value, () => {}];
}
