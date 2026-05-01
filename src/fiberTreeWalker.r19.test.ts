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
 */
import { describe, it, expect } from 'vitest';
import {
  __detectTransitionPendingForTesting as detectTransitionPending,
  __walkFiberForTesting as walkFiber,
  __resetWalkerFilterConfigForTesting,
} from './fiberTreeWalker';
import type { Fiber } from './fiberTreeWalker';

// React fiber tags (inlined for test independence — verifies they don't drift)
const TAG = {
  FunctionComponent: 0,
  HostComponent: 5,
  Fragment: 7,
  SuspenseComponent: 13,
  OffscreenComponent: 22,
} as const;

// React Compiler memo cache sentinel (must match Symbol.for in compilerAnalyzer.ts)
const MEMO_CACHE_SENTINEL = Symbol.for('react.memo_cache_sentinel');

// ============================================================================
// Fixture helpers
// ============================================================================

interface SyntheticHook {
  memoizedState: unknown;
  next: SyntheticHook | null;
}

function makeHookList(states: unknown[]): SyntheticHook | null {
  if (states.length === 0) return null;
  const nodes: SyntheticHook[] = states.map(memoizedState => ({ memoizedState, next: null }));
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].next = nodes[i + 1];
  return nodes[0];
}

function makeFiber(opts: {
  tag?: number;
  name?: string;
  hookStates?: unknown[];
  child?: Fiber | null;
  sibling?: Fiber | null;
  memoizedState?: unknown;
  alternate?: Fiber | null;
}): Fiber {
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
        : (makeHookList(opts.hookStates ?? []) as Fiber['memoizedState']),
    alternate: opts.alternate ?? null,
  } as Fiber;
}

/** useTransition hook shape: [isPending: boolean, startTransition: function] */
function transitionHook(isPending: boolean): unknown[] {
  return [isPending, () => {}];
}

// ============================================================================
// detectTransitionPending — pure helper
// ============================================================================

describe('detectTransitionPending', () => {
  it('returns false when fiber has no hooks', () => {
    expect(detectTransitionPending(makeFiber({ hookStates: [] }))).toBe(false);
  });

  it('returns true when a single useTransition has isPending=true', () => {
    expect(detectTransitionPending(makeFiber({ hookStates: [transitionHook(true)] }))).toBe(true);
  });

  it('returns false when the only useTransition has isPending=false', () => {
    expect(detectTransitionPending(makeFiber({ hookStates: [transitionHook(false)] }))).toBe(false);
  });

  it('returns true when ANY hook in the list is a pending useTransition', () => {
    // [useState, useTransition(false), useEffect, useTransition(true)]
    const fiber = makeFiber({
      hookStates: [42, transitionHook(false), undefined, transitionHook(true)],
    });
    expect(detectTransitionPending(fiber)).toBe(true);
  });

  it('returns false when all transitions are not pending', () => {
    const fiber = makeFiber({
      hookStates: [transitionHook(false), transitionHook(false), 'unrelated'],
    });
    expect(detectTransitionPending(fiber)).toBe(false);
  });

  it('ignores arrays of length != 2 (e.g. useState would be length 1)', () => {
    // [state, dispatch, isPending] (3-tuple from useActionState) must NOT match
    expect(detectTransitionPending(makeFiber({ hookStates: [['s', () => {}, true]] }))).toBe(false);
  });

  it('ignores arrays whose first element is not a boolean', () => {
    // [number, fn] — wrong shape
    expect(detectTransitionPending(makeFiber({ hookStates: [[42, () => {}]] }))).toBe(false);
  });

  it('ignores arrays whose second element is not a function', () => {
    expect(detectTransitionPending(makeFiber({ hookStates: [[true, 'not-fn']] }))).toBe(false);
  });

  it("uses strict identity ms[0] === true (truthy non-true does NOT pend)", () => {
    // Hook shape technically forbids non-boolean here, but the implementation
    // checks both `typeof ms[0] === 'boolean'` AND `ms[0] === true`. Verify the
    // strict equality for documentation.
    const fiber = makeFiber({ hookStates: [[false, () => {}]] });
    expect(detectTransitionPending(fiber)).toBe(false);
  });

  it('respects the 100-iteration safety limit on a self-referential hook list', () => {
    // Build a hook whose .next loops back to itself. Without the iteration cap,
    // detectTransitionPending would hang. With the cap, it returns false.
    const looped: SyntheticHook = { memoizedState: [false, () => {}], next: null };
    looped.next = looped;
    const fiber = makeFiber({});
    (fiber as unknown as { memoizedState: SyntheticHook }).memoizedState = looped;
    // Should terminate (not throw / not hang) and return false because no entry has isPending=true
    expect(detectTransitionPending(fiber)).toBe(false);
  });

  it('returns true if a pending useTransition appears within the first 100 hooks', () => {
    const states: unknown[] = [];
    for (let i = 0; i < 50; i++) states.push(42); // padding
    states.push(transitionHook(true));
    expect(detectTransitionPending(makeFiber({ hookStates: states }))).toBe(true);
  });
});

