/**
 * Fiber debug recorder — buffers fiber + LiveTreeNode observations into
 * capped in-memory tables, then dumps them to the console *on demand*.
 *
 * Why not log eagerly? `getComponentName` runs once per fiber per commit.
 * A 200-node tree at 60Hz produces ~12k console entries/sec, which OOMs
 * DevTools. The recorder keeps recording silent until you ask for a dump.
 *
 * Usage (from any console — Next.js app, FloTrace renderer, Electron main):
 *   globalThis.__FT_DEBUG = true   // start recording
 *   __ft.dump()                    // print digest (fibers + snapshots)
 *   __ft.fibers()                  // just the fiber-name table
 *   __ft.snapshots()               // just the snapshot timeline
 *   __ft.tail(20)                  // recent activity
 *   __ft.clear()                   // reset buffers
 *   __ft.export()                  // returns a JSON object
 *   __ft.download()                // browser-only: save buffers as JSON
 *   __ft.size()                    // current buffer sizes
 *
 * All recorders are no-ops when __FT_DEBUG is falsy, so the wired call
 * sites cost ~1 boolean check each.
 */

import type { LiveTreeNode } from './types';

// ---------------------------------------------------------------------------
// Caps — bound memory regardless of how long recording runs.
// ---------------------------------------------------------------------------

const MAX_FIBER_RECORDS = 500;     // unique component names
const MAX_TREE_RECORDS = 50;       // snapshot history depth
const MAX_TOP_NAMES_PER_SNAPSHOT = 10;
const MAX_CONTEXTS_PER_FIBER = 8;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface FiberRecord {
  /** Resolved component name (what FloTrace ultimately shows on the node). */
  name: string;
  /** Raw `fiber.type.name` — present even for ForwardRef/Memo's inner render. */
  rawName: string | undefined;
  /** Raw `fiber.type.displayName` — what the author explicitly set. */
  rawDisplayName: string | undefined;
  kind: 'function' | 'class' | 'forwardRef' | 'memo' | 'host' | 'unknown';
  /** Fiber tag number (0=Function, 1=Class, 11=ForwardRef, 14=Memo, etc.). */
  fiberTag: number | undefined;
  looksMinified: boolean;
  count: number;
  contexts: Set<string>;
  firstSeen: number;
  lastSeen: number;
  /** First captured _debugSource (if any) — only available in dev builds. */
  source?: { fileName?: string; lineNumber?: number };
  /** First non-null react key observed (useful for diagnosing list rows). */
  exampleKey?: string;
}

let totalFiberEvents = 0;
let recordingStartedAt: number | null = null;

interface TreeRecord {
  ts: number;
  ctx: string;
  rootName: string;
  totalNodes: number;
  maxDepth: number;
  minifiedLike: number;
  topNames: string;
}

const fiberRecords = new Map<string, FiberRecord>();
const treeRecords: TreeRecord[] = [];

// Ambient globals — the `__FT_DEBUG` toggle and `__ft` console API are
// reachable from any environment via `globalThis`. Declaring them once here
// (instead of per-call `globalThis as DebugGlobal` casts) means every reader/
// writer sees the same type and adding a new field is a one-line change.
declare global {
  // eslint-disable-next-line no-var
  var __FT_DEBUG: boolean | undefined;
  // eslint-disable-next-line no-var
  var __ft: FtConsoleApi | undefined;
}

function isRecording(): boolean {
  return Boolean(globalThis.__FT_DEBUG);
}

// ---------------------------------------------------------------------------
// Public toggle
// ---------------------------------------------------------------------------

export function setFiberDebug(enabled: boolean): void {
  globalThis.__FT_DEBUG = enabled;
  if (enabled) {
    // eslint-disable-next-line no-console
    console.info(
      '%c[FT debug]%c recording started — call %c__ft.dump()%c to view, %c__ft.clear()%c to reset, %c__ft.download()%c to export',
      'background:#1e293b;color:#7dd3fc;padding:1px 6px;border-radius:3px;font-weight:600;',
      'color:#94a3b8;',
      'color:#a78bfa;font-weight:600;',
      'color:#94a3b8;',
      'color:#a78bfa;font-weight:600;',
      'color:#94a3b8;',
      'color:#a78bfa;font-weight:600;',
      'color:#94a3b8;',
    );
  }
}

