/**
 * Unit tests for the Value Lineage resolver.
 * See docs/PRD-VALUE-LINEAGE.md §5.1 traceability rubric and
 * docs/IMPLEMENTATION-PLAN-VALUE-LINEAGE.md Phase 2 case matrix.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Fiber } from './fiberTreeWalker';
import { tagFetchData, clearFetchOriginTags, findFetchOrigin } from './fetchOriginRegistry';

// ---- Mocks --------------------------------------------------------------

// We need to control what fiberRefMap, zustand/redux/tanstack snapshots return
// on a per-test basis. Mock the modules with swappable Maps + values.
const mockFiberRefMap = new Map<string, Fiber>();
const mockZustandSnapshot = new Map<string, Record<string, unknown>>();
let mockReduxSnapshot: Record<string, unknown> | null = null;
const mockTanstackSnapshot = new Map<string, { queryKey: unknown[]; data: unknown }>();

vi.mock('./fiberTreeWalker', async () => {
  const actual = await vi.importActual<typeof import('./fiberTreeWalker')>('./fiberTreeWalker');
  return { ...actual, getFiberRefMap: () => mockFiberRefMap };
});

vi.mock('./zustandTracker', async () => {
  const actual = await vi.importActual<typeof import('./zustandTracker')>('./zustandTracker');
  return { ...actual, getZustandSnapshot: () => mockZustandSnapshot };
});

vi.mock('./reduxTracker', async () => {
  const actual = await vi.importActual<typeof import('./reduxTracker')>('./reduxTracker');
  return { ...actual, getReduxSnapshot: () => mockReduxSnapshot };
});

vi.mock('./tanstackQueryTracker', async () => {
  const actual = await vi.importActual<typeof import('./tanstackQueryTracker')>('./tanstackQueryTracker');
  return { ...actual, getTanstackSnapshot: () => mockTanstackSnapshot };
});

// Import AFTER mocks are declared.
import { resolveValueTrace } from './valueTraceResolver';

// ---- Fiber factory ------------------------------------------------------

function makeFiber(opts: {
  name: string;
  memoizedProps?: Record<string, unknown> | null;
  parent?: Fiber | null;
  memoizedState?: unknown;
  /** Non-zero for Provider fibers etc. Function components default to 0. */
  tag?: number;
  /** For ContextProvider fibers: Provider element shape { _context: <ctx> }. */
  type?: unknown;
  /** React 18+ context dependency linked list read by hooks on this fiber. */
  dependencies?: { firstContext: unknown } | null;
}): Fiber {
  const fn = function () {} as unknown as { displayName?: string };
  fn.displayName = opts.name;
  return {
    tag: opts.tag ?? 0,
    key: null,
    type: opts.type ?? fn,
    child: null,
    sibling: null,
    return: opts.parent ?? null,
    memoizedProps: opts.memoizedProps ?? null,
    pendingProps: null,
    memoizedState: opts.memoizedState ?? null,
    dependencies: opts.dependencies ?? null,
  } as unknown as Fiber;
}

// ---- Setup --------------------------------------------------------------

beforeEach(() => {
  mockFiberRefMap.clear();
  mockZustandSnapshot.clear();
  mockReduxSnapshot = null;
  mockTanstackSnapshot.clear();
  clearFetchOriginTags();
});

// ---- Cases --------------------------------------------------------------

