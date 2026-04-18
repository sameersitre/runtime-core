/**
 * Hook Inspector for @flotrace/runtime
 *
 * Walks fiber.memoizedState linked list, classifies each hook by type,
 * and serializes values for display in FloTrace.
 *
 * Hook classification uses a combination of:
 * 1. fiber._debugHookTypes (available in dev builds — most reliable)
 * 2. Shape-based inference from memoizedState structure (fallback)
 *
 * Shape heuristics (from React internals):
 * - useState/useReducer: queue !== null (has dispatch/reducer)
 * - useRef: memoizedState is { current: <value> } with single key
 * - useMemo/useCallback: memoizedState is [computedValue, deps]
 * - useEffect/useLayoutEffect: matched against effect circular list via tag bitmask
 */

import type { Fiber, FiberHookState, FiberEffect } from './fiberTreeWalker';
import type { HookInfo, HookType, SerializedValue } from './types';
import { serializeValue } from './serializer';
import { HOOK_HAS_EFFECT, HOOK_INSERTION, HOOK_LAYOUT, HOOK_PASSIVE, collectCircularList } from './fiberConstants';

/**
 * Inspect all hooks in a fiber's memoizedState linked list.
 * Returns an array of HookInfo objects with type, value, and deps.
 */
export function inspectHooks(fiber: Fiber): HookInfo[] {
  const hooks: HookInfo[] = [];
  let hookState: FiberHookState | null = fiber.memoizedState;

  // Collect effects from updateQueue for matching effect hooks
  const effects = fiber.updateQueue?.lastEffect
    ? collectCircularList(fiber.updateQueue.lastEffect)
    : [];
  let effectIndex = 0;

  // Get debug hook types if available (dev builds)
  const debugTypes = fiber._debugHookTypes ?? null;

  let index = 0;
  while (hookState) {
    try {
      const debugLabel = debugTypes?.[index] ?? undefined;
      const hookInfo = classifyHook(hookState, index, effects, effectIndex, debugLabel);
      hooks.push(hookInfo);

      // Advance effect index if this hook was classified as an effect
      if (hookInfo.type === 'useEffect' || hookInfo.type === 'useLayoutEffect' || hookInfo.type === 'useInsertionEffect') {
        effectIndex++;
      }
    } catch (error) {
      hooks.push({ index, type: 'unknown', value: { __type: 'truncated', originalType: 'error' } });
    }

    hookState = hookState.next;
    index++;
  }

  return hooks;
}

/**
 * Classify a single hook by examining its memoizedState shape.
 */
function classifyHook(
  state: FiberHookState,
  index: number,
  effects: FiberEffect[],
  effectIdx: number,
  debugLabel?: string,
): HookInfo {
  const ms = state.memoizedState;

  // If we have debug type info, use it for more reliable classification
  if (debugLabel) {
    return classifyFromDebugLabel(state, index, effects, effectIdx, debugLabel);
  }

  // Shape-based inference fallback

  // useState/useReducer: has queue with dispatch
  if (state.queue !== null) {
    const queue = state.queue;
    // useReducer uses a custom reducer; useState uses React's basicStateReducer
    const isReducer = queue.lastRenderedReducer &&
      typeof queue.lastRenderedReducer === 'function' &&
      queue.lastRenderedReducer.name !== '' &&
      queue.lastRenderedReducer.name !== 'basicStateReducer';

    return {
      index,
      type: isReducer ? 'useReducer' : 'useState',
      value: serializeValue(ms, 0, new WeakSet()),
    };
  }

  // useRef: memoizedState is { current: <value> } with exactly one key
  if (ms !== null && typeof ms === 'object' && !Array.isArray(ms) && 'current' in (ms as Record<string, unknown>)) {
    const keys = Object.keys(ms as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === 'current') {
      return {
        index,
        type: 'useRef',
        value: serializeValue((ms as { current: unknown }).current, 0, new WeakSet()),
      };
    }
  }

  // useMemo/useCallback: memoizedState is [computedValue, deps]
  if (Array.isArray(ms) && ms.length === 2 && Array.isArray(ms[1])) {
    const isCallback = typeof ms[0] === 'function';
    return {
      index,
      type: isCallback ? 'useCallback' : 'useMemo',
      value: serializeValue(ms[0], 0, new WeakSet()),
      deps: ms[1].map((d: unknown) => serializeValue(d, 0, new WeakSet())),
    };
  }

  // Effect hooks: match against effect circular list by position
  if (effectIdx < effects.length) {
    const effect = effects[effectIdx];
    // Check if this hook's memoizedState could be an effect tag
    // Effects store their tag in memoizedState for function components
    if (typeof ms === 'number' || isEffectShape(ms)) {
      const type: HookType =
        (effect.tag & HOOK_PASSIVE) !== 0 ? 'useEffect' :
        (effect.tag & HOOK_LAYOUT) !== 0 ? 'useLayoutEffect' :
        (effect.tag & HOOK_INSERTION) !== 0 ? 'useInsertionEffect' : 'useEffect';

      return {
        index,
        type,
        value: { __type: 'function', name: 'effect' } as SerializedValue,
        deps: effect.deps ? effect.deps.map((d: unknown) => serializeValue(d, 0, new WeakSet())) : undefined,
      };
    }
  }

  // useTransition: memoizedState is [boolean, startTransition]
  if (Array.isArray(ms) && ms.length === 2 && typeof ms[0] === 'boolean' && typeof ms[1] === 'function') {
    return {
      index,
      type: 'useTransition',
      value: serializeValue(ms[0], 0, new WeakSet()),
    };
  }

  // useId: memoizedState is a string starting with ":"
  if (typeof ms === 'string' && ms.startsWith(':')) {
    return {
      index,
      type: 'useId',
      value: ms,
    };
  }

  return { index, type: 'unknown', value: serializeValue(ms, 0, new WeakSet()) };
}

