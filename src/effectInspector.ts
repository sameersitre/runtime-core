/**
 * Effect Dependency Tracker for @flotrace/runtime
 *
 * Walks fiber.updateQueue.lastEffect circular linked list to extract
 * all effects (useEffect, useLayoutEffect, useInsertionEffect) with:
 * - Current and previous dependency arrays
 * - Which specific deps changed (triggering the effect)
 * - Whether the effect will run on this render
 * - Whether a cleanup function exists
 *
 * Effect tag bitmask (from React's HookFlags):
 *   HookHasEffect  = 0b0001 (1)  — effect will execute
 *   HookInsertion  = 0b0010 (2)  — useInsertionEffect
 *   HookLayout     = 0b0100 (4)  — useLayoutEffect
 *   HookPassive    = 0b1000 (8)  — useEffect
 */

import type { Fiber, FiberEffect, FiberHookState } from './fiberTreeWalker';
import type { EffectInfo, SerializedValue } from './types';
import { serializeValue } from './serializer';
import { HOOK_HAS_EFFECT, HOOK_INSERTION, HOOK_LAYOUT, HOOK_PASSIVE, collectCircularList } from './fiberConstants';

/**
 * Inspect all effects in a fiber's updateQueue.
 * Compares current deps with previous (from fiber.alternate) to detect changes.
 */
export function inspectEffects(fiber: Fiber): EffectInfo[] {
  const results: EffectInfo[] = [];
  const lastEffect = fiber.updateQueue?.lastEffect;
  if (!lastEffect) return results;

  const currEffects = collectCircularList(lastEffect);
  const prevEffects = fiber.alternate?.updateQueue?.lastEffect
    ? collectCircularList(fiber.alternate.updateQueue.lastEffect)
    : [];

  // Build a map from effect index → hook index in the memoizedState linked list
  const hookIndexMap = buildEffectToHookIndexMap(fiber, currEffects);

  for (let i = 0; i < currEffects.length; i++) {
    try {
      const curr = currEffects[i];
      const prev = prevEffects[i] ?? null;

      const type: EffectInfo['type'] =
        (curr.tag & HOOK_PASSIVE) !== 0 ? 'useEffect' :
        (curr.tag & HOOK_LAYOUT) !== 0 ? 'useLayoutEffect' :
        (curr.tag & HOOK_INSERTION) !== 0 ? 'useInsertionEffect' : 'useEffect';

      const willRun = (curr.tag & HOOK_HAS_EFFECT) !== 0;
      const changedDepIndices = diffDeps(prev?.deps ?? null, curr.deps);
      const hasCleanup = typeof curr.destroy === 'function';

      results.push({
        index: i,
        hookIndex: hookIndexMap.get(i) ?? -1,
        type,
        deps: serializeDeps(curr.deps),
        prevDeps: prev ? serializeDeps(prev.deps) : null,
        changedDepIndices,
        willRun,
        hasCleanup,
      });
    } catch (error) {
      results.push({
        index: i,
        hookIndex: -1,
        type: 'useEffect',
        deps: null,
        prevDeps: null,
        changedDepIndices: [],
        willRun: false,
        hasCleanup: false,
      });
    }
  }

  return results;
}

/**
 * Build a mapping from effect circular list index → hook linked list index.
 * This allows us to correlate an effect with its position in the hooks array.
 */
function buildEffectToHookIndexMap(fiber: Fiber, effects: FiberEffect[]): Map<number, number> {
  const map = new Map<number, number>();

  // Walk the hook linked list and match effect hooks by their memoizedState
  let hookState: FiberHookState | null = fiber.memoizedState;
  let hookIndex = 0;
  let effectIndex = 0;

  while (hookState && effectIndex < effects.length) {
    const ms = hookState.memoizedState;

    // Effect hooks have their memoizedState as the effect object or a tag number
    // We match by checking if this hook could be an effect
    if (isLikelyEffectHook(ms, hookState)) {
      map.set(effectIndex, hookIndex);
      effectIndex++;
    }

    hookState = hookState.next;
    hookIndex++;
  }

  return map;
}

/**
 * Heuristic: check if a hook state node looks like an effect hook.
 * Effect hooks have: no queue (unlike useState/useReducer) and
 * their memoizedState is either a number (tag) or an effect-like object.
 */
function isLikelyEffectHook(ms: unknown, state: FiberHookState): boolean {
  // Effect hooks don't have a queue (useState/useReducer do)
  if (state.queue !== null) return false;

  // Check for effect-like shape: { tag, create, deps, next, destroy }
  if (ms !== null && typeof ms === 'object') {
    const obj = ms as Record<string, unknown>;
    if ('tag' in obj && 'create' in obj && 'deps' in obj) return true;
  }

  return false;
}

/**
 * Compare previous and current dependency arrays.
 * Returns indices of deps that changed (using Object.is for comparison).
 */
function diffDeps(prev: unknown[] | null, curr: unknown[] | null): number[] {
  // No deps = runs every render, no specific change to report
  if (!prev || !curr) return [];

  const changed: number[] = [];
  const len = Math.max(prev.length, curr.length);

  for (let i = 0; i < len; i++) {
    if (!Object.is(prev[i], curr[i])) {
      changed.push(i);
    }
  }

  return changed;
}

/**
 * Serialize a dependency array safely.
 */
function serializeDeps(deps: unknown[] | null): SerializedValue[] | null {
  if (deps === null) return null;
  return deps.map((d) => serializeValue(d, 0, new WeakSet()));
}
