/**
 * Value Lineage — origin tracing resolver.
 *
 * Given a component's prop-path or hook-path, walk upward through three layers
 * to find where the value originated:
 *
 *   1. Prop chain     — walk fiber.return upward, match fingerprint at each level
 *   2. Store match    — scan Zustand / Redux / TanStack Query live snapshots
 *   3. API match      — feed matched reference into fetchOriginRegistry WeakMap
 *
 * On-demand only — never runs per-render. Hard 50 ms wall-clock budget.
 * Uses reference identity (`===`) before fingerprinting to keep common cases fast.
 *
 * See docs/PRD-VALUE-LINEAGE.md §6 and docs/IMPLEMENTATION-PLAN-VALUE-LINEAGE.md Phase 2.
 */

import type { Fiber, FiberHookState } from './fiberTreeWalker';
import { getFiberRefMap } from './fiberTreeWalker';

/**
 * Context-dependency linked list node (React 18+).
 * `fiber.dependencies.firstContext → FiberContextDependency[]`. Duck-typed so
 * the resolver doesn't import the internal `fiberTreeWalker` type directly
 * (keeps the surface small).
 */
interface FiberContextDep {
  context: { _currentValue: unknown; displayName?: string };
  memoizedValue: unknown;
  next: FiberContextDep | null;
}

/** React ContextProvider fiber tag. Mirrors FIBER_TAGS.ContextProvider = 10. */
const FIBER_TAG_CONTEXT_PROVIDER = 10;
import { getComponentNameFromFiber } from './fiberAttribution';
import { valueFingerprint, shouldFlagRename } from './propDrillingAnalyzer';
import { findFetchOrigin } from './fetchOriginRegistry';
import { getZustandSnapshot } from './zustandTracker';
import { getReduxSnapshot } from './reduxTracker';
import { getTanstackSnapshot } from './tanstackQueryTracker';
import type { TraceStep, ValueTrace } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard ceiling on wall-clock time per resolve. Over this → bail with truncated=true. */
const BUDGET_MS = 50;

/** Max recursive depth when scanning an object/store for a matching fingerprint. */
const SCAN_DEPTH = 3;

/** Max number of ancestor fibers we walk looking for prop-chain matches. */
const MAX_PROP_CHAIN_DEPTH = 30;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ValueTraceInput {
  nodeId: string;
  propPath?: string[];
  hookPath?: { hookIndex: number; subPath?: string[] };
}