/**
 * Classify hook using the debug label from _debugHookTypes.
 */
function classifyFromDebugLabel(
  state: FiberHookState,
  index: number,
  effects: FiberEffect[],
  effectIdx: number,
  debugLabel: string,
): HookInfo {
  const ms = state.memoizedState;
  const normalizedLabel = debugLabel.toLowerCase().replace(/\s/g, '');

  // Map debug labels to HookType
  const labelMap: Record<string, HookType> = {
    'usestate': 'useState',
    'usereducer': 'useReducer',
    'useref': 'useRef',
    'usememo': 'useMemo',
    'usecallback': 'useCallback',
    'useeffect': 'useEffect',
    'uselayouteffect': 'useLayoutEffect',
    'useinsertioneffect': 'useInsertionEffect',
    'usecontext': 'useContext',
    'useimperativehandle': 'useImperativeHandle',
    'usedebugvalue': 'useDebugValue',
    'usetransition': 'useTransition',
    'usedeferredvalue': 'useDeferredValue',
    'useid': 'useId',
    'usesyncexternalstore': 'useSyncExternalStore',
    'useoptimistic': 'useOptimistic',
    'useformstatus': 'useFormStatus',
  };

  const hookType: HookType = labelMap[normalizedLabel] ?? 'unknown';
  const base: HookInfo = { index, type: hookType, value: serializeValue(ms, 0, new WeakSet()), debugLabel };

  // Add deps for effect hooks
  if (hookType === 'useEffect' || hookType === 'useLayoutEffect' || hookType === 'useInsertionEffect') {
    if (effectIdx < effects.length) {
      const effect = effects[effectIdx];
      base.value = { __type: 'function', name: 'effect' } as SerializedValue;
      base.deps = effect.deps ? effect.deps.map((d: unknown) => serializeValue(d, 0, new WeakSet())) : undefined;
    }
  }

  // Add deps for useMemo/useCallback
  if ((hookType === 'useMemo' || hookType === 'useCallback') && Array.isArray(ms) && ms.length === 2 && Array.isArray(ms[1])) {
    base.value = serializeValue(ms[0], 0, new WeakSet());
    base.deps = ms[1].map((d: unknown) => serializeValue(d, 0, new WeakSet()));
  }

  // Extract ref current value
  if (hookType === 'useRef' && ms !== null && typeof ms === 'object' && 'current' in (ms as Record<string, unknown>)) {
    base.value = serializeValue((ms as { current: unknown }).current, 0, new WeakSet());
  }

  return base;
}

/**
 * Check if a memoizedState value looks like an effect tag/object.
 */
function isEffectShape(ms: unknown): boolean {
  if (ms === null || ms === undefined) return false;
  if (typeof ms === 'object' && ms !== null) {
    const obj = ms as Record<string, unknown>;
    return 'tag' in obj && 'create' in obj && 'deps' in obj;
  }
  return false;
}