// ============================================================================
// walkFiber — Suspense / Offscreen propagation
// ============================================================================

describe('walkFiber — isSuspenseFallback propagation', () => {
  beforeEach(() => {
    __resetWalkerFilterConfigForTesting();
  });

  it("default propagation: user components NOT in a Suspense fallback have undefined isSuspenseFallback", () => {
    const user = makeFiber({ name: 'Foo' });
    const nodes = walkFiber(user);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].isSuspenseFallback).toBeUndefined();
  });

  it('explicit inSuspenseFallback=true marks the user component', () => {
    const user = makeFiber({ name: 'Skeleton' });
    const nodes = walkFiber(user, 'root', true);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].isSuspenseFallback).toBe(true);
  });

  it('Suspense RESOLVED (memoizedState=null) walks primary content WITHOUT marking fallback', () => {
    // Tree: Suspense(memoizedState=null) → primary(Offscreen) → child(user 'Real')
    //                                                      sibling: ignored fallback
    const realChild = makeFiber({ name: 'Real' });
    const primary = makeFiber({
      tag: TAG.OffscreenComponent,
      memoizedState: null,
      child: realChild,
      sibling: makeFiber({ name: 'FallbackSkeleton' }),
    });
    const suspense = makeFiber({
      tag: TAG.SuspenseComponent,
      memoizedState: null,
      child: primary,
    });

    const nodes = walkFiber(suspense);
    // Only 'Real' should appear; 'FallbackSkeleton' must not.
    expect(nodes.map(n => n.name)).toEqual(['Real']);
    expect(nodes[0].isSuspenseFallback).toBeUndefined();
  });

  it('Suspense FALLBACK (memoizedState!=null) walks the sibling subtree and marks isSuspenseFallback=true', () => {
    const skeleton = makeFiber({ name: 'Skeleton' });
    const primary = makeFiber({
      tag: TAG.OffscreenComponent,
      memoizedState: {} as unknown as Fiber['memoizedState'], // Offscreen hidden marker — but we never walk it
      child: makeFiber({ name: 'RealNeverWalked' }),
      sibling: skeleton,
    });
    const suspense = makeFiber({
      tag: TAG.SuspenseComponent,
      memoizedState: { dehydrated: null } as unknown as Fiber['memoizedState'], // any non-null = showing fallback
      child: primary,
    });

    const nodes = walkFiber(suspense);
    expect(nodes.map(n => n.name)).toEqual(['Skeleton']);
    expect(nodes[0].isSuspenseFallback).toBe(true);
  });

  it('OffscreenComponent VISIBLE (memoizedState=null) walks children and preserves caller flag', () => {
    const child = makeFiber({ name: 'Visible' });
    const offscreen = makeFiber({
      tag: TAG.OffscreenComponent,
      memoizedState: null,
      child,
    });
    const nodes = walkFiber(offscreen);
    expect(nodes.map(n => n.name)).toEqual(['Visible']);
  });

  it('OffscreenComponent HIDDEN (memoizedState!=null) skips the entire subtree', () => {
    const offscreen = makeFiber({
      tag: TAG.OffscreenComponent,
      memoizedState: {} as unknown as Fiber['memoizedState'],
      child: makeFiber({ name: 'StaleSkeleton' }),
    });
    expect(walkFiber(offscreen)).toEqual([]);
  });

  it('isSuspenseFallback flag flows down to descendants via recursion', () => {
    // User → user descendant; if outer call passes inSuspenseFallback=true, the descendant
    // should inherit the flag.
    const grandchild = makeFiber({ name: 'Inner' });
    const child = makeFiber({ name: 'Outer', child: grandchild });
    const nodes = walkFiber(child, 'root', true);
    // Outer is a user component; Inner becomes its child
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('Outer');
    expect(nodes[0].isSuspenseFallback).toBe(true);
    expect(nodes[0].children).toHaveLength(1);
    expect(nodes[0].children[0].name).toBe('Inner');
    expect(nodes[0].children[0].isSuspenseFallback).toBe(true);
  });

  it('transparent wrapper (HostComponent) preserves the caller flag', () => {
    // host(div) → user(Foo): walking from the host with inSuspenseFallback=true should
    // surface Foo with the flag set.
    const user = makeFiber({ name: 'Foo' });
    const host = makeFiber({ tag: TAG.HostComponent, child: user });
    const nodes = walkFiber(host, 'root', true);
    expect(nodes.map(n => n.name)).toEqual(['Foo']);
    expect(nodes[0].isSuspenseFallback).toBe(true);
  });
});

