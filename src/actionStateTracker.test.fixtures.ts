/**
 * Hand-curated `Default<Entity>` typed baselines for actionStateTracker tests.
 *
 * Convention (bolt vitest-default-dummy-data):
 *   - One `Default<Entity>` per type, exported as a named const.
 *   - Annotated with `Required<T>` so every optional field is filled — when
 *     the synthetic shape adds a field, the fixture fails to compile until
 *     updated.
 *   - Pure data, no logic. Spread into overrides via the `create<Entity>`
 *     builders in `actionStateTracker.test.builders.ts`; never mutated.
 *   - File is `.test.fixtures.ts` per the per-component test-data convention
 *     (vitest-dry-and-refactoring) — co-located, scoped to this one test.
 */

/** Synthetic shape for a single hook node in a fiber's hook list. */
export interface SyntheticHook {
  memoizedState: unknown;
  next: SyntheticHook | null;
}

/** Synthetic shape for the slice of a Fiber that actionStateTracker reads. */
export interface SyntheticFiber {
  tag: number;
  memoizedState: SyntheticHook | null;
  _debugHookTypes: string[] | null | undefined;
}

export const DefaultSyntheticHook: Required<SyntheticHook> = {
  memoizedState: undefined,
  next: null,
};

export const DefaultSyntheticFiber: Required<SyntheticFiber> = {
  tag: 0,
  memoizedState: null,
  _debugHookTypes: null,
};
