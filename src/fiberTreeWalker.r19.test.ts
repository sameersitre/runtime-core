/**
 * Coverage target for the React-19+ additions in fiberTreeWalker.ts:
 * - detectTransitionPending — pure helper, exhaustive branch coverage
 * - walkFiber Suspense / OffscreenComponent isSuspenseFallback propagation
 * - walkFiber field assignment (compilerStatus, isServerComponent,
 *   isTransitionPending) on user-component nodes
 *
 * Both helpers are exposed via the existing __*ForTesting escape-hatch
 * pattern (see compilerAnalyzer.ts neighbours for the same idiom).
 *
 * Walker dependencies that are *not* mocked:
 *   - fiberRefMap (module cache; benign side effect — set per nodeId, never read in this test)
 *   - recordTimelineEvent (module ring buffer; benign side effect)
 *   - detectQueryObserverHashes / detectLibraryName (return undefined for empty fibers)
 *   - hasActiveTags (returns false in clean state, so scanFiberStateForOrigin is skipped)
 *
 * Conventions follow the bolt vitest skills:
 *   - vitest-utility-function-tests: two-level describe (module → behaviour),
 *     `test` (not `it`), behaviour-grouped tests with multiple expects per test.
 *   - vitest-faker-utilities: `create<Entity>(override?)` typed builders
 *     — extracted to `fiberTreeWalker.r19.test.builders.ts`.
 *   - vitest-dry-and-refactoring: setup helpers (synthetic fiber/hook builders,
 *     TAG constants, MEMO_CACHE_SENTINEL) live in a co-located `.test.builders.ts`
 *     file because the test-only setup grew past the ~50-line threshold.
 */
import { beforeEach, describe, expect, test } from 'vitest';
import {
  __detectTransitionPendingForTesting as detectTransitionPending,
  __resetWalkerFilterConfigForTesting,
  __walkFiberForTesting as walkFiber,
} from './fiberTreeWalker';
import type { Fiber } from './fiberTreeWalker';
import {
  MEMO_CACHE_SENTINEL,
  TAG,
  createSyntheticFiber,
  createTransitionHook,
  type SyntheticHook,
} from './fiberTreeWalker.r19.test.builders';

// ============================================================================
// Module-level describe (vitest-utility-function-tests two-level convention)
// ============================================================================

