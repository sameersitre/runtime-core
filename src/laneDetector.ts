/**
 * React lane bitmask → human-readable priority classification.
 *
 * Lane constants are extracted from react-reconciler source (React 18+).
 * These are stable across minor versions but may change in React 19.
 * All reads are wrapped in try/catch — fiber internals are not public API.
 */

import type { LaneInfo, LanePriority } from './types';

// React 18 lane bitmasks (from ReactFiberLane.js)
const SyncHydrationLane    = 0b0000000000000000000000000000001;
const SyncLane             = 0b0000000000000000000000000000010;
const InputContinuousHydrationLane = 0b0000000000000000000000000000100;
const InputContinuousLane  = 0b0000000000000000000000000001000;
const DefaultHydrationLane = 0b0000000000000000000000000010000;
const DefaultLane          = 0b0000000000000000000000000100000;
const TransitionLanes      = 0b0000000001111111111111111000000; // lanes 7–22
const RetryLanes           = 0b0000011110000000000000000000000;
const SelectiveHydrationLane = 0b0000100000000000000000000000000;
const IdleHydrationLane    = 0b0001000000000000000000000000000;
const IdleLane             = 0b0010000000000000000000000000000;
const OffscreenLane        = 0b0100000000000000000000000000000;

export function classifyLanes(lanes: number): LaneInfo {
  try {
    if (lanes & SyncHydrationLane || lanes & SyncLane) {
      return { priority: 'sync', lanes, isTransition: false, isBlocking: true };
    }
    if (lanes & InputContinuousHydrationLane || lanes & InputContinuousLane) {
      // Discrete events (click, keydown) land here in React 18
      return { priority: 'discrete', lanes, isTransition: false, isBlocking: true };
    }
    if (lanes & DefaultHydrationLane || lanes & DefaultLane) {
      return { priority: 'default', lanes, isTransition: false, isBlocking: false };
    }
    if (lanes & TransitionLanes) {
      return { priority: 'transition', lanes, isTransition: true, isBlocking: false };
    }
    if (lanes & RetryLanes || lanes & SelectiveHydrationLane) {
      return { priority: 'deferred', lanes, isTransition: false, isBlocking: false };
    }
    if (lanes & IdleHydrationLane || lanes & IdleLane) {
      return { priority: 'idle', lanes, isTransition: false, isBlocking: false };
    }
    if (lanes & OffscreenLane) {
      return { priority: 'offscreen', lanes, isTransition: false, isBlocking: false };
    }
  } catch {
    // Fiber internals can throw — fall through to default
  }
  return { priority: 'default', lanes, isTransition: false, isBlocking: false };
}

export function lanePriorityLabel(priority: LanePriority): string {
  switch (priority) {
    case 'sync':       return 'Sync';
    case 'discrete':   return 'Discrete';
    case 'continuous': return 'Continuous';
    case 'default':    return 'Default';
    case 'transition': return 'Transition';
    case 'deferred':   return 'Deferred';
    case 'idle':       return 'Idle';
    case 'offscreen':  return 'Offscreen';
  }
}

/** CSS color for a lane priority — used by LaneBadge */
export function lanePriorityColor(priority: LanePriority): string {
  switch (priority) {
    case 'sync':       return '#F44336'; // red
    case 'discrete':   return '#42A5F5'; // blue
    case 'continuous': return '#26C6DA'; // cyan
    case 'default':    return '#78909C'; // blue-gray
    case 'transition': return '#66BB6A'; // green
    case 'deferred':   return '#AB47BC'; // purple
    case 'idle':       return '#546E7A'; // dim
    case 'offscreen':  return '#455A64'; // very dim
  }
}

/** Read finishedLanes from the FiberRoot node — the lanes for the just-committed work */
export function getFinishedLanes(root: { finishedLanes?: number; pendingLanes?: number }): number {
  try {
    return root.finishedLanes ?? root.pendingLanes ?? 0;
  } catch {
    return 0;
  }
}