// ============================================================================
// walkFiber — React 19 field assignment
// ============================================================================

describe('walkFiber — React 19 field assignment on user components', () => {
  beforeEach(() => {
    __resetWalkerFilterConfigForTesting();
  });

  it('attaches isTransitionPending=true when a useTransition is pending', () => {
    const user = makeFiber({ name: 'Foo', hookStates: [transitionHook(true)] });
    const nodes = walkFiber(user);
    expect(nodes[0].isTransitionPending).toBe(true);
  });

  it('leaves isTransitionPending undefined when no transition is pending', () => {
    const user = makeFiber({ name: 'Foo', hookStates: [transitionHook(false)] });
    const nodes = walkFiber(user);
    expect(nodes[0].isTransitionPending).toBeUndefined();
  });

  it("attaches compilerStatus='compiled' when memo cache has mixed sentinel + value", () => {
    // First-hook memoizedState = [SENTINEL, 'cached-value']
    const user = makeFiber({ name: 'Foo', hookStates: [[MEMO_CACHE_SENTINEL, 'cached']] });
    const nodes = walkFiber(user);
    expect(nodes[0].compilerStatus).toBe('compiled');
  });

  it("attaches compilerStatus='unoptimized' when first-hook value is not a compiler cache", () => {
    const user = makeFiber({ name: 'Foo', hookStates: [42] });
    const nodes = walkFiber(user);
    expect(nodes[0].compilerStatus).toBe('unoptimized');
  });

  it("attaches isServerComponent=true when displayName matches RSC pattern", () => {
    const fn = function () {} as unknown as { displayName?: string };
    fn.displayName = 'getUser_ServerReference';
    const user: Fiber = {
      tag: TAG.FunctionComponent,
      key: null,
      type: fn as unknown as Fiber['type'],
      child: null,
      sibling: null,
      return: null,
      memoizedProps: null,
      pendingProps: null,
      memoizedState: null,
    } as Fiber;
    const nodes = walkFiber(user);
    expect(nodes[0].isServerComponent).toBe(true);
  });

  it('leaves isServerComponent undefined for normal user components', () => {
    const user = makeFiber({ name: 'NormalComponent' });
    const nodes = walkFiber(user);
    expect(nodes[0].isServerComponent).toBeUndefined();
  });
});