// ---------------------------------------------------------------------------
// Helpers — budget + path walk
// ---------------------------------------------------------------------------

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** Walk a dot-path into an arbitrary value. Returns undefined on miss. */
function walkPath(root: unknown, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Walk the fiber.memoizedState linked list to extract the value at hookIndex. */
function getHookValueAt(fiber: Fiber, hookIndex: number): unknown {
  let hook: FiberHookState | null = fiber.memoizedState;
  let i = 0;
  while (hook && i < hookIndex) {
    hook = hook.next;
    i++;
  }
  if (!hook) return undefined;
  // useState stores [value, dispatch] pairs in `.memoizedState` via the
  // `BaseStateAction` type at runtime. For our purposes, we return the
  // memoizedState directly — if the caller wants the scalar state, they'll
  // pass subPath=['<first-element>'], but most hooks (including useState on
  // modern React) expose the current value directly.
  return hook.memoizedState;
}

// ---------------------------------------------------------------------------
// Matching — reference identity + fingerprint
// ---------------------------------------------------------------------------

/**
 * True when `candidate` can be confidently identified as the "same value" as
 * `target`. Reference identity wins outright **for objects/arrays**; primitives
 * must additionally be structurally complex enough to avoid collision (e.g.,
 * lone `count: 5` matching at many call sites). See PRD §5.1 rubric.
 */
function valuesMatch(
  target: unknown,
  targetFp: string,
  candidate: unknown,
): 'exact' | 'fingerprint-match' | null {
  const targetIsObject = target !== null && typeof target === 'object';
  const candidateIsObject = candidate !== null && typeof candidate === 'object';

  // Reference identity for non-null objects/arrays is unambiguous.
  if (targetIsObject && candidateIsObject && target === candidate) return 'exact';

  // For primitives (or trivial objects like {} / []), refuse to claim a match —
  // `shouldFlagRename` returns false for them. Prevents false-confidence on
  // values like `5`, `true`, `""`, `{}`, `[]` that collide across unrelated sites.
  if (!shouldFlagRename(target) || !shouldFlagRename(candidate)) return null;

  if (valueFingerprint(candidate) === targetFp) return 'fingerprint-match';
  return null;
}

/**
 * DFS into an object/array looking for a matching value. Returns the path to
 * the first hit, or null. Depth-limited to prevent runaway on cyclic stores.
 */
function findMatchingPathInObject(
  target: unknown,
  targetFp: string,
  container: unknown,
  currentPath: string[],
  depth: number,
  deadline: number,
): { path: string[]; confidence: 'exact' | 'fingerprint-match' } | null {
  if (now() > deadline) return null;
  if (depth > SCAN_DEPTH) return null;
  if (container === null || typeof container !== 'object') return null;

  // Check the container itself first.
  const selfMatch = valuesMatch(target, targetFp, container);
  if (selfMatch) return { path: [...currentPath], confidence: selfMatch };

  if (Array.isArray(container)) {
    for (let i = 0; i < Math.min(container.length, 50); i++) {
      const child = container[i];
      const directMatch = valuesMatch(target, targetFp, child);
      if (directMatch) return { path: [...currentPath, String(i)], confidence: directMatch };
      const nested = findMatchingPathInObject(target, targetFp, child, [...currentPath, String(i)], depth + 1, deadline);
      if (nested) return nested;
    }
  } else {
    for (const key of Object.keys(container)) {
      const child = (container as Record<string, unknown>)[key];
      const directMatch = valuesMatch(target, targetFp, child);
      if (directMatch) return { path: [...currentPath, key], confidence: directMatch };
      const nested = findMatchingPathInObject(target, targetFp, child, [...currentPath, key], depth + 1, deadline);
      if (nested) return nested;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reverse fiber → nodeId lookup
// ---------------------------------------------------------------------------

/** Build a reverse Map<Fiber,nodeId> from fiberRefMap. O(n) — cached per trace. */
function buildFiberToNodeIdMap(): Map<Fiber, string> {
  const reverse = new Map<Fiber, string>();
  for (const [nodeId, fiber] of getFiberRefMap()) {
    reverse.set(fiber, nodeId);
  }
  return reverse;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Resolve the origin chain for a specific prop or hook value on a component.
 * Returns `{requestId}`-less trace — caller adds the round-trip id.
 */
export function resolveValueTrace(input: ValueTraceInput): Omit<ValueTrace, 'requestId'> {
  const startedAt = now();
  const deadline = startedAt + BUDGET_MS;
  const steps: TraceStep[] = [];

  const base: Omit<ValueTrace, 'requestId'> = {
    rootNodeId: input.nodeId,
    rootPropPath: input.propPath,
    rootHookPath: input.hookPath,
    steps,
    resolvedAtMs: now(),
  };

  // 1. Find the fiber.
  const fiber = getFiberRefMap().get(input.nodeId);
  if (!fiber) {
    return { ...base, error: 'no-fiber', resolvedAtMs: now() };
  }

  // 2. Extract the root value.
  let rootValue: unknown;
  if (input.propPath && input.propPath.length > 0) {
    if (!fiber.memoizedProps) return { ...base, error: 'value-not-found', resolvedAtMs: now() };
    rootValue = walkPath(fiber.memoizedProps, input.propPath);
  } else if (input.hookPath) {
    const hookValue = getHookValueAt(fiber, input.hookPath.hookIndex);
    rootValue = input.hookPath.subPath && input.hookPath.subPath.length > 0
      ? walkPath(hookValue, input.hookPath.subPath)
      : hookValue;
  } else {
    return { ...base, error: 'value-not-found', resolvedAtMs: now() };
  }

  if (rootValue === undefined) {
    return { ...base, error: 'value-not-found', resolvedAtMs: now() };
  }

  const rootFp = valueFingerprint(rootValue);
  const fiberToNodeId = buildFiberToNodeIdMap();
  const rootComponentName = getComponentNameFromFiber(fiber) ?? 'Unknown';

  // 3. Emit consumer step.
  if (input.propPath) {
    steps.push({
      kind: 'prop',
      nodeId: input.nodeId,
      componentName: rootComponentName,
      propPath: input.propPath,
      confidence: 'exact',
    });
  } else if (input.hookPath) {
    steps.push({
      kind: 'hook-state',
      nodeId: input.nodeId,
      componentName: rootComponentName,
      hookIndex: input.hookPath.hookIndex,
      hookType: 'unknown', // Cheap: full hook classification is expensive; caller can fetch separately.
      subPath: input.hookPath.subPath,
      confidence: 'exact',
    });
  }

  // 4. Prop → prop walk (only when root came via a prop).
  if (input.propPath) {
    let current: Fiber | null = fiber.return;
    let hops = 0;
    while (current && hops < MAX_PROP_CHAIN_DEPTH) {
      if (now() > deadline) return { ...base, steps, truncated: true, resolvedAtMs: now() };

      // Skip ContextProvider fibers — they carry the context value as a
      // mechanical `value` prop, but from the user's mental model the value
      // arrives via the context hook, not as a prop drill. The context-step
      // logic below surfaces the provider explicitly.
      if (current.tag !== FIBER_TAG_CONTEXT_PROVIDER) {
        const props = current.memoizedProps;
        if (props) {
          const match = findMatchingPathInObject(rootValue, rootFp, props, [], 0, deadline);
          if (match) {
            const ancestorNodeId = fiberToNodeId.get(current);
            const ancestorName = getComponentNameFromFiber(current) ?? 'Unknown';
            if (ancestorNodeId) {
              steps.push({
                kind: 'prop',
                nodeId: ancestorNodeId,
                componentName: ancestorName,
                propPath: match.path,
                confidence: match.confidence,
              });
            }
          }
        }
      }
      current = current.return;
      hops++;
    }
  }

  // 5. Direct hook → API match — try WeakMap before the store scan. Covers
  //    useState/useReducer fed directly by fetch response (TanStack Query,
  //    SWR, vanilla useState).
  if (input.hookPath) {
    const origin = findFetchOrigin(rootValue);
    if (origin) {
      steps.push({
        kind: 'api',
        requestId: origin,
        method: 'UNKNOWN',
        urlPath: '',
        ageMs: 0,
      });
      return { ...base, steps, resolvedAtMs: now() };
    }
  }

  // 5.5 Derivation match — when the root is a prop whose value is the cached
  //    output of a useMemo/useCallback on the *consumer* fiber itself, emit a
  //    `derived` step so users see that the value is computed, not sourced.
  //    Users can then click-trace any dep to continue. Covers cases like
  //    `const fullName = useMemo(() => `${first} ${last}`, [first, last])`.
  const derivedMatch = findDerivationMatch(fiber, rootValue, rootFp, rootComponentName);
  if (derivedMatch) {
    steps.push({ ...derivedMatch, nodeId: input.nodeId });
    // A derived value ends the chain for v1 — per-dep recursive tracing is
    // a future slice. User can click any hook/prop dep to start a new trace.
    return { ...base, steps, resolvedAtMs: now() };
  }

  // 6. Context match — walk fiber.dependencies (React 18+) for a context
  //    whose memoizedValue matches the target. Emits a context step that
  //    terminates the chain from the consumer's perspective; if a Provider
  //    fiber is in the ancestor path we further try to correlate the
  //    provider value to a store / API for the full chain.
  const contextMatch = findContextMatch(fiber, rootValue, rootFp, fiberToNodeId);
  if (contextMatch) {
    steps.push(contextMatch.step);
    const providerStoreMatch = findStoreMatch(contextMatch.providerValue, valueFingerprint(contextMatch.providerValue), deadline);
    if (providerStoreMatch) {
      steps.push({
        kind: 'store',
        source: providerStoreMatch.source,
        storeName: providerStoreMatch.storeName,
        keyPath: providerStoreMatch.keyPath,
        confidence: providerStoreMatch.confidence,
      });
      const origin = findFetchOrigin(providerStoreMatch.matchedValue);
      if (origin) {
        steps.push({ kind: 'api', requestId: origin, method: 'UNKNOWN', urlPath: '', ageMs: 0 });
      }
    } else {
      const origin = findFetchOrigin(contextMatch.providerValue);
      if (origin) {
        steps.push({ kind: 'api', requestId: origin, method: 'UNKNOWN', urlPath: '', ageMs: 0 });
      }
    }
    return { ...base, steps, resolvedAtMs: now() };
  }

  // 7. Store match — Zustand, Redux, TanStack Query (first match wins).
  const storeMatch = findStoreMatch(rootValue, rootFp, deadline);
  if (storeMatch) {
    steps.push({
      kind: 'store',
      source: storeMatch.source,
      storeName: storeMatch.storeName,
      keyPath: storeMatch.keyPath,
      confidence: storeMatch.confidence,
    });

    // 8. Store → API match.
    const origin = findFetchOrigin(storeMatch.matchedValue);
    if (origin) {
      steps.push({
        kind: 'api',
        requestId: origin,
        method: 'UNKNOWN',
        urlPath: '',
        ageMs: 0,
      });
    }
  }

  return { ...base, steps, resolvedAtMs: now() };
}

// ---------------------------------------------------------------------------
// Context match
// ---------------------------------------------------------------------------

interface ContextMatchResult {
  step: Extract<TraceStep, { kind: 'context' }>;
  /** Value read off the nearest <Context.Provider value={...}>, or the consumer's
   *  memoized context value if no provider is in the ancestor chain. */
  providerValue: unknown;
}

function findContextMatch(
  consumer: Fiber,
  target: unknown,
  targetFp: string,
  fiberToNodeId: Map<Fiber, string>,
): ContextMatchResult | null {
  const deps = consumer.dependencies?.firstContext as FiberContextDep | null | undefined;
  if (!deps) return null;

  let dep: FiberContextDep | null = deps;
  while (dep) {
    const match = valuesMatch(target, targetFp, dep.memoizedValue);
    if (match) {
      const provider = findNearestProvider(consumer, dep.context);
      const step: Extract<TraceStep, { kind: 'context' }> = {
        kind: 'context',
        contextName: dep.context.displayName || 'Context',
        providerNodeId: provider ? fiberToNodeId.get(provider) : undefined,
        confidence: match,
      };
      const providerValue = provider?.memoizedProps?.value ?? dep.memoizedValue;
      return { step, providerValue };
    }
    dep = dep.next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Derivation match — useMemo / useCallback on the consumer fiber
// ---------------------------------------------------------------------------

/**
 * Scan the fiber's hook linked list for a useMemo/useCallback whose cached
 * `computedValue` matches the target. React stores these as
 * `memoizedState = [computedValue, deps]` on the hook node.
 * Returns a `derived` step when matched.
 */
function findDerivationMatch(
  fiber: Fiber,
  target: unknown,
  targetFp: string,
  componentName: string,
): Extract<TraceStep, { kind: 'derived' }> | null {
  let hook: FiberHookState | null = fiber.memoizedState;
  let index = 0;
  while (hook) {
    const ms = hook.memoizedState;
    // useMemo / useCallback — memoizedState shape is [value, depsArray].
    if (Array.isArray(ms) && ms.length === 2 && Array.isArray(ms[1])) {
      const [computed, deps] = ms as [unknown, unknown[]];
      const match = valuesMatch(target, targetFp, computed);
      if (match) {
        // Distinguish useCallback (computed is a function) from useMemo.
        const hookType: 'useMemo' | 'useCallback' =
          typeof computed === 'function' ? 'useCallback' : 'useMemo';
        // nodeId is the walker's id for this fiber; use consumer's nodeId from
        // the resolver's caller context by reverse lookup at call-site. Here we
        // return without nodeId — caller fills it in since we don't have the
        // fiberToNodeId map in scope. Keep function signature narrow.
        return {
          kind: 'derived',
          nodeId: '',
          componentName,
          hookIndex: index,
          hookType,
          depCount: deps.length,
          confidence: match,
        };
      }
    }
    hook = hook.next;
    index++;
  }
  return null;
}

/**
 * Walk `fiber.return` chain looking for the nearest ContextProvider fiber
 * whose `type._context` matches the given context object.
 */
function findNearestProvider(consumer: Fiber, contextObj: unknown): Fiber | null {
  let current: Fiber | null = consumer.return;
  let hops = 0;
  while (current && hops < MAX_PROP_CHAIN_DEPTH) {
    if (current.tag === FIBER_TAG_CONTEXT_PROVIDER) {
      const providerType = current.type as { _context?: unknown } | null;
      if (providerType && providerType._context === contextObj) return current;
    }
    current = current.return;
    hops++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Store match
// ---------------------------------------------------------------------------

interface StoreMatchResult {
  source: 'zustand' | 'redux' | 'tanstack-query';
  storeName: string;
  keyPath: string[];
  confidence: 'exact' | 'fingerprint-match';
  matchedValue: unknown;
}

function findStoreMatch(
  target: unknown,
  targetFp: string,
  deadline: number,
): StoreMatchResult | null {
  // Zustand — iterate each named store.
  for (const [storeName, state] of getZustandSnapshot()) {
    if (now() > deadline) return null;
    const hit = findMatchingPathInObject(target, targetFp, state, [], 0, deadline);
    if (hit) {
      return {
        source: 'zustand',
        storeName,
        keyPath: hit.path,
        confidence: hit.confidence,
        matchedValue: walkPath(state, hit.path),
      };
    }
  }

  // Redux — single store.
  const redux = getReduxSnapshot();
  if (redux) {
    if (now() > deadline) return null;
    const hit = findMatchingPathInObject(target, targetFp, redux, [], 0, deadline);
    if (hit) {
      return {
        source: 'redux',
        storeName: 'redux',
        keyPath: hit.path,
        confidence: hit.confidence,
        matchedValue: walkPath(redux, hit.path),
      };
    }
  }

  // TanStack Query — each query's data, keyed by hash.
  for (const [queryHash, entry] of getTanstackSnapshot()) {
    if (now() > deadline) return null;
    const hit = findMatchingPathInObject(target, targetFp, entry.data, [], 0, deadline);
    if (hit) {
      return {
        source: 'tanstack-query',
        storeName: queryHash,
        keyPath: hit.path,
        confidence: hit.confidence,
        matchedValue: walkPath(entry.data, hit.path),
      };
    }
  }

  return null;
}