// ---------------------------------------------------------------------------
// Raw fiber inspection — same shape as before, still exported.
// ---------------------------------------------------------------------------

type FiberLike = {
  tag?: number;
  type?: unknown;
  key?: string | null;
  _debugSource?: { fileName?: string; lineNumber?: number } | null;
};

type FiberTypeLike = {
  name?: string;
  displayName?: string;
  type?: FiberTypeLike;
  render?: FiberTypeLike;
};

/**
 * Narrows an unknown fiber `type` value to `FiberTypeLike` when it's a
 * function. JavaScript functions are objects, so reading `.name`, `.displayName`,
 * and `.prototype` off them is safe — this guard just brands the narrowing so
 * downstream code doesn't repeat the cast.
 */
function isFiberFunctionType(t: unknown): t is FiberTypeLike & ((...args: unknown[]) => unknown) {
  return typeof t === 'function';
}

/**
 * Narrows an unknown fiber `type` value to `FiberTypeLike` when it's a
 * non-null object — covers ForwardRef, Memo, Context, and the various
 * symbol-tagged React internal types.
 */
function isFiberObjectType(t: unknown): t is FiberTypeLike {
  return typeof t === 'object' && t !== null;
}

/**
 * Detects React class components by looking at `Component.prototype.isReactComponent`,
 * the same marker React itself uses internally. Returns false for any non-function
 * input (functional components, ForwardRef, host strings, etc.).
 */
function isClassComponentType(t: unknown): boolean {
  if (typeof t !== 'function') return false;
  const proto = (t as { prototype?: { isReactComponent?: unknown } }).prototype;
  return typeof proto?.isReactComponent !== 'undefined';
}

export function describeFiberType(fiber: FiberLike): {
  kind: FiberRecord['kind'];
  name: string | undefined;
  displayName: string | undefined;
  resolved: string;
  looksMinified: boolean;
} {
  const type = fiber.type;

  if (typeof type === 'string') {
    return { kind: 'host', name: type, displayName: undefined, resolved: type, looksMinified: false };
  }

  if (isFiberFunctionType(type)) {
    const isClass = isClassComponentType(type);
    const resolved = type.displayName ?? type.name ?? 'Anonymous';
    return {
      kind: isClass ? 'class' : 'function',
      name: type.name,
      displayName: type.displayName,
      resolved,
      looksMinified: looksMinified(resolved),
    };
  }

  if (isFiberObjectType(type)) {
    if (type.render) {
      const resolved = type.render.displayName ?? type.render.name ?? 'ForwardRef';
      return {
        kind: 'forwardRef',
        name: type.render.name,
        displayName: type.render.displayName,
        resolved,
        looksMinified: looksMinified(resolved),
      };
    }
    if (type.type) {
      const resolved = type.type.displayName ?? type.type.name ?? 'Memo';
      return {
        kind: 'memo',
        name: type.type.name,
        displayName: type.type.displayName,
        resolved,
        looksMinified: looksMinified(resolved),
      };
    }
    const resolved = type.displayName ?? type.name ?? 'Unknown';
    return { kind: 'unknown', name: type.name, displayName: type.displayName, resolved, looksMinified: looksMinified(resolved) };
  }

  return { kind: 'unknown', name: undefined, displayName: undefined, resolved: 'Unknown', looksMinified: false };
}

function looksMinified(name: string): boolean {
  return /^[a-z_$][a-z0-9_$]?$/i.test(name);
}

// ---------------------------------------------------------------------------
// Recorders (same call signatures as before — no rewiring needed).
// ---------------------------------------------------------------------------

export function logFiberType(fiber: FiberLike, context?: string): void {
  if (!isRecording()) return;
  const info = describeFiberType(fiber);
  const key = info.resolved;
  const now = Date.now();
  if (recordingStartedAt === null) recordingStartedAt = now;
  totalFiberEvents += 1;

  const existing = fiberRecords.get(key);

  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
    if (context && existing.contexts.size < MAX_CONTEXTS_PER_FIBER) {
      existing.contexts.add(context);
    }
    if (existing.exampleKey === undefined && typeof fiber.key === 'string') {
      existing.exampleKey = fiber.key;
    }
    return;
  }

  if (fiberRecords.size >= MAX_FIBER_RECORDS) {
    evictOldestFiber();
  }
  fiberRecords.set(key, {
    name: info.resolved,
    rawName: info.name,
    rawDisplayName: info.displayName,
    kind: info.kind,
    fiberTag: fiber.tag,
    looksMinified: info.looksMinified,
    count: 1,
    contexts: new Set(context ? [context] : []),
    firstSeen: now,
    lastSeen: now,
    source: fiber._debugSource ?? undefined,
    exampleKey: typeof fiber.key === 'string' ? fiber.key : undefined,
  });
}

