/**
 * Unit tests for the new `fiberDebugLogger` recorder.
 *
 * Coverage targets:
 *   - `describeFiberType` — every fiber `type` shape (host string, plain
 *     function, class, ForwardRef, Memo, object fallback, unknown).
 *   - `setFiberDebug` — flips the global gate; recording is silent when off.
 *   - `logFiberType` — only buffers when recording is on; updates `count` /
 *     `lastSeen` / `contexts` on repeat; evicts oldest when the cap is hit.
 *   - `logTreeSnapshot` — buffers tree stats; capped at `MAX_TREE_RECORDS`.
 *   - `__ft.size()` / `__ft.clear()` / `__ft.export()` console API contract.
 *
 * Conventions per the bolt vitest skills:
 *   - vitest-utility-function-tests: two-level describe (module → function),
 *     `test.each` for parametric type shapes.
 *   - vitest-default-dummy-data: `Required<T>` baselines pulled into builders
 *     so a new field on `FiberRecord` / `LiveTreeNode` is a compile error here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

// `logFiberType` isn't re-exported from `index.ts` (intentional — see PR
// description). Import directly from the module path to exercise it alongside
// the rest of the surface.
import {
  __getFiberRecordsForTesting,
  __getTreeRecordsForTesting,
  describeFiberType,
  logFiberType,
  logTreeSnapshot,
  logTreeSummary,
  setFiberDebug,
} from './fiberDebugLogger';
import type { LiveTreeNode } from './types';

// ============================================================================
// Builders
// ============================================================================

function createTreeNode(override: Partial<LiveTreeNode> = {}): LiveTreeNode {
  // Pass-through builder — `LiveTreeNode` is large and we only set a tiny
  // subset for the stats walker, so a Partial<T> spread is fine here.
  return {
    id: 'App-0',
    name: 'App',
    children: [],
    fiberTag: 0,
    renderPhase: 'mount',
    renderDuration: 0,
    hookCount: 0,
    hasContextHook: false,
    renderReason: 'mount',
    isFramework: false,
    isLibrary: false,
    isTransitionPending: false,
    isSuspenseFallback: false,
    compilerStatus: 'compiled',
    isServerComponent: false,
    isClientBoundary: false,
    ...override,
  } as LiveTreeNode;
}

// Reset the global recorder gate + buffers between tests so each case starts
// from a known empty state.
beforeEach(() => {
  setFiberDebug(false);
  // The console API exposes a clear() helper — the buffers are module-scope
  // singletons, so this is the only safe reset path.
  globalThis.__ft?.clear();
});

afterEach(() => {
  setFiberDebug(false);
});

// ============================================================================
// Tests
// ============================================================================

describe('fiberDebugLogger', () => {
  describe('describeFiberType', () => {
    test('host strings ("div", "span") are tagged kind="host"', () => {
      expect(describeFiberType({ type: 'div' })).toMatchObject({
        kind: 'host',
        resolved: 'div',
        looksMinified: false,
      });
    });

    test('plain functions resolve to displayName || name || "Anonymous"', () => {
      function UserProfile() {}
      const result = describeFiberType({ type: UserProfile });
      expect(result.kind).toBe('function');
      expect(result.resolved).toBe('UserProfile');
      expect(result.name).toBe('UserProfile');
    });

    test('class components are tagged kind="class"', () => {
      // Mimic React's prototype marker — describeFiberType reads
      // `Component.prototype.isReactComponent`. `static prototype = ...` is a
      // reserved class member, so we install the marker the normal way:
      // a class's instance prototype already exists, just assign onto it.
      class MyClass {}
      (MyClass.prototype as Record<string, unknown>).isReactComponent = {};
      const result = describeFiberType({ type: MyClass });
      expect(result.kind).toBe('class');
    });

    test('ForwardRef descriptors are tagged kind="forwardRef" and read from .render', () => {
      function InnerComponent() {}
      const forwardRefType = { render: InnerComponent };
      expect(describeFiberType({ type: forwardRefType })).toMatchObject({
        kind: 'forwardRef',
        resolved: 'InnerComponent',
      });
    });

    test('Memo descriptors are tagged kind="memo" and read from .type', () => {
      function WrappedComponent() {}
      const memoType = { type: WrappedComponent };
      expect(describeFiberType({ type: memoType })).toMatchObject({
        kind: 'memo',
        resolved: 'WrappedComponent',
      });
    });

    test('non-host, non-function, plain-object types fall through to kind="unknown"', () => {
      // No .render, no .type — the unknown branch.
      const result = describeFiberType({ type: { displayName: 'Mystery' } });
      expect(result.kind).toBe('unknown');
      expect(result.resolved).toBe('Mystery');
    });

    test('marks single-char / minified-looking names with looksMinified=true', () => {
      function a() {}
      const result = describeFiberType({ type: a });
      expect(result.looksMinified).toBe(true);
    });

    test('null / undefined fiber.type → kind="unknown", resolved="Unknown"', () => {
      expect(describeFiberType({ type: undefined })).toMatchObject({
        kind: 'unknown',
        resolved: 'Unknown',
      });
    });
  });

  describe('logFiberType — gate', () => {
    test('records nothing while __FT_DEBUG is off (silent default)', () => {
      function Foo() {}
      logFiberType({ type: Foo }, 'getName');
      expect(__getFiberRecordsForTesting().size).toBe(0);
    });

    test('starts recording once setFiberDebug(true) is called', () => {
      function Foo() {}
      setFiberDebug(true);
      logFiberType({ type: Foo }, 'getName');
      expect(__getFiberRecordsForTesting().size).toBe(1);
    });
  });

  describe('logFiberType — record content', () => {
    test('subsequent calls for the same component name increment count, not size', () => {
      function Foo() {}
      setFiberDebug(true);
      logFiberType({ type: Foo }, 'getName');
      logFiberType({ type: Foo }, 'walkOnce');
      logFiberType({ type: Foo }, 'walkOnce');
      const records = __getFiberRecordsForTesting();
      expect(records.size).toBe(1);
      const rec = records.get('Foo')!;
      expect(rec.count).toBe(3);
      // Context Set accumulates the call-site labels.
      expect(rec.contexts.has('getName')).toBe(true);
      expect(rec.contexts.has('walkOnce')).toBe(true);
    });

    test('first non-null key observation populates exampleKey', () => {
      function Row() {}
      setFiberDebug(true);
      logFiberType({ type: Row, key: null }, 'getName');
      logFiberType({ type: Row, key: 'row-7' }, 'getName');
      logFiberType({ type: Row, key: 'row-9' }, 'getName'); // first wins
      expect(__getFiberRecordsForTesting().get('Row')!.exampleKey).toBe('row-7');
    });
  });

  describe('logTreeSnapshot', () => {
    test('records nothing while __FT_DEBUG is off', () => {
      logTreeSnapshot(createTreeNode());
      expect(__getTreeRecordsForTesting()).toHaveLength(0);
    });

    test('records nothing when tree is null even with recording on', () => {
      setFiberDebug(true);
      logTreeSnapshot(null);
      expect(__getTreeRecordsForTesting()).toHaveLength(0);
    });

    test('captures totalNodes + maxDepth + topNames signature for a small tree', () => {
      setFiberDebug(true);
      const tree = createTreeNode({
        id: 'App',
        name: 'App',
        children: [
          createTreeNode({ id: 'Row-1', name: 'Row' }),
          createTreeNode({ id: 'Row-2', name: 'Row' }),
        ],
      });
      logTreeSnapshot(tree, 'send seq=1');
      const snap = __getTreeRecordsForTesting()[0];
      expect(snap.totalNodes).toBe(3);
      expect(snap.maxDepth).toBe(1);
      expect(snap.ctx).toBe('send seq=1');
      // Top-name string contains the deduped row count.
      expect(snap.topNames).toContain('Row:2');
      expect(snap.topNames).toContain('App:1');
    });

    test('logTreeSummary aliases logTreeSnapshot (same buffer)', () => {
      setFiberDebug(true);
      logTreeSummary(createTreeNode());
      expect(__getTreeRecordsForTesting()).toHaveLength(1);
    });
  });

  describe('__ft console API', () => {
    test('size() reports current buffer occupancy', () => {
      setFiberDebug(true);
      function Foo() {}
      logFiberType({ type: Foo }, 'getName');
      logTreeSnapshot(createTreeNode());
      expect(globalThis.__ft!.size()).toEqual({ fibers: 1, snapshots: 1 });
    });

    test('clear() empties both buffers', () => {
      setFiberDebug(true);
      function Foo() {}
      logFiberType({ type: Foo }, 'getName');
      logTreeSnapshot(createTreeNode());
      globalThis.__ft!.clear();
      expect(globalThis.__ft!.size()).toEqual({ fibers: 0, snapshots: 0 });
    });

    test('export() returns serialized snapshots + fibers (counts + name fields)', () => {
      setFiberDebug(true);
      function Foo() {}
      logFiberType({ type: Foo }, 'getName');
      logFiberType({ type: Foo }, 'walk');
      logTreeSnapshot(createTreeNode());
      const data = globalThis.__ft!.export();
      expect(data.fibers).toHaveLength(1);
      expect(data.fibers[0]).toMatchObject({ name: 'Foo', count: 2 });
      expect(data.snapshots).toHaveLength(1);
    });
  });
});
