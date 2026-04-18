/**
 * Tracks useActionState and useOptimistic hook changes on React fibers.
 * Emits runtime:actionState when isPending transitions or state changes.
 * Called by fiberTreeWalker after each successful tree build.
 */
import type { FloTraceWebSocketClient } from "./websocketClient";
import type { SerializedValue } from "./types";
import { serializeValue } from "./serializer";

/** Previous snapshot of action state per nodeId to detect changes */
const prevActionStateMap = new Map<string, string>(); // nodeId → JSON snapshot

/** React 19 useActionState stores: [state, dispatch, isPending] triple in memoizedState.
 * Note: useFormStatus uses an object shape { pending, data, method, action } — incompatible
 * with this array extractor. Handle separately if useFormStatus support is needed. */
const ACTION_STATE_HOOK_NAMES = new Set(['useActionState']);
const OPTIMISTIC_HOOK_NAMES = new Set(['useOptimistic']);

interface FiberHookState {
  memoizedState: unknown;
  next: FiberHookState | null;
}

interface Fiber {
  tag: number;
  memoizedState: FiberHookState | null;
  _debugHookTypes?: string[] | null;
}

/**
 * Inspect a single fiber for useActionState / useOptimistic hooks.
 * Returns null if no relevant hooks are found.
 */
function extractActionEntries(fiber: Fiber): Array<{
  hookIndex: number;
  hookKind: 'action' | 'optimistic';
  isPending: boolean;
  state: SerializedValue;
  error?: SerializedValue;
  pendingSince?: number;
  durationMs?: number;
}> | null {
  const hookTypes = fiber._debugHookTypes;
  if (!hookTypes) return null;

  const entries: ReturnType<typeof extractActionEntries> = [];
  let hookState = fiber.memoizedState;
  let hookIdx = 0;

  for (const hookType of hookTypes) {
    if (!hookState) break;

    if (ACTION_STATE_HOOK_NAMES.has(hookType)) {
      // useActionState memoizedState structure: [state, dispatch, isPending]
      const ms = hookState.memoizedState;
      if (Array.isArray(ms) && ms.length >= 3) {
        entries.push({
          hookIndex: hookIdx,
          hookKind: 'action',
          isPending: ms[2] === true,
          state: serializeValue(ms[0]),
        });
      }
    } else if (OPTIMISTIC_HOOK_NAMES.has(hookType)) {
      // useOptimistic memoizedState: { current: [optimisticValue, actualValue] }
      // or simple [optimisticState, dispatch] tuple depending on React version
      const ms = hookState.memoizedState;
      if (Array.isArray(ms)) {
        entries.push({
          hookIndex: hookIdx,
          hookKind: 'optimistic',
          isPending: false, // optimistic values are "immediately applied"
          state: serializeValue(ms[0]),
        });
      }
    }

    hookState = hookState.next;
    hookIdx++;
  }

  return entries.length > 0 ? entries : null;
}

/**
 * Walk a fiberRefMap and emit runtime:actionState for any fiber with changed
 * useActionState / useOptimistic state since last check.
 */
export function scanActionStateChanges(
  fiberRefMap: Map<string, Fiber>,
  client: FloTraceWebSocketClient,
): void {
  try {
    for (const [nodeId, fiber] of fiberRefMap) {
      const entries = extractActionEntries(fiber);
      if (!entries) continue;

      const snapshot = JSON.stringify(entries.map(e => ({ i: e.hookIndex, p: e.isPending, s: e.state })));
      if (prevActionStateMap.get(nodeId) === snapshot) continue;
      prevActionStateMap.set(nodeId, snapshot);

      const componentName = nodeId.split('/').pop()?.replace(/-\d+$/, '') ?? 'Unknown';
      client.send({
        type: 'runtime:actionState',
        nodeId,
        componentName,
        actions: entries,
        timestamp: Date.now(),
      });
    }
  } catch {
    // Non-fatal — action state scanning is best-effort
  }
}

/** Clear cached state when the tree is reset (e.g., on disconnect) */
export function clearActionStateCache(): void {
  prevActionStateMap.clear();
}