function evictOldestFiber(): void {
  let oldestKey: string | undefined;
  let oldestTime = Infinity;
  for (const [key, rec] of fiberRecords) {
    if (rec.lastSeen < oldestTime) {
      oldestTime = rec.lastSeen;
      oldestKey = key;
    }
  }
  if (oldestKey) fiberRecords.delete(oldestKey);
}

interface SnapshotStats {
  total: number;
  minifiedLike: number;
  byName: Map<string, number>;
  maxDepth: number;
}

function walkStats(node: LiveTreeNode, depth: number, acc: SnapshotStats): void {
  acc.total += 1;
  if (depth > acc.maxDepth) acc.maxDepth = depth;
  if (looksMinified(node.name)) acc.minifiedLike += 1;
  acc.byName.set(node.name, (acc.byName.get(node.name) ?? 0) + 1);
  for (const child of node.children) walkStats(child, depth + 1, acc);
}

export function logTreeSnapshot(tree: LiveTreeNode | null, context?: string): void {
  if (!isRecording() || !tree) return;
  const stats: SnapshotStats = { total: 0, minifiedLike: 0, byName: new Map(), maxDepth: 0 };
  walkStats(tree, 0, stats);
  const topNames = [...stats.byName.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOP_NAMES_PER_SNAPSHOT)
    .map(([n, c]) => `${n}:${c}`)
    .join(',');

  treeRecords.push({
    ts: Date.now(),
    ctx: context ?? '',
    rootName: tree.name,
    totalNodes: stats.total,
    maxDepth: stats.maxDepth,
    minifiedLike: stats.minifiedLike,
    topNames,
  });
  if (treeRecords.length > MAX_TREE_RECORDS) treeRecords.shift();
}

// Same buffer for both — keeping API compatible.
export const logTreeSummary = logTreeSnapshot;

// ---------------------------------------------------------------------------
// Console API installed on globalThis.__ft
// ---------------------------------------------------------------------------

interface FtConsoleApi {
  dump(): void;
  fibers(): void;
  snapshots(): void;
  tail(n?: number): void;
  clear(): void;
  size(): { fibers: number; snapshots: number };
  export(): { fibers: Array<Record<string, unknown>>; snapshots: TreeRecord[] };
  download(filename?: string): void;
}

