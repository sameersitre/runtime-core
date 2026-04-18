/**
 * Cascade Analyzer — walks the committed fiber tree to classify every re-render
 * and build a CascadeRecord describing the full blast radius of a React commit.
 *
 * Called from fiberTreeWalker after each onCommitFiberRoot, after dispatch
 * wrappers have already recorded trigger records.
 *
 * Classification logic (per fiber):
 *   state-update    — fiber has pending updates in its queue (own state changed)
 *   context-update  — fiber.dependencies changed (context consumer re-rendered)
 *   props-changed   — parent re-rendered and memoizedProps actually differ from alternate
 *   parent-cascade  — parent re-rendered but props are shallowly equal (avoidable)
 *   force-update    — ForceUpdate flag set on fiber
 *   bailed-out      — Memo / sCU prevented re-render (fiber.alternate exists, no re-render)
 *
 * Performance budget: < 2ms for 500 fibers (single O(n) walk, no recursion stack overflow).
 */

import type { CascadeRecord, CascadeNode, CascadeReason, TriggerRecord } from './types';
import { classifyLanes, getFinishedLanes } from './laneDetector';
import { getFiberDisplayName } from './fiberUtils';

// React fiber flags — from ReactFiberFlags.js (React 18)
const PerformedWork   = 0b0000000000000000000000000000001;
const ForceUpdateFlag = 0b0000000000000000000000100000000; // React 18 bit

// React fiber tags
const FunctionComponent  = 0;
const ClassComponent     = 1;
const ForwardRef         = 11;
const MemoComponent      = 14;
const SimpleMemoComponent = 15;

const USER_TAGS = new Set([FunctionComponent, ClassComponent, ForwardRef, MemoComponent, SimpleMemoComponent]);

// ============================================================================
// Minimal fiber type (same surface as fiberTreeWalker.Fiber)
// ============================================================================

interface Fiber {
  tag: number;
  type: unknown;
  key: string | null;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  memoizedProps: Record<string, unknown> | null;
  pendingProps: Record<string, unknown> | null;
  memoizedState: unknown;
  updateQueue: { shared?: { pending?: unknown }; lanes?: number } | null;
  flags: number;
  lanes: number;
  childLanes: number;
  alternate?: Fiber | null;
  actualDuration?: number;
  dependencies?: { firstContext?: unknown } | null;
  stateNode?: unknown;
  _debugSource?: { fileName: string; lineNumber: number } | null;
}

interface FiberRoot {
  current: Fiber;
  finishedLanes?: number;
  pendingLanes?: number;
}

// ============================================================================
// Helpers
// ============================================================================

function isMemoizedFiber(fiber: Fiber): boolean {
  return fiber.tag === MemoComponent || fiber.tag === SimpleMemoComponent;
}

/**
 * Shallow prop comparison, ignoring `children` (always changes structurally).
 * Returns true when props differ, false when shallowly equal.
 */
function propsChanged(prev: Record<string, unknown> | null, next: Record<string, unknown> | null): boolean {
  if (prev === next) return false;
  if (!prev || !next) return true;
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return true;
  for (const key of nextKeys) {
    if (key === 'children') continue;
    if (prev[key] !== next[key]) return true;
  }
  return false;
}

function getChangedPropKeys(prev: Record<string, unknown> | null, next: Record<string, unknown> | null): string[] {
  if (!prev || !next) return [];
  const changed: string[] = [];
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of allKeys) {
    if (key === 'children') continue;
    if (prev[key] !== next[key]) changed.push(key);
  }
  return changed;
}

/**
 * Check if the fiber had its own pending state update (not from parent).
 * Reads updateQueue.shared.pending — truthy means this fiber queued its own work.
 */