describe('fiberTreeWalker — R19 additions', () => {
  // ==========================================================================
  // detectTransitionPending — pure helper
  // ==========================================================================

  describe('detectTransitionPending', () => {
    test('returns false when fiber has no hooks', () => {
      expect(detectTransitionPending(createSyntheticFiber({ hookStates: [] }))).toBe(false);
    });

    test('returns true when a single useTransition has isPending=true', () => {
      expect(
        detectTransitionPending(createSyntheticFiber({ hookStates: [createTransitionHook(true)] })),
      ).toBe(true);
    });

    test('returns false when the only useTransition has isPending=false', () => {
      expect(
        detectTransitionPending(
          createSyntheticFiber({ hookStates: [createTransitionHook(false)] }),
        ),
      ).toBe(false);
    });

    test('returns true when ANY hook in the list is a pending useTransition', () => {
      // [useState, useTransition(false), useEffect, useTransition(true)]
      const fiber = createSyntheticFiber({
        hookStates: [42, createTransitionHook(false), undefined, createTransitionHook(true)],
      });
      expect(detectTransitionPending(fiber)).toBe(true);
    });

    test('returns false when all transitions are not pending', () => {
      const fiber = createSyntheticFiber({
        hookStates: [createTransitionHook(false), createTransitionHook(false), 'unrelated'],
      });
      expect(detectTransitionPending(fiber)).toBe(false);
    });

    test('rejects malformed [isPending, fn] tuple shapes', () => {
      // Behaviour-grouped: every tuple shape that doesn't match `[boolean===true, function]`
      // collapses to the same `false` result. Four scenarios share the guard.

      // Length != 2 (e.g. useActionState's 3-tuple [state, dispatch, isPending])
      expect(
        detectTransitionPending(createSyntheticFiber({ hookStates: [['s', () => {}, true]] })),
      ).toBe(false);

      // First element is not a boolean
      expect(detectTransitionPending(createSyntheticFiber({ hookStates: [[42, () => {}]] }))).toBe(
        false,
      );

      // Second element is not a function
      expect(
        detectTransitionPending(createSyntheticFiber({ hookStates: [[true, 'not-fn']] })),
      ).toBe(false);

      // Strict identity ms[0] === true: `false` is a boolean but not pending
      expect(
        detectTransitionPending(createSyntheticFiber({ hookStates: [[false, () => {}]] })),
      ).toBe(false);
    });

    test('respects the 100-iteration safety limit on a self-referential hook list', () => {
      // Build a hook whose .next loops back to itself. Without the iteration cap,
      // detectTransitionPending would hang. With the cap, it returns false.
      const looped: SyntheticHook = { memoizedState: [false, () => {}], next: null };
      looped.next = looped;
      const fiber = createSyntheticFiber({});
      (fiber as unknown as { memoizedState: SyntheticHook }).memoizedState = looped;
      // Should terminate (not throw / not hang) and return false because no entry
      // has isPending=true.
      expect(detectTransitionPending(fiber)).toBe(false);
    });

    test('returns true if a pending useTransition appears within the first 100 hooks', () => {
      const states: unknown[] = [];
      for (let i = 0; i < 50; i++) states.push(42); // padding
      states.push(createTransitionHook(true));
      expect(detectTransitionPending(createSyntheticFiber({ hookStates: states }))).toBe(true);
    });
  });

  // ==========================================================================
  // walkFiber — Suspense / Offscreen propagation
  // ==========================================================================

  describe('walkFiber — isSuspenseFallback propagation', () => {
    beforeEach(() => {
      __resetWalkerFilterConfigForTesting();
    });

    test('isSuspenseFallback flag mirrors the inSuspenseFallback parameter', () => {
      // Behaviour-grouped: caller-supplied flag governs the marker — undefined
      // by default, true when explicitly passed.
      const defaultUser = createSyntheticFiber({ name: 'Foo' });
      const defaultNodes = walkFiber(defaultUser);
      expect(defaultNodes).toHaveLength(1);
      expect(defaultNodes[0].isSuspenseFallback).toBeUndefined();

      const explicitUser = createSyntheticFiber({ name: 'Skeleton' });
      const explicitNodes = walkFiber(explicitUser, 'root', true);
      expect(explicitNodes).toHaveLength(1);
      expect(explicitNodes[0].isSuspenseFallback).toBe(true);
    });

    test('Suspense RESOLVED (memoizedState=null) walks primary content WITHOUT marking fallback', () => {
      // Tree: Suspense(memoizedState=null) → primary(Offscreen) → child(user 'Real')
      //                                                      sibling: ignored fallback
      const realChild = createSyntheticFiber({ name: 'Real' });
      const primary = createSyntheticFiber({
        tag: TAG.OffscreenComponent,
        memoizedState: null,
        child: realChild,
        sibling: createSyntheticFiber({ name: 'FallbackSkeleton' }),
      });
      const suspense = createSyntheticFiber({
        tag: TAG.SuspenseComponent,
        memoizedState: null,
        child: primary,
      });

      const nodes = walkFiber(suspense);
      // Only 'Real' should appear; 'FallbackSkeleton' must not.
      expect(nodes.map((n) => n.name)).toEqual(['Real']);
      expect(nodes[0].isSuspenseFallback).toBeUndefined();
    });

    test('Suspense FALLBACK (memoizedState!=null) walks the sibling subtree and marks isSuspenseFallback=true', () => {
      const skeleton = createSyntheticFiber({ name: 'Skeleton' });
      const primary = createSyntheticFiber({
        tag: TAG.OffscreenComponent,
        // Offscreen hidden marker — but we never walk it
        memoizedState: {} as unknown as Fiber['memoizedState'],
        child: createSyntheticFiber({ name: 'RealNeverWalked' }),
        sibling: skeleton,
      });
      const suspense = createSyntheticFiber({
        tag: TAG.SuspenseComponent,
        // any non-null = showing fallback
        memoizedState: { dehydrated: null } as unknown as Fiber['memoizedState'],
        child: primary,
      });

      const nodes = walkFiber(suspense);
      expect(nodes.map((n) => n.name)).toEqual(['Skeleton']);
      expect(nodes[0].isSuspenseFallback).toBe(true);
    });

    test('OffscreenComponent VISIBLE (memoizedState=null) walks children and preserves caller flag', () => {
      const child = createSyntheticFiber({ name: 'Visible' });
      const offscreen = createSyntheticFiber({
        tag: TAG.OffscreenComponent,
        memoizedState: null,
        child,
      });
      const nodes = walkFiber(offscreen);
      expect(nodes.map((n) => n.name)).toEqual(['Visible']);
    });

    test('OffscreenComponent HIDDEN (memoizedState!=null) skips the entire subtree', () => {
      const offscreen = createSyntheticFiber({
        tag: TAG.OffscreenComponent,
        memoizedState: {} as unknown as Fiber['memoizedState'],
        child: createSyntheticFiber({ name: 'StaleSkeleton' }),
      });
      expect(walkFiber(offscreen)).toEqual([]);
    });

    test('isSuspenseFallback flag flows down to descendants via recursion', () => {
      // User → user descendant; if outer call passes inSuspenseFallback=true, the descendant
      // should inherit the flag.
      const grandchild = createSyntheticFiber({ name: 'Inner' });
      const child = createSyntheticFiber({ name: 'Outer', child: grandchild });
      const nodes = walkFiber(child, 'root', true);
      // Outer is a user component; Inner becomes its child
      expect(nodes).toHaveLength(1);
      expect(nodes[0].name).toBe('Outer');
      expect(nodes[0].isSuspenseFallback).toBe(true);
      expect(nodes[0].children).toHaveLength(1);
      expect(nodes[0].children[0].name).toBe('Inner');
      expect(nodes[0].children[0].isSuspenseFallback).toBe(true);
    });

    test('transparent wrapper (HostComponent) preserves the caller flag', () => {
      // host(div) → user(Foo): walking from the host with inSuspenseFallback=true should
      // surface Foo with the flag set.
      const user = createSyntheticFiber({ name: 'Foo' });
      const host = createSyntheticFiber({ tag: TAG.HostComponent, child: user });
      const nodes = walkFiber(host, 'root', true);
      expect(nodes.map((n) => n.name)).toEqual(['Foo']);
      expect(nodes[0].isSuspenseFallback).toBe(true);
    });
  });

  // ==========================================================================
  // walkFiber — React 19 field assignment
  // ==========================================================================

  describe('walkFiber — React 19 field assignment on user components', () => {
    beforeEach(() => {
      __resetWalkerFilterConfigForTesting();
    });

    test('attaches isTransitionPending=true when pending; undefined otherwise', () => {
      // Behaviour-grouped: the field is set or left undefined based on
      // detectTransitionPending's result.
      const pendingUser = createSyntheticFiber({
        name: 'Pending',
        hookStates: [createTransitionHook(true)],
      });
      expect(walkFiber(pendingUser)[0].isTransitionPending).toBe(true);

      const idleUser = createSyntheticFiber({
        name: 'Idle',
        hookStates: [createTransitionHook(false)],
      });
      expect(walkFiber(idleUser)[0].isTransitionPending).toBeUndefined();
    });

    test('attaches compilerStatus reflecting compilerAnalyzer output', () => {
      // Behaviour-grouped: compiled when memo cache has mixed sentinel + value;
      // unoptimized when the first-hook value is a plain useState.
      const compiledUser = createSyntheticFiber({
        name: 'Compiled',
        hookStates: [[MEMO_CACHE_SENTINEL, 'cached']],
      });
      expect(walkFiber(compiledUser)[0].compilerStatus).toBe('compiled');

      const unoptimizedUser = createSyntheticFiber({
        name: 'Plain',
        hookStates: [42],
      });
      expect(walkFiber(unoptimizedUser)[0].compilerStatus).toBe('unoptimized');
    });

    test('attaches isServerComponent=true for RSC patterns; undefined otherwise', () => {
      // Behaviour-grouped: the RSC display-name pattern triggers the field;
      // a regular component leaves it undefined.
      const rscFn = function () {} as unknown as { displayName?: string };
      rscFn.displayName = 'getUser_ServerReference';
      const rscUser: Fiber = {
        tag: TAG.FunctionComponent,
        key: null,
        type: rscFn as unknown as Fiber['type'],
        child: null,
        sibling: null,
        return: null,
        memoizedProps: null,
        pendingProps: null,
        memoizedState: null,
      } as Fiber;
      expect(walkFiber(rscUser)[0].isServerComponent).toBe(true);

      const normalUser = createSyntheticFiber({ name: 'NormalComponent' });
      expect(walkFiber(normalUser)[0].isServerComponent).toBeUndefined();
    });
  });
});