function installConsoleApi(): void {
  if (globalThis.__ft) return;

  const api: FtConsoleApi = {
    dump() {
      const fiberRows = serializeFiberRecords();
      const snapRows = serializeTreeRecords();
      const minifiedCount = fiberRows.filter((r) => r.looksMinified).length;
      const elapsedSec =
        recordingStartedAt === null ? 0 : (Date.now() - recordingStartedAt) / 1000;
      const summary = [
        {
          metric: 'uniqueComponents',
          value: fiberRecords.size,
        },
        {
          metric: 'totalFiberEvents',
          value: totalFiberEvents,
        },
        {
          metric: 'minifiedLike',
          value: `${minifiedCount} / ${fiberRecords.size}`,
        },
        {
          metric: 'snapshots',
          value: treeRecords.length,
        },
        {
          metric: 'recordingSec',
          value: elapsedSec.toFixed(1),
        },
      ];

      // eslint-disable-next-line no-console
      console.groupCollapsed(
        `%c[FT debug] dump%c — ${fiberRecords.size} components, ${totalFiberEvents} events, ${treeRecords.length} snapshots`,
        'background:#1e293b;color:#7dd3fc;padding:1px 6px;border-radius:3px;font-weight:600;',
        'color:#94a3b8;',
      );
      // eslint-disable-next-line no-console
      console.log('Summary:');
      // eslint-disable-next-line no-console
      console.table(summary, ['metric', 'value']);
      // eslint-disable-next-line no-console
      console.log('Fibers — every observed component (sorted by call count):');
      // eslint-disable-next-line no-console
      console.table(fiberRows, [
        'name',
        'rawName',
        'rawDisplayName',
        'kind',
        'fiberTag',
        'count',
        'looksMinified',
        'exampleKey',
        'contexts',
        'file',
        'line',
        'firstSeenAt',
        'lastSeenAt',
        'lastAgoSec',
      ]);
      // eslint-disable-next-line no-console
      console.log('Tree snapshots — newest last:');
      // eslint-disable-next-line no-console
      console.table(snapRows, [
        'ts',
        'ctx',
        'rootName',
        'totalNodes',
        'maxDepth',
        'minifiedLike',
        'topNames',
      ]);
      // eslint-disable-next-line no-console
      console.groupEnd();
    },
    fibers() {
      // eslint-disable-next-line no-console
      console.table(serializeFiberRecords(), [
        'name',
        'rawName',
        'rawDisplayName',
        'kind',
        'fiberTag',
        'count',
        'looksMinified',
        'exampleKey',
        'contexts',
        'file',
        'line',
        'firstSeenAt',
        'lastSeenAt',
        'lastAgoSec',
      ]);
    },
    snapshots() {
      // eslint-disable-next-line no-console
      console.table(serializeTreeRecords());
    },
    tail(n = 20) {
      // eslint-disable-next-line no-console
      console.table(treeRecords.slice(-n));
    },
    clear() {
      fiberRecords.clear();
      treeRecords.length = 0;
      // eslint-disable-next-line no-console
      console.info('[FT debug] cleared');
    },
    size() {
      return { fibers: fiberRecords.size, snapshots: treeRecords.length };
    },
    export() {
      return { fibers: serializeFiberRecords(), snapshots: treeRecords.slice() };
    },
    download(filename?: string) {
      const data = api.export();
      const json = JSON.stringify(data, null, 2);
      // Browser-only: requires document + URL.createObjectURL.
      const docRef = (globalThis as { document?: Document }).document;
      const URLRef = (globalThis as { URL?: typeof URL }).URL;
      if (!docRef || !URLRef || typeof URLRef.createObjectURL !== 'function') {
        // eslint-disable-next-line no-console
        console.warn('[FT debug] download() requires a browser environment — printing JSON instead');
        // eslint-disable-next-line no-console
        console.log(json);
        return;
      }
      const blob = new Blob([json], { type: 'application/json' });
      const url = URLRef.createObjectURL(blob);
      const a = docRef.createElement('a');
      a.href = url;
      a.download = filename ?? `flotrace-debug-${Date.now()}.json`;
      a.click();
      URLRef.revokeObjectURL(url);
    },
  };

  globalThis.__ft = api;
}

// Install __ft eagerly at module load so the console API is available even
// when the user enables debug by setting `globalThis.__FT_DEBUG = true`
// directly (without going through setFiberDebug).
installConsoleApi();

function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mss = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${mss}`;
}

function serializeFiberRecords(): Array<Record<string, unknown>> {
  const now = Date.now();
  return [...fiberRecords.values()]
    .sort((a, b) => b.count - a.count)
    .map((r) => ({
      name: r.name,
      rawName: r.rawName ?? '',
      rawDisplayName: r.rawDisplayName ?? '',
      kind: r.kind,
      fiberTag: r.fiberTag ?? '',
      count: r.count,
      looksMinified: r.looksMinified,
      exampleKey: r.exampleKey ?? '',
      contexts: [...r.contexts].join(','),
      file: r.source?.fileName ?? '',
      line: r.source?.lineNumber ?? '',
      firstSeenAt: formatTime(r.firstSeen),
      lastSeenAt: formatTime(r.lastSeen),
      lastAgoSec: ((now - r.lastSeen) / 1000).toFixed(1),
    }));
}

function serializeTreeRecords(): Array<Record<string, unknown>> {
  return treeRecords.map((t) => ({
    ts: formatTime(t.ts),
    ctx: t.ctx,
    rootName: t.rootName,
    totalNodes: t.totalNodes,
    maxDepth: t.maxDepth,
    minifiedLike: t.minifiedLike,
    topNames: t.topNames,
  }));
}

// ---------------------------------------------------------------------------
// Internal accessors — exposed for the desktop side so it can dedupe / sample
// without re-implementing the buffer.
// ---------------------------------------------------------------------------

export function __getFiberRecordsForTesting(): Map<string, FiberRecord> {
  return fiberRecords;
}

export function __getTreeRecordsForTesting(): TreeRecord[] {
  return treeRecords;
}
