/**
 * Dispatch Wrapper — intercepts React setState / useReducer dispatch calls
 * to capture the JavaScript call stack at the moment of the state update.
 *
 * Strategy:
 *  - After each commit (called from fiberTreeWalker's onCommitFiberRoot hook),
 *    walk the fiber tree and wrap any unwrapped dispatch functions on hook queues.
 *  - For class components, wrap this.setState and this.forceUpdate on the instance.
 *  - Wrapped dispatches capture an Error stack trace and record a TriggerRecord.
 *  - Records are held in a ring buffer (max 200). fiberTreeWalker drains them
 *    after each cascade analysis pass.
 *
 * Performance budget: < 1ms per commit for wrapping, < 50μs per dispatch for capture.
 */

import type { TriggerRecord, StackFrame } from './types';
import { serializeValue } from './serializer';
import { getFiberDisplayName } from './fiberUtils';

// Ring buffer — max 200 entries, oldest discarded on overflow
const MAX_TRIGGERS = 200;
const triggerBuffer: TriggerRecord[] = [];
let triggerSeq = 0;

// WeakSet tracks wrapped dispatchers. We add the WRAPPED function (not the original) so that
// subsequent calls to wrapFiberDispatchers correctly detect already-wrapped dispatches and skip
// them — preventing double-wrapping across commits (which causes "Maximum update depth exceeded").
const wrappedDispatchers = new WeakSet<(...args: unknown[]) => void>();

// Batch ID — groups dispatches that fire within the same synchronous turn
let currentBatchId: string | null = null;

function nextBatchId(): string {
  if (!currentBatchId) {
    currentBatchId = String(Date.now()) + '-' + (Math.random() * 0xFFFF | 0).toString(16);
    queueMicrotask(() => { currentBatchId = null; });
  }
  return currentBatchId;
}

function nextTriggerId(): string {
  return 'tr-' + (++triggerSeq).toString(36);
}

// ============================================================================
// V8 structured stack capture — zero-parse overhead
// ============================================================================

const STACK_DEPTH_LIMIT = 15;

// Patterns that identify non-user frames
const NOISE_PATTERNS = [
  'node_modules',
  'react-dom',
  'react-reconciler',
  '@flotrace/runtime',
  'flotrace/runtime',
  '/runtime/src/',
  'webpack-internal',
  'webpack/bootstrap',
  '<anonymous>',
];

export function isUserCodeFrame(fileName: string | null): boolean {
  if (!fileName) return false;
  for (const pattern of NOISE_PATTERNS) {
    if (fileName.includes(pattern)) return false;
  }
  return true;
}

export function captureStack(): StackFrame[] {
  const frames: StackFrame[] = [];

  try {
    const originalPrepare = (Error as unknown as { prepareStackTrace?: unknown }).prepareStackTrace;

    (Error as unknown as { prepareStackTrace: unknown }).prepareStackTrace = (
      _err: Error,
      callSites: Array<{
        getFunctionName(): string | null;
        getMethodName(): string | null;
        getFileName(): string | null;
        getLineNumber(): number | null;
        getColumnNumber(): number | null;
      }>
    ) => {
      for (const site of callSites) {
        if (frames.length >= STACK_DEPTH_LIMIT) break;
        const fileName = site.getFileName();
        frames.push({
          functionName: site.getFunctionName() ?? site.getMethodName(),
          fileName,
          lineNumber: site.getLineNumber(),
          columnNumber: site.getColumnNumber(),
          isUserCode: isUserCodeFrame(fileName),
        });
      }
      return '';
    };

    const err = new Error();
    // Access .stack to trigger prepareStackTrace
    void err.stack;
    (Error as unknown as { prepareStackTrace: unknown }).prepareStackTrace = originalPrepare;
  } catch {
    // prepareStackTrace API not available (non-V8 or restricted env) — fall back to string parse
    try {
      const raw = new Error().stack ?? '';
      const lines = raw.split('\n').slice(1); // skip "Error" header
      for (const line of lines) {
        if (frames.length >= STACK_DEPTH_LIMIT) break;
        const match = line.match(/^\s+at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/);
        if (match) {
          const fileName = match[2] ?? null;
          frames.push({
            functionName: match[1] ?? null,
            fileName,
            lineNumber: match[3] ? parseInt(match[3], 10) : null,
            columnNumber: match[4] ? parseInt(match[4], 10) : null,
            isUserCode: isUserCodeFrame(fileName),
          });
        }
      }
    } catch {
      // Completely swallow — stack capture is best-effort
    }
  }

  return frames;
}

// ============================================================================
// Fiber type — minimal shape, same as fiberTreeWalker
// ============================================================================

interface FiberMinimal {
  tag: number;
  key: string | null;
  type: { name?: string; displayName?: string } | null;
  stateNode?: unknown;
  memoizedState: {
    memoizedState: unknown;
    queue: {
      dispatch?: (...args: unknown[]) => void;
    } | null;
    next: unknown;
  } | null;
  child: FiberMinimal | null;
  sibling: FiberMinimal | null;
  return: FiberMinimal | null;
  alternate?: FiberMinimal | null;
}

const FIBER_TAG_FUNCTION  = 0;
const FIBER_TAG_CLASS     = 1;
const FIBER_TAG_FORWARD   = 11;
const FIBER_TAG_MEMO      = 14;
const FIBER_TAG_SIMPLEMEMO = 15;

function getComponentName(fiber: FiberMinimal): string {
  return getFiberDisplayName(fiber.type);
}

// ============================================================================
// Dispatch wrapping for function components (hooks)
// ============================================================================

