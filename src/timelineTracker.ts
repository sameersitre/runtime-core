/**
 * Component Event Timeline for @flotrace/runtime
 *
 * Emits lifecycle events (mount, unmount, render, effect-run, effect-cleanup,
 * state-update, props-change) for each component. Events are stored in a
 * ring buffer per component (max 100 events) to prevent memory growth.
 *
 * Events are batched and flushed every 500ms to avoid flooding the WebSocket.
 */

import type { TimelineEvent, TimelineEventType } from './types';
import { serializeValue } from './serializer';
import type { FloTraceWebSocketClient } from './websocketClient';

const MAX_EVENTS_PER_COMPONENT = 100;
const FLUSH_INTERVAL_MS = 500;
const MAX_PENDING_EVENTS = 200;
// Cap the number of DISTINCT components tracked. The per-component ring buffer is already
// bounded (MAX_EVENTS_PER_COMPONENT); without this, the `timelines` Map's KEY count grows
// unbounded over a long dev session — every navigation / list re-key mints a fresh
// path-based nodeId and the map only cleared on uninstall. Generous so real apps never evict.
const MAX_TRACKED_COMPONENTS = 2000;

// Ring buffer per component nodeId → events[]
const timelines = new Map<string, TimelineEvent[]>();

// Pending events queued for next flush: [nodeId, componentName, event]
let pendingEvents: Array<{ nodeId: string; componentName: string; event: TimelineEvent }> = [];

let client: FloTraceWebSocketClient | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let isInstalled = false;

/**
 * Install the timeline tracker.
 * Call once during ext:startTracking.
 */
export function installTimelineTracker(wsClient: FloTraceWebSocketClient): void {
  if (isInstalled) return;
  client = wsClient;
  isInstalled = true;

  flushTimer = setInterval(flushPendingEvents, FLUSH_INTERVAL_MS);
}

/**
 * Uninstall the timeline tracker and clean up resources.
 */
export function uninstallTimelineTracker(): void {
  if (!isInstalled) return;

  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  // Flush remaining events before shutdown
  flushPendingEvents();

  timelines.clear();
  pendingEvents = [];
  client = null;
  isInstalled = false;
}

/**
 * Record a lifecycle event for a component.
 * Called from the fiber tree walker during tree walks and from effect trackers.
 *
 * @param nodeId - Path-based node ID (e.g., "App-0/Dashboard-0/Card-2")
 * @param componentName - Component display name
 * @param eventType - Lifecycle event type
 * @param detail - Optional additional context (serialized)
 * @param duration - Optional duration in ms (for render events)
 */
export function recordTimelineEvent(
  nodeId: string,
  componentName: string,
  eventType: TimelineEventType,
  detail?: unknown,
  duration?: number,
): void {
  if (!isInstalled) return;

  const event: TimelineEvent = {
    type: eventType,
    timestamp: Date.now(),
    duration,
    detail: detail !== undefined ? serializeValue(detail, 0, new WeakSet()) : undefined,
  };

  // Add to ring buffer
  let events = timelines.get(nodeId);
  if (!events) {
    // FIFO-evict the oldest-tracked component when at capacity. Flushed events were already
    // sent over the WS, so eviction only drops the LOCAL on-demand buffer for the oldest
    // component (getTimeline → []), never sent data.
    if (timelines.size >= MAX_TRACKED_COMPONENTS) {
      const oldest = timelines.keys().next().value;
      if (oldest !== undefined) timelines.delete(oldest);
    }
    events = [];
    timelines.set(nodeId, events);
  }
  events.push(event);
  if (events.length > MAX_EVENTS_PER_COMPONENT) {
    events.shift();
  }

  // Queue for next flush (cap pending to avoid unbounded growth)
  if (pendingEvents.length < MAX_PENDING_EVENTS) {
    pendingEvents.push({ nodeId, componentName, event });
  }
}

/**
 * Get the timeline for a specific component (for on-demand requests).
 */
export function getTimeline(nodeId: string): TimelineEvent[] {
  return timelines.get(nodeId) ?? [];
}

/**
 * Flush pending events to the WebSocket server.
 */
function flushPendingEvents(): void {
  if (!client?.connected || pendingEvents.length === 0) return;

  for (const { nodeId, componentName, event } of pendingEvents) {
    client.send({
      type: 'runtime:timelineEvent',
      nodeId,
      componentName,
      event,
    });
  }

  pendingEvents = [];
}