function hadOwnUpdate(fiber: Fiber): boolean {
  try {
    const uq = fiber.updateQueue;
    if (!uq) return false;
    // Class component: updateQueue.shared.pending
    if (uq.shared && uq.shared.pending != null) return true;
    // Function component: fiber.lanes has its own lane bits
    if (fiber.lanes !== 0) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if fiber has context dependencies that changed.
 */
function hadContextUpdate(fiber: Fiber): boolean {
  try {
    return !!fiber.dependencies?.firstContext;
  } catch {
    return false;
  }
}

/**
 * Determine a cascade reason for one fiber.
 * `parentRerendered` — whether the immediate parent re-rendered.
 */
function classifyFiber(
  fiber: Fiber,
  didRender: boolean,
  parentRerendered: boolean,
): CascadeReason | null {
  if (!didRender) {
    // Did not re-render — either it bailed out (memo) or wasn't in the commit
    if (fiber.alternate && isMemoizedFiber(fiber)) return 'bailed-out';
    return null; // not part of this commit
  }

  // Force update flag
  if (fiber.flags & ForceUpdateFlag) return 'force-update';

  // Context consumer
  if (hadContextUpdate(fiber)) return 'context-update';

  // Own state update (useState / useReducer / setState)
  if (hadOwnUpdate(fiber)) return 'state-update';

  // Parent re-rendered — check if props changed
  if (parentRerendered) {
    const alt = fiber.alternate;
    if (alt && propsChanged(alt.memoizedProps, fiber.memoizedProps)) {
      return 'props-changed';
    }
    return 'parent-cascade'; // avoidable
  }

  // Fallback: treat as state-update (root of a cascade we couldn't trace further)
  return 'state-update';
}

// ============================================================================
// Cascade tree builder (iterative DFS to avoid stack overflow on deep trees)
// ============================================================================

/** Post-process: accumulate subtree render durations bottom-up. */
function computeSubtreeDuration(node: CascadeNode): number {
  let total = node.renderDuration;
  for (const child of node.children) {
    total += computeSubtreeDuration(child);
  }
  node.subtreeDuration = total;
  return total;
}

let commitIdSeq = 0;

function nextCommitId(): string {
  return 'c-' + (++commitIdSeq).toString(36) + '-' + (Date.now() % 100000).toString(36);
}

interface StackEntry {
  fiber: Fiber;
  depth: number;
  parentRerendered: boolean;
  parentNode: CascadeNode | null;
  isRoot: boolean;
}

function buildCascadeTree(
  rootFiber: Fiber,
  triggers: readonly TriggerRecord[],
): { rootCauses: CascadeNode[]; totalComponents: number; avoidableCount: number; avoidableDuration: number } {
  const rootCauses: CascadeNode[] = [];
  let totalComponents = 0;
  let avoidableCount = 0;
  let avoidableDuration = 0;

  // Build a map: fiberId → triggerId for root-cause correlation
  // We correlate by component name since fiberId in dispatchWrapper uses a per-session counter
  const triggerByName = new Map<string, TriggerRecord>();
  for (const t of triggers) {
    if (!triggerByName.has(t.componentName)) {
      triggerByName.set(t.componentName, t);
    }
  }

  const stack: StackEntry[] = [{
    fiber: rootFiber,
    depth: 0,
    parentRerendered: false,
    parentNode: null,
    isRoot: true,
  }];

  while (stack.length > 0) {
    const entry = stack.pop()!;
    const { fiber, depth, parentRerendered, parentNode, isRoot } = entry;

    if (!fiber) continue;
    if (depth > 150) continue; // safety cap

    const didRender = !!(fiber.flags & PerformedWork);
    const isNewMount = !fiber.alternate;

    // Skip newly mounted components — not re-renders
    if (isNewMount && !didRender) {
      // Push children as non-re-render context
      let child = fiber.child;
      while (child) {
        stack.push({ fiber: child, depth: depth + 1, parentRerendered: false, parentNode, isRoot: false });
        child = child.sibling;
      }
      continue;
    }

    if (!USER_TAGS.has(fiber.tag)) {
      // Non-user tag (host, fragment, etc.) — just traverse children
      let child = fiber.child;
      while (child) {
        stack.push({ fiber: child, depth: depth + 1, parentRerendered: didRender || parentRerendered, parentNode, isRoot: false });
        child = child.sibling;
      }
      continue;
    }

    const reason = classifyFiber(fiber, didRender, parentRerendered);

    if (reason === null) {
      // Not part of this commit's cascade
      let child = fiber.child;
      while (child) {
        stack.push({ fiber: child, depth: depth + 1, parentRerendered: false, parentNode, isRoot: false });
        child = child.sibling;
      }
      continue;
    }

    const componentName = getFiberDisplayName(fiber.type);
    const renderDuration = fiber.actualDuration ?? 0;

    // Get changed props for props-changed reason
    let changedProps: string[] | undefined;
    if (reason === 'props-changed' && fiber.alternate) {
      changedProps = getChangedPropKeys(fiber.alternate.memoizedProps, fiber.memoizedProps);
    }

    // Find matching trigger for state-update root causes
    let triggerId: string | undefined;
    if (reason === 'state-update' || reason === 'context-update' || reason === 'force-update') {
      triggerId = triggerByName.get(componentName)?.triggerId;
    }

    const node: CascadeNode = {
      nodeId: componentName + '-' + depth + '-' + (totalComponents),
      componentName,
      reason,
      renderDuration,
      subtreeDuration: renderDuration, // will be updated from children
      changedProps,
      triggerId,
      children: [],
      depth,
      isMemoized: isMemoizedFiber(fiber),
    };

    totalComponents++;
    if (reason === 'parent-cascade') {
      avoidableCount++;
      avoidableDuration += renderDuration;
    }

    // Attach to parent or root causes
    if (parentNode) {
      parentNode.children.push(node);
      // Propagate subtree duration upward (simplified — full propagation done in post-process)
    } else if (reason === 'state-update' || reason === 'context-update' || reason === 'force-update' || isRoot) {
      rootCauses.push(node);
    } else if (parentRerendered) {
      // Orphan cascade node — attach to a synthetic root if needed
      rootCauses.push(node);
    }

    // Push children with this node as parent
    let child = fiber.child;
    while (child) {
      stack.push({
        fiber: child,
        depth: depth + 1,
        parentRerendered: didRender,
        parentNode: reason !== 'bailed-out' ? node : parentNode,
        isRoot: false,
      });
      child = child.sibling;
    }
  }

  for (const root of rootCauses) computeSubtreeDuration(root);

  return { rootCauses, totalComponents, avoidableCount, avoidableDuration };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Analyze the just-committed fiber tree and return a CascadeRecord.
 * Called from fiberTreeWalker immediately after onCommitFiberRoot fires.
 */
export function analyzeCascade(
  root: FiberRoot,
  triggers: readonly TriggerRecord[],
): CascadeRecord | null {
  try {
    const finishedLanes = getFinishedLanes(root);
    const lane = classifyLanes(finishedLanes);

    const { rootCauses, totalComponents, avoidableCount, avoidableDuration } =
      buildCascadeTree(root.current, triggers);

    // Skip trivial commits (mount-only, no re-renders)
    if (totalComponents === 0) return null;

    const totalDuration = rootCauses.reduce((sum, n) => sum + n.subtreeDuration, 0);
    const triggerIds = triggers.map((t) => t.triggerId);

    return {
      commitId: nextCommitId(),
      timestamp: performance.now(),
      totalDuration,
      totalComponents,
      avoidableCount,
      avoidableDuration,
      rootCauses,
      lane,
      triggerIds,
    };
  } catch {
    return null;
  }
}