function wrapFunctionComponentDispatchers(fiber: FiberMinimal): void {
  let hookNode = fiber.memoizedState;
  let hookIndex = 0;

  while (hookNode && hookIndex < 100) {
    try {
      const queue = hookNode.queue;
      if (queue && typeof queue.dispatch === 'function') {
        const original = queue.dispatch;
        if (!wrappedDispatchers.has(original)) {
          const componentName = getComponentName(fiber);
          const fiberId = getFiberId(fiber);
          const capturedHookIndex = hookIndex;

          // Detect hook type: useState queues have a lastRenderedReducer that is the
          // basicStateReducer identity function; useReducer queues have a custom reducer.
          const hookType: 'state' | 'reducer' =
            typeof (queue as { lastRenderedReducer?: unknown }).lastRenderedReducer === 'function' &&
            (queue as { lastRenderedReducer?: Function }).lastRenderedReducer?.toString().includes('action')
              ? 'reducer'
              : 'state';

          const wrapped = function dispatchWithCapture(action: unknown) {
            try {
              const stack = captureStack();
              const record: TriggerRecord = {
                triggerId: nextTriggerId(),
                fiberId,
                componentName,
                hookIndex: capturedHookIndex,
                hookType,
                stack,
                timestamp: performance.now(),
                action: serializeValue(action, 2),
                batchId: nextBatchId(),
              };
              addTrigger(record);
            } catch {
              // Never break the actual dispatch
            }
            return original(action);
          };

          wrappedDispatchers.add(wrapped as (...args: unknown[]) => void);
          queue.dispatch = wrapped as (...args: unknown[]) => void;
        }
      }
    } catch {
      // Skip malformed hook nodes
    }

    hookNode = hookNode.next as typeof hookNode;
    hookIndex++;
  }
}

// ============================================================================
// Class component wrapping (setState / forceUpdate)
// ============================================================================

function wrapClassComponentInstance(fiber: FiberMinimal): void {
  const instance = fiber.stateNode as Record<string, unknown> | null;
  if (!instance || instance.__ftWrapped) return;

  const componentName = getComponentName(fiber);
  const fiberId = getFiberId(fiber);

  if (typeof instance.setState === 'function') {
    const origSetState = instance.setState as Function;
    instance.setState = function wrappedSetState(updater: unknown, callback?: unknown) {
      try {
        const stack = captureStack();
        addTrigger({
          triggerId: nextTriggerId(),
          fiberId,
          componentName,
          hookIndex: 0,
          hookType: 'setState',
          stack,
          timestamp: performance.now(),
          action: serializeValue(updater, 2),
          batchId: nextBatchId(),
        });
      } catch { /* never break */ }
      return origSetState.call(this, updater, callback);
    };
  }

  if (typeof instance.forceUpdate === 'function') {
    const origForceUpdate = instance.forceUpdate as Function;
    instance.forceUpdate = function wrappedForceUpdate(callback?: unknown) {
      try {
        const stack = captureStack();
        addTrigger({
          triggerId: nextTriggerId(),
          fiberId,
          componentName,
          hookIndex: 0,
          hookType: 'forceUpdate',
          stack,
          timestamp: performance.now(),
          action: null,
          batchId: nextBatchId(),
        });
      } catch { /* never break */ }
      return origForceUpdate.call(this, callback);
    };
  }

  instance.__ftWrapped = true;
}

// ============================================================================
// Fiber ID — mirrors the logic in fiberTreeWalker (path not available here,
// so we use a stable string derived from component name + fiber address)
// ============================================================================

const fiberIds = new WeakMap<object, string>();
let fiberIdSeq = 0;

function getFiberId(fiber: FiberMinimal): string {
  let id = fiberIds.get(fiber);
  if (!id) {
    id = getComponentName(fiber) + '-' + (++fiberIdSeq).toString(36);
    fiberIds.set(fiber, id);
  }
  return id;
}

// ============================================================================
// Ring buffer management
// ============================================================================

function addTrigger(record: TriggerRecord): void {
  if (triggerBuffer.length >= MAX_TRIGGERS) {
    triggerBuffer.shift();
  }
  triggerBuffer.push(record);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Walk the committed fiber tree and wrap any unwrapped dispatch functions.
 * Called from fiberTreeWalker after each commit. O(n) fiber walk.
 */
export function wrapFiberDispatchers(root: { current: FiberMinimal }): void {
  try {
    walkAndWrap(root.current);
  } catch {
    // Never throw into React's commit pipeline
  }
}

function walkAndWrap(rootFiber: FiberMinimal | null): void {
  if (!rootFiber) return;

  // Iterative DFS — avoids call stack overflow on deep trees
  const stack: FiberMinimal[] = [rootFiber];
  while (stack.length > 0) {
    const fiber = stack.pop()!;
    try {
      const tag = fiber.tag;
      if (tag === FIBER_TAG_FUNCTION || tag === FIBER_TAG_FORWARD ||
          tag === FIBER_TAG_MEMO || tag === FIBER_TAG_SIMPLEMEMO) {
        wrapFunctionComponentDispatchers(fiber);
      } else if (tag === FIBER_TAG_CLASS) {
        wrapClassComponentInstance(fiber);
      }
    } catch {
      // Skip this fiber, continue walk
    }
    // Push sibling before child so child is processed first (depth-first order)
    if (fiber.sibling) stack.push(fiber.sibling);
    if (fiber.child) stack.push(fiber.child);
  }
}

/**
 * Peek at pending triggers without draining (for cascadeAnalyzer correlation).
 */
export function peekTriggers(): readonly TriggerRecord[] {
  return triggerBuffer;
}

/**
 * Clear all pending triggers (call after cascade has been emitted).
 */
export function clearTriggers(): void {
  triggerBuffer.length = 0;
}
