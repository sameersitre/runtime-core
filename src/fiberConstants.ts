/**
 * Shared React fiber constants and circular list utilities.
 * Used by hookInspector and effectInspector to avoid duplication.
 */

import type { FiberEffect } from './fiberTreeWalker';

// Effect tag bitmask constants (from React's HookFlags)
export const HOOK_HAS_EFFECT = 0b0001;
export const HOOK_INSERTION = 0b0010;
export const HOOK_LAYOUT = 0b0100;
export const HOOK_PASSIVE = 0b1000;

/**
 * Collect effects from a circular linked list into an array.
 * The list is: lastEffect.next → ... → lastEffect (circular).
 */
export function collectCircularList(lastEffect: FiberEffect): FiberEffect[] {
  const list: FiberEffect[] = [];
  let effect: FiberEffect | null = lastEffect.next;
  if (!effect) return list;

  do {
    list.push(effect!);
    effect = effect!.next;
  } while (effect && effect !== lastEffect.next);

  return list;
}
