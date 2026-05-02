/**
 * Typed `create<Entity>(override?)` builders for fiberTreeWalker R19 tests.
 *
 * Convention (bolt vitest-faker-utilities + vitest-dry-and-refactoring):
 *   - Builders construct real Fiber-shaped objects (not a synthetic shape) so
 *     they slot directly into the production walker and detector.
 *   - `createSyntheticFiber({...})` defaults to a FunctionComponent with no
 *     hooks, no children, no alternate — override only what each test needs.
 *   - `createHookList(states)` builds a singly-linked hook list from an array
 *     of `memoizedState` values; returns `null` for an empty array.
 *   - `createTransitionHook(isPending)` produces the `[isPending, fn]` tuple
 *     shape that `useTransition` writes into `memoizedState`.
 *   - File is `.test.builders.ts` per the per-component test-data convention
 *     (vitest-dry-and-refactoring) — co-located, scoped to this one test.
 */
import type { Fiber } from './fiberTreeWalker';

// React fiber tags (inlined for test independence — verifies they don't drift).
export const TAG = {
  FunctionComponent: 0,
  HostComponent: 5,
  Fragment: 7,
  SuspenseComponent: 13,
  OffscreenComponent: 22,
} as const;

// React Compiler memo cache sentinel (must match Symbol.for in compilerAnalyzer.ts).
export const MEMO_CACHE_SENTINEL = Symbol.for('react.memo_cache_sentinel');

/** Synthetic shape for a single hook node in a fiber's hook list. */
export interface SyntheticHook {
  memoizedState: unknown;
  next: SyntheticHook | null;
}

/** Build a singly-linked hook list from an array of memoizedState values. */
export function createHookList(states: unknown[]): SyntheticHook | null {
  if (states.length === 0) return null;
  const nodes: SyntheticHook[] = states.map((memoizedState) => ({
    memoizedState,
    next: null,
  }));
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].next = nodes[i + 1];
  return nodes[0];
}

/** Options for createSyntheticFiber. */
export interface SyntheticFiberOptions {
  tag?: number;
  name?: string;
  hookStates?: unknown[];
  child?: Fiber | null;
  sibling?: Fiber | null;
  memoizedState?: unknown;
  alternate?: Fiber | null;
}

/**
 * Build a Fiber with sensible defaults (FunctionComponent, no name, no hooks).
 * Pass `hookStates` to populate the hook list, or `memoizedState` to set it
 * directly (e.g. Suspense's dehydration marker).
 */
export function createSyntheticFiber(opts: SyntheticFiberOptions = {}): Fiber {
  const fn = function () {} as unknown as { displayName?: string };
  if (opts.name) fn.displayName = opts.name;
  return {
    tag: opts.tag ?? TAG.FunctionComponent,
    key: null,
    type: fn as unknown as Fiber['type'],
    child: opts.child ?? null,
    sibling: opts.sibling ?? null,
    return: null,
    memoizedProps: null,
    pendingProps: null,
    memoizedState:
      opts.memoizedState !== undefined
        ? (opts.memoizedState as Fiber['memoizedState'])
        : (createHookList(opts.hookStates ?? []) as Fiber['memoizedState']),
    alternate: opts.alternate ?? null,
  } as Fiber;
}

/** useTransition hook shape: [isPending: boolean, startTransition: function]. */
export function createTransitionHook(isPending: boolean): unknown[] {
  return [isPending, () => {}];
}
