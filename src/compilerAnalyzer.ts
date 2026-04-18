/**
 * React Compiler memoization status detection.
 * Detects whether a component has been compiled by the React Compiler,
 * uses manual React.memo(), or is unoptimized.
 *
 * React Compiler introduces a per-component memo cache stored as an array
 * in the first memoizedState slot, seeded with Symbol.for('react.memo_cache_sentinel').
 */
import type { CompilerStatus } from "./types";

/** Sentinel value React Compiler uses to mark un-cached slots */
const MEMO_CACHE_SENTINEL = Symbol.for('react.memo_cache_sentinel');

/** React fiber tags relevant to compiler analysis */
const FUNCTION_COMPONENT = 0;
const SIMPLE_MEMO = 15; // React.memo() wrapper

interface Fiber {
  tag: number;
  memoizedState: { memoizedState: unknown; next: unknown } | null;
  alternate?: Fiber | null;
  type: unknown;
}

/**
 * Detect React Compiler status for a given fiber.
 *
 * Returns:
 * - 'compiled'     — React Compiler memo cache present and active
 * - 'manual'       — Component wrapped in React.memo() (SimpleMemo fiber tag)
 * - 'unoptimized'  — Plain function component, no memo cache
 * - 'de-opted'     — Compiler cache present but all slots are sentinel (invalidated every render)
 * - undefined      — Not applicable (class component, host component, etc.)
 */
export function detectCompilerStatus(fiber: Fiber): CompilerStatus | undefined {
  // Only function components and simple-memo wrappers are relevant
  if (fiber.tag === SIMPLE_MEMO) return 'manual';
  if (fiber.tag !== FUNCTION_COMPONENT) return undefined;

  // React Compiler stores its memo cache as the FIRST hook slot value (an array)
  const firstHook = fiber.memoizedState;
  if (!firstHook) return 'unoptimized';

  const cache = firstHook.memoizedState;
  if (!Array.isArray(cache) || cache.length === 0) return 'unoptimized';

  // Check if any cache slots contain the compiler sentinel
  const hasSentinel = cache.some((v: unknown) => v === MEMO_CACHE_SENTINEL);
  if (!hasSentinel) return 'unoptimized';

  // All slots are sentinel on an already-rendered fiber → de-opted (cache never sticks)
  const allSentinel = cache.every((v: unknown) => v === MEMO_CACHE_SENTINEL);
  if (allSentinel && fiber.alternate != null) return 'de-opted';

  return 'compiled';
}