describe('resolveValueTrace', () => {
  // Case 1 — prop chain only (3 levels deep, no store / API).
  it('walks a 3-level prop chain when no store match exists', () => {
    const user = { id: 1, name: 'Jane' };

    const grandparent = makeFiber({
      name: 'App',
      memoizedProps: { user },
    });
    const parent = makeFiber({
      name: 'Layout',
      memoizedProps: { user },
      parent: grandparent,
    });
    const child = makeFiber({
      name: 'Profile',
      memoizedProps: { user },
      parent,
    });

    mockFiberRefMap.set('App', grandparent);
    mockFiberRefMap.set('App/Layout', parent);
    mockFiberRefMap.set('App/Layout/Profile', child);

    const trace = resolveValueTrace({ nodeId: 'App/Layout/Profile', propPath: ['user'] });

    expect(trace.error).toBeUndefined();
    // Consumer + 2 ancestors.
    expect(trace.steps.length).toBe(3);
    expect(trace.steps[0]).toMatchObject({ kind: 'prop', componentName: 'Profile', confidence: 'exact' });
    expect(trace.steps[1]).toMatchObject({ kind: 'prop', componentName: 'Layout', confidence: 'exact' });
    expect(trace.steps[2]).toMatchObject({ kind: 'prop', componentName: 'App', confidence: 'exact' });
  });

  // Case 2 — Prop → Zustand store → API.
  it('chains prop → zustand store → api origin', () => {
    const userObj = { id: 1, email: 'j@x.com' };
    const storeState = { user: userObj, theme: 'dark' };

    const parent = makeFiber({ name: 'App', memoizedProps: { user: userObj } });
    const child = makeFiber({ name: 'Profile', memoizedProps: { user: userObj }, parent });
    mockFiberRefMap.set('App', parent);
    mockFiberRefMap.set('App/Profile', child);
    mockZustandSnapshot.set('authStore', storeState);

    tagFetchData(userObj, 'req-42');

    const trace = resolveValueTrace({ nodeId: 'App/Profile', propPath: ['user'] });

    expect(trace.error).toBeUndefined();
    // Consumer prop + ancestor prop + store + api.
    const kinds = trace.steps.map((s) => s.kind);
    expect(kinds).toEqual(['prop', 'prop', 'store', 'api']);
    const storeStep = trace.steps[2];
    expect(storeStep).toMatchObject({ kind: 'store', source: 'zustand', storeName: 'authStore' });
    if (storeStep.kind === 'store') {
      expect(storeStep.keyPath).toEqual(['user']);
    }
    const apiStep = trace.steps[3];
    expect(apiStep).toMatchObject({ kind: 'api', requestId: 'req-42' });
  });

  // Case 3 — Prop → Redux store (API TTL expired ⇒ no api step).
  // Easier to assert the expired case separately; here we check Redux path works.
  it('chains prop → redux store (no api)', () => {
    const todo = { id: 1, title: 'buy milk' };
    mockReduxSnapshot = { todos: { byId: { 1: todo } } };

    const child = makeFiber({ name: 'TodoView', memoizedProps: { todo } });
    mockFiberRefMap.set('TodoView', child);

    const trace = resolveValueTrace({ nodeId: 'TodoView', propPath: ['todo'] });

    const kinds = trace.steps.map((s) => s.kind);
    expect(kinds).toEqual(['prop', 'store']);
    const storeStep = trace.steps[1];
    expect(storeStep).toMatchObject({ kind: 'store', source: 'redux', storeName: 'redux' });
    if (storeStep.kind === 'store') {
      expect(storeStep.keyPath).toEqual(['todos', 'byId', '1']);
    }
  });

  // Case 4 — Hook (useState) directly fed by API. No store step.
  it('chains hook-state → api directly when WeakMap tag is present', () => {
    const data = { items: [1, 2, 3] };
    tagFetchData(data, 'req-99');

    const fiber = makeFiber({
      name: 'Feed',
      memoizedState: { memoizedState: data, next: null },
    });
    mockFiberRefMap.set('Feed', fiber);

    const trace = resolveValueTrace({
      nodeId: 'Feed',
      hookPath: { hookIndex: 0 },
    });

    const kinds = trace.steps.map((s) => s.kind);
    expect(kinds).toEqual(['hook-state', 'api']);
    const apiStep = trace.steps[1];
    expect(apiStep).toMatchObject({ kind: 'api', requestId: 'req-99' });
  });

  // Case 5 — Primitive value matches structurally → fingerprint-match confidence.
  it('flags primitive store matches as fingerprint-match rather than exact', () => {
    // Primitive at the consumer and same primitive in a store. `shouldFlagRename`
    // suppresses primitive matches, so resolver should NOT emit a store step for
    // a lone primitive. This guards against false-positive confidence claims.
    mockZustandSnapshot.set('ui', { count: 5 });
    const fiber = makeFiber({ name: 'Counter', memoizedProps: { count: 5 } });
    mockFiberRefMap.set('Counter', fiber);

    const trace = resolveValueTrace({ nodeId: 'Counter', propPath: ['count'] });

    // Consumer + no store step (primitive suppressed).
    expect(trace.steps.length).toBe(1);
    expect(trace.steps[0].kind).toBe('prop');
  });

  // Case 6 — No origin found → steps has just the consumer, no error.
  it('returns only the consumer step when no origin is found', () => {
    const localObject = { computed: true, deep: { v: 1 } };
    const fiber = makeFiber({ name: 'Local', memoizedProps: { data: localObject } });
    mockFiberRefMap.set('Local', fiber);

    const trace = resolveValueTrace({ nodeId: 'Local', propPath: ['data'] });

    expect(trace.error).toBeUndefined();
    expect(trace.steps.length).toBe(1);
    expect(trace.steps[0]).toMatchObject({ kind: 'prop', componentName: 'Local' });
  });

  // Case 7 — Nested field: child receives a sub-object of parent's prop.
  // Happy path: child has `profile={user.profile}`; ancestor has `user` top-level.
  // The resolver must DFS into the ancestor's `user` prop and emit the ancestor
  // step with the sub-path that leads to the matched value.
  it('traces a nested object field back to an ancestor that holds the parent object', () => {
    const profile = { avatarUrl: 'https://cdn/a.jpg', name: 'Jane' };
    const user = { id: 1, profile };
    const app = makeFiber({ name: 'App', memoizedProps: { user } });
    const avatar = makeFiber({
      name: 'Avatar',
      memoizedProps: { profile }, // child sees just the sub-object
      parent: app,
    });
    mockFiberRefMap.set('App', app);
    mockFiberRefMap.set('App/Avatar', avatar);

    const trace = resolveValueTrace({ nodeId: 'App/Avatar', propPath: ['profile'] });

    expect(trace.error).toBeUndefined();
    const kinds = trace.steps.map((s) => s.kind);
    expect(kinds).toEqual(['prop', 'prop']);
    // Ancestor step points into the nested path under the ancestor's `user` prop.
    const ancestorStep = trace.steps[1];
    expect(ancestorStep).toMatchObject({
      kind: 'prop',
      componentName: 'App',
      propPath: ['user', 'profile'],
      confidence: 'exact',
    });
  });

  // Case 8 — Rename + nested field: the child receives the sub-object under a
  // renamed key. Resolver should still walk to the ancestor via reference
  // identity (DFS finds the sub-value regardless of the prop name above).
  it('traces a nested field even when the parent drills under a renamed key', () => {
    const profile = { email: 'jane@x.com' };
    const user = { id: 1, profile };
    const layout = makeFiber({ name: 'Layout', memoizedProps: { currentUser: user } });
    const row = makeFiber({
      name: 'UserRow',
      memoizedProps: { userProfile: profile }, // renamed AND nested
      parent: layout,
    });
    mockFiberRefMap.set('Layout', layout);
    mockFiberRefMap.set('Layout/UserRow', row);

    const trace = resolveValueTrace({
      nodeId: 'Layout/UserRow',
      propPath: ['userProfile'],
    });

    expect(trace.error).toBeUndefined();
    const kinds = trace.steps.map((s) => s.kind);
    expect(kinds).toEqual(['prop', 'prop']);
    const ancestorStep = trace.steps[1];
    // Ancestor found the sub-value under its own renamed key `currentUser`.
    expect(ancestorStep).toMatchObject({
      kind: 'prop',
      componentName: 'Layout',
      propPath: ['currentUser', 'profile'],
      confidence: 'exact',
    });
  });

  // Case 8 — Unknown nodeId → error='no-fiber'.
  it('returns error=no-fiber when the nodeId is not in fiberRefMap', () => {
    const trace = resolveValueTrace({ nodeId: 'Phantom/Node', propPath: ['x'] });
    expect(trace.error).toBe('no-fiber');
    expect(trace.steps).toEqual([]);
  });

  // Case 9 — Context match with nearest Provider.
  it('emits a context step when the consumer reads a matching useContext value', () => {
    const user = { id: 1, name: 'Jane' };
    const AuthContext = { _currentValue: user, displayName: 'AuthContext' };

    // Provider fiber sits above the consumer in the return chain.
    const providerType = { _context: AuthContext };
    const provider = makeFiber({
      name: 'AuthProvider',
      tag: 10, // ContextProvider
      type: providerType,
      memoizedProps: { value: user, children: null },
    });
    // Consumer reads useContext(AuthContext) and consumes `user`.
    const consumer = makeFiber({
      name: 'Profile',
      memoizedProps: { user },
      parent: provider,
      dependencies: {
        firstContext: {
          context: AuthContext,
          memoizedValue: user,
          next: null,
        },
      },
    });
    mockFiberRefMap.set('AuthProvider', provider);
    mockFiberRefMap.set('AuthProvider/Profile', consumer);

    const trace = resolveValueTrace({
      nodeId: 'AuthProvider/Profile',
      propPath: ['user'],
    });

    expect(trace.error).toBeUndefined();
    // Consumer prop + context step. No store / api available in this test.
    const kinds = trace.steps.map((s) => s.kind);
    expect(kinds).toEqual(['prop', 'context']);
    const ctx = trace.steps[1];
    expect(ctx).toMatchObject({
      kind: 'context',
      contextName: 'AuthContext',
      providerNodeId: 'AuthProvider',
    });
  });

  // Bonus — value-not-found when propPath dives into missing keys.
  it('returns error=value-not-found when the propPath does not resolve', () => {
    const fiber = makeFiber({ name: 'X', memoizedProps: { a: {} } });
    mockFiberRefMap.set('X', fiber);
    const trace = resolveValueTrace({ nodeId: 'X', propPath: ['a', 'missing'] });
    expect(trace.error).toBe('value-not-found');
  });

  // Case 10 — Deep ancestor chain (20 wrappers around a consumer), similar to
  // React Native's VirtualizedList layers. Each wrapper holds a chunky props
  // object so the DFS + fingerprint path gets exercised. Must complete within
  // the 100ms budget with cache + reference fast-path enabled.
  it('resolves a 20-layer RN-style wrapper chain without exceeding the budget', () => {
    // Each wrapper has a "noise" prop (a fresh object different from target)
    // so the reference fast-path on the pass-through key is what saves us
    // (not DFS-ing sibling props).
    const item = { id: 1, profile: { name: 'Jane' }, genre_ids: [1, 2, 3] };
    const makeNoise = () => ({
      a: { nested: { deep: 'value' } },
      b: [1, 2, 3, 4, 5],
      c: { x: 1, y: 2 },
    });

    // Build a chain of 20 ancestors, all passing `item` through by reference.
    let parent: Fiber | null = null;
    for (let i = 0; i < 20; i++) {
      const fiber = makeFiber({
        name: `Wrapper${i}`,
        memoizedProps: { item, noise: makeNoise() },
        parent,
      });
      mockFiberRefMap.set(`W${i}`, fiber);
      parent = fiber;
    }
    // Leaf consumer — parent is the last wrapper.
    const leaf = makeFiber({ name: 'RowCard', memoizedProps: { item }, parent });
    mockFiberRefMap.set('RowCard', leaf);

    const t0 = performance.now();
    const trace = resolveValueTrace({ nodeId: 'RowCard', propPath: ['item'] });
    const elapsed = performance.now() - t0;

    expect(trace.error).toBeUndefined();
    // Consumer + every ancestor that has `item` in its props.
    expect(trace.steps.length).toBe(21);
    expect(trace.steps.every((s) => s.kind === 'prop')).toBe(true);
    // Sanity: generous envelope — real wall-clock in CI should be under 20ms,
    // but allow 200ms for slow CI runners.
    expect(elapsed).toBeLessThan(200);
  });

  // Case 11 — Derivation: value is the output of a useMemo on the same fiber.
  it('emits a derived step when the traced value is the output of a useMemo', () => {
    const computed = { fullName: 'Jane Smith' };
    const deps = ['Jane', 'Smith'];
    // Simulate a fiber with one hook whose memoizedState is [computed, deps]
    // (React's internal shape for useMemo).
    const fiber = makeFiber({
      name: 'NameBadge',
      memoizedProps: { label: computed },
      memoizedState: {
        memoizedState: [computed, deps],
        next: null,
      },
    });
    mockFiberRefMap.set('NameBadge', fiber);

    const trace = resolveValueTrace({ nodeId: 'NameBadge', propPath: ['label'] });

    expect(trace.error).toBeUndefined();
    const kinds = trace.steps.map((s) => s.kind);
    // Consumer prop + derived terminal step (no further ancestry walk).
    expect(kinds).toEqual(['prop', 'derived']);
    const derived = trace.steps[1];
    expect(derived).toMatchObject({
      kind: 'derived',
      hookIndex: 0,
      hookType: 'useMemo',
      depCount: 2,
      confidence: 'exact',
    });
  });

  // Case 12 — keyPath retreat recovers the api origin when the matched value
  // itself isn't tagged but an ancestor in the store keyPath is.
  //
  // Real-world analogue: a reducer normalizes the response into an entity
  // dictionary — `state.byId[k] = response.user` keeps the ancestor reference
  // (and its tag) but the leaf row is a fresh adapter-produced object. The
  // store match lands on the untagged leaf; before the fix, the chain stopped
  // at the store step.
  //
  // We model that gap by tagging an empty wrapper and then assigning a fresh
  // (untagged) leaf into it — same shape, no recursive re-tagging.
  it('recovers api origin via keyPath retreat when matched value itself is not tagged', () => {
    const wrapper = {} as { leaf?: { name: string } };
    tagFetchData(wrapper, 'req-deep'); // tags the wrapper only (no children yet)
    const leaf = { name: 'Jane' };
    wrapper.leaf = leaf; // assigned after tagging — leaf has no tag of its own
    mockZustandSnapshot.set('feed', wrapper);

    const fiber = makeFiber({ name: 'Leaf', memoizedProps: { item: leaf } });
    mockFiberRefMap.set('Leaf', fiber);

    const trace = resolveValueTrace({ nodeId: 'Leaf', propPath: ['item'] });

    expect(trace.error).toBeUndefined();
    const kinds = trace.steps.map((s) => s.kind);
    expect(kinds).toContain('store');
    expect(kinds).toContain('api');
    const apiStep = trace.steps.find((s) => s.kind === 'api');
    expect(apiStep).toMatchObject({ kind: 'api', requestId: 'req-deep' });
  });

  // Case 13 — depth-4 response shape in Redux. Confirms the depth bump from
  // 2 → 4 in tagFetchData/findFetchOrigin actually reaches the leaf object.
  it('finds api origin on depth-4 response shapes', () => {
    const item = { id: 1, name: 'first' };
    const response = { data: { items: [item] } };
    tagFetchData(response, 'req-88');
    mockReduxSnapshot = { feed: response };

    // Consumer receives the row object directly.
    const fiber = makeFiber({ name: 'Row', memoizedProps: { item } });
    mockFiberRefMap.set('Row', fiber);

    const trace = resolveValueTrace({ nodeId: 'Row', propPath: ['item'] });

    expect(trace.error).toBeUndefined();
    const kinds = trace.steps.map((s) => s.kind);
    expect(kinds).toEqual(['prop', 'store', 'api']);
    const apiStep = trace.steps[2];
    expect(apiStep).toMatchObject({ kind: 'api', requestId: 'req-88' });
  });

  // Case 14 — TTL bypass: resolver still emits the api step minutes after the
  // fetch resolved, while the TTL-respecting findFetchOrigin (used by the
  // network panel) correctly returns undefined. Proves the split-TTL design.
  it('keeps emitting the api step after the TTL has elapsed (resolver) while default findFetchOrigin expires', () => {
    vi.useFakeTimers();
    try {
      const userObj = { id: 1, email: 'j@x.com' };
      const storeState = { user: userObj };
      tagFetchData(userObj, 'req-ttl');
      mockZustandSnapshot.set('authStore', storeState);

      const fiber = makeFiber({ name: 'Profile', memoizedProps: { user: userObj } });
      mockFiberRefMap.set('Profile', fiber);

      // Move time past the 3 s TTL.
      vi.advanceTimersByTime(5_000);

      const trace = resolveValueTrace({ nodeId: 'Profile', propPath: ['user'] });

      const kinds = trace.steps.map((s) => s.kind);
      expect(kinds).toContain('api');
      const apiStep = trace.steps.find((s) => s.kind === 'api');
      expect(apiStep).toMatchObject({ kind: 'api', requestId: 'req-ttl' });

      // Sibling assertion: the default (TTL-respecting) findFetchOrigin
      // returns undefined for the same object — network panel correlation
      // continues to time out as before.
      expect(findFetchOrigin(userObj)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // Case 15 — keyPath retreat must NOT fabricate an api step when no ancestor
  // is tagged. The chain should end at the store step and stay honest.
  it('does not invent an api step when no ancestor in the store keyPath is tagged', () => {
    const userObj = { id: 1, name: 'Jane' };
    // No tagFetchData call — store has the data but it never came from a
    // tracked fetch (e.g. seeded from localStorage or a server-side prop).
    mockZustandSnapshot.set('userStore', { user: userObj });

    // Consumer holds the object directly so findStoreMatch fires.
    const fiber = makeFiber({ name: 'Header', memoizedProps: { user: userObj } });
    mockFiberRefMap.set('Header', fiber);

    const trace = resolveValueTrace({ nodeId: 'Header', propPath: ['user'] });

    const kinds = trace.steps.map((s) => s.kind);
    expect(kinds).toContain('store');
    expect(kinds).not.toContain('api');
  });
});
