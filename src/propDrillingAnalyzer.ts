/**
 * Prop drilling analyzer for @flotrace/runtime.
 * Walks the component tree after each snapshot to detect props passed through
 * 3+ levels with passthrough components that don't consume them.
 * Debounced to 2s — structural analysis runs infrequently.
 */
import type { LiveTreeNode, PropDrillingChain, PropDrillingChainNode, RuntimeMessage } from './types';
import type { Fiber } from './fiberTreeWalker';

// Runtime WebSocket client type (duck-typed to avoid circular import)
interface MinimalWsClient {
  connected: boolean;
  sendImmediate: (msg: RuntimeMessage) => void;
}

// --- Constants ---

const ANALYZE_INTERVAL_MS = 2000;
const DRILLING_THRESHOLD = 3; // minimum chain depth to flag

/** A single node in a DFS path during chain detection. */
interface PathNode {
  nodeId: string;
  propKey: string;
  isRename: boolean;
}

/** Props that are intentionally passed at every level — never drilling. */
const EXCLUDED_PROP_NAMES = new Set([
  // React internals
  'children', 'key', 'ref',
  // Common HTML attributes
  'className', 'style', 'id', 'name', 'type', 'value', 'placeholder',
  'disabled', 'readOnly', 'required', 'autoFocus', 'tabIndex',
  'role', 'aria-label', 'aria-describedby', 'aria-hidden',
  'title', 'lang', 'dir', 'hidden',
  // Common layout props
  'width', 'height', 'size', 'variant', 'color', 'theme',
  // Test IDs
  'data-testid', 'testID',
]);

/** Returns true if this prop should never be flagged as drilling. */
function isExcluded(propName: string): boolean {
  return EXCLUDED_PROP_NAMES.has(propName) || propName.startsWith('on');
}

// --- Debounce state ---

let analyzeTimer: ReturnType<typeof setTimeout> | null = null;
let lastAnalysisTime = 0;

// --- Value fingerprinting ---

/**
 * Compute a lightweight fingerprint of a value for identity comparison.
 * For primitives, name+type must both match to avoid false positives.
 * For objects/arrays, uses sorted key structure (same-reference OR structural match).
 * Depth-limited to 3 to stay under 5µs per call.
 */
export function valueFingerprint(value: unknown, depth = 0): string {
  if (depth > 3) return '__deep__';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'function') return `fn:${(value as { name?: string }).name || 'anon'}`;
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`;

  if (Array.isArray(value)) {
    const arr = value as unknown[];
    return `arr:${arr.length}:${arr.slice(0, 5).map((v) => valueFingerprint(v, depth + 1)).join(',')}`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `obj:${keys.slice(0, 10).map((k) => `${k}=${valueFingerprint(obj[k], depth + 1)}`).join(',')}`;
}

/**
 * Returns true if this value is complex enough to safely flag renames.
 * Primitives have too high a coincidence rate (e.g., count=5 at parent and child).
 */
function shouldFlagRename(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  if (Array.isArray(value) && (value as unknown[]).length === 0) return false;
  if (!Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) return false;
  return true;
}

// --- Prop flow edge ---

interface PropFlowEdge {
  parentNodeId: string;
  childNodeId: string;
  propKey: string;      // prop name at parent
  childPropKey: string; // prop name at child (may differ if renamed)
  fp: string;           // value fingerprint
}

// --- Classification helpers ---

/**
 * Compute what fraction of a node's non-excluded props are forwarded to at least one child.
 * High ratio + zero hooks = strong passthrough signal.
 */
function computePropIntersectionRatio(
  nodeProps: Record<string, unknown>,
  childrenProps: Array<Record<string, unknown>>,
): number {
  const nodeKeys = Object.keys(nodeProps).filter((k) => !isExcluded(k));
  if (nodeKeys.length === 0) return 0;

  let forwarded = 0;
  for (const key of nodeKeys) {
    const fp = valueFingerprint(nodeProps[key]);
    const isForwarded = childrenProps.some((cp) =>
      Object.values(cp).some((v) => valueFingerprint(v) === fp),
    );
    if (isForwarded) forwarded++;
  }

  return forwarded / nodeKeys.length;
}

/**
 * Classify a node in a drilling chain as source, passthrough, or consumer.
 * Conservative: defaults to 'consumer' to avoid false positives.
 */
function classifyNode(
  nodeId: string,
  drilledPropFp: string,
  parentNodeId: string | undefined,
  childNodeIds: string[],
  getProps: (id: string) => Record<string, unknown>,
  hookCounts: Map<string, number>,
  contextFlags: Map<string, boolean>,
): 'source' | 'passthrough' | 'consumer' {
  // Source: this node has the prop but no parent has it with same fingerprint
  if (!parentNodeId) return 'source';
  const parentProps = getProps(parentNodeId);
  const parentHasProp = Object.values(parentProps).some(
    (v) => valueFingerprint(v) === drilledPropFp,
  );
  if (!parentHasProp) return 'source';

  // Leaf (consumer): doesn't pass this prop to any child
  const forwardsToChild = childNodeIds.some((cid) => {
    const childProps = getProps(cid);
    return Object.values(childProps).some((v) => valueFingerprint(v) === drilledPropFp);
  });
  if (!forwardsToChild) return 'consumer';

  const hookCount = hookCounts.get(nodeId) ?? 0;
  const hasContext = contextFlags.get(nodeId) ?? false;

  // Zero hooks = almost certainly a passthrough wrapper
  if (hookCount === 0) return 'passthrough';

  // Has useContext = likely gets data from context, not drilling
  if (hasContext) return 'consumer';

  // High forwarding ratio with few hooks = passthrough
  const nodeProps = getProps(nodeId);
  const childrenProps = childNodeIds.map(getProps);
  const intersectionRatio = computePropIntersectionRatio(nodeProps, childrenProps);
  if (intersectionRatio > 0.7 && hookCount <= 1) return 'passthrough';

  // Default: conservative — treat as consumer
  return 'consumer';
}

// --- Severity ---

function calculateSeverity(
  depth: number,
  passthroughCount: number,
  consumerCount: number,
): 'info' | 'warning' | 'critical' {
  if (depth >= 5) return 'critical';
  if (passthroughCount >= 3) return 'critical';
  if (consumerCount >= 3 && depth >= 4) return 'critical';
  if (depth >= 4) return 'warning';
  if (passthroughCount >= 2) return 'warning';
  if (consumerCount >= 2) return 'warning';
  return 'info';
}

// --- Deterministic chainId ---

function makeChainId(sourceNodeId: string, fp: string, consumerNodeId: string): string {
  return `${sourceNodeId}::${fp.slice(0, 20)}::${consumerNodeId}`;
}

// --- Main analysis ---

/**
 * Build a flat representation of the tree (skipping framework nodes).
 */
function flattenTree(
  node: LiveTreeNode,
  parentId: string | undefined,
  parentMap: Map<string, string>,
  childrenMap: Map<string, string[]>,
  nodeMap: Map<string, LiveTreeNode>,
): void {
  if (node.isFramework) {
    // Still walk children so they're not lost
    for (const child of node.children) {
      flattenTree(child, parentId, parentMap, childrenMap, nodeMap);
    }
    return;
  }

  nodeMap.set(node.id, node);

  if (parentId) {
    parentMap.set(node.id, parentId);
    const siblings = childrenMap.get(parentId) ?? [];
    siblings.push(node.id);
    childrenMap.set(parentId, siblings);
  }

  if (!childrenMap.has(node.id)) {
    childrenMap.set(node.id, []);
  }

  for (const child of node.children) {
    flattenTree(child, node.id, parentMap, childrenMap, nodeMap);
  }
}

/**
 * Core analysis: walks tree, detects drilling chains, classifies nodes.
 */
function runAnalysis(
  tree: LiveTreeNode,
  fiberRefMap: Map<string, Fiber>,
): { chains: PropDrillingChain[]; passthroughNodeIds: string[] } {
  const parentMap = new Map<string, string>();
  const childrenMap = new Map<string, string[]>();
  const nodeMap = new Map<string, LiveTreeNode>();

  flattenTree(tree, undefined, parentMap, childrenMap, nodeMap);

  const allNodeIds = Array.from(nodeMap.keys());

  // Get raw props for each node (from fiberRefMap for accuracy)
  function getProps(nodeId: string): Record<string, unknown> {
    try {
      return (fiberRefMap.get(nodeId)?.memoizedProps as Record<string, unknown> | null) ?? {};
    } catch {
      return {};
    }
  }

  // Hook metadata per node
  const hookCounts = new Map<string, number>();
  const contextFlags = new Map<string, boolean>();
  for (const nodeId of allNodeIds) {
    const node = nodeMap.get(nodeId)!;
    hookCounts.set(nodeId, node.hookCount ?? 0);
    contextFlags.set(nodeId, node.hasContextHook ?? false);
  }

  // --- Phase 1: Build prop flow edges ---
  const edges: PropFlowEdge[] = [];

  for (const nodeId of allNodeIds) {
    const parentId = parentMap.get(nodeId);
    if (!parentId) continue;

    const parentProps = getProps(parentId);
    const childProps = getProps(nodeId);

    const childKeys = Object.keys(childProps).filter((k) => !isExcluded(k));
    const parentKeys = Object.keys(parentProps).filter((k) => !isExcluded(k));

    for (const childKey of childKeys) {
      const childVal = childProps[childKey];
      if (typeof childVal === 'function') continue;

      const childFp = valueFingerprint(childVal);

      // Skip null/undefined fingerprints (too common, high false positive rate)
      if (childFp === 'null') continue;

      for (const parentKey of parentKeys) {
        const parentVal = parentProps[parentKey];
        if (typeof parentVal === 'function') continue;

        const parentFp = valueFingerprint(parentVal);
        if (parentFp === childFp) {
          const isRename = parentKey !== childKey;
          // For renames, only flag complex values
          if (!isRename || shouldFlagRename(parentVal)) {
            edges.push({
              parentNodeId: parentId,
              childNodeId: nodeId,
              propKey: parentKey,
              childPropKey: childKey,
              fp: childFp,
            });
            break; // One match per childKey is enough
          }
        }
      }
    }
  }

  // --- Phase 2: Build chains via DFS from source nodes ---

  // Group edges by fingerprint
  const edgesByFp = new Map<string, PropFlowEdge[]>();
  for (const edge of edges) {
    const group = edgesByFp.get(edge.fp) ?? [];
    group.push(edge);
    edgesByFp.set(edge.fp, group);
  }

  const chains: PropDrillingChain[] = [];
  const passthroughNodeIdSet = new Set<string>();

  for (const [fp, fpEdges] of edgesByFp) {
    // Build adjacency: parent → [child edges]
    const outEdges = new Map<string, PropFlowEdge[]>();
    const inNodes = new Set<string>(); // nodes that appear as children

    for (const edge of fpEdges) {
      const out = outEdges.get(edge.parentNodeId) ?? [];
      out.push(edge);
      outEdges.set(edge.parentNodeId, out);
      inNodes.add(edge.childNodeId);
    }

    // Source nodes: have outgoing edges but NO incoming edge for this fingerprint
    const sourceNodeIds = new Set<string>();
    for (const edge of fpEdges) {
      if (!inNodes.has(edge.parentNodeId)) {
        sourceNodeIds.add(edge.parentNodeId);
      }
    }

    // DFS from each source to find all paths
    for (const sourceId of sourceNodeIds) {
      // Get the prop name at the source
      const firstEdge = outEdges.get(sourceId)?.[0];
      if (!firstEdge) continue;
      const sourcePropName = firstEdge.propKey;

      // DFS: collect all root-to-leaf paths
      const allPaths: Array<PathNode[]> = [];

      function dfs(
        currentId: string,
        currentPropKey: string,
        currentPath: PathNode[],
        visited: Set<string>,
      ): void {
        if (visited.has(currentId)) return; // cycle guard
        visited.add(currentId);

        const outgoing = outEdges.get(currentId);
        if (!outgoing || outgoing.length === 0) {
          // Leaf — end of chain
          if (currentPath.length >= DRILLING_THRESHOLD) {
            allPaths.push([...currentPath]);
          }
          visited.delete(currentId);
          return;
        }

        for (const edge of outgoing) {
          const isRename = edge.propKey !== edge.childPropKey;
          dfs(
            edge.childNodeId,
            edge.childPropKey,
            [...currentPath, { nodeId: edge.childNodeId, propKey: edge.childPropKey, isRename }],
            new Set(visited),
          );
        }
        visited.delete(currentId);
      }

      dfs(
        sourceId,
        sourcePropName,
        [{ nodeId: sourceId, propKey: sourcePropName, isRename: false }],
        new Set<string>(),
      );

      if (allPaths.length === 0) continue;

      // Each path that meets the threshold becomes a DrillChain
      for (const path of allPaths) {
        if (path.length < DRILLING_THRESHOLD) continue;

        const consumerNodeId = path[path.length - 1].nodeId;
        const consumerNode = nodeMap.get(consumerNodeId);
        if (!consumerNode) continue;

        // Classify each node in the path
        const chainNodes: PropDrillingChainNode[] = path.map((p, i) => {
          const parentIdForNode = i === 0 ? undefined : path[i - 1].nodeId;
          const childNodeIds = i < path.length - 1 ? [path[i + 1].nodeId] : [];

          const role = classifyNode(
            p.nodeId,
            fp,
            parentIdForNode,
            childNodeIds,
            getProps,
            hookCounts,
            contextFlags,
          );

          if (role === 'passthrough') {
            passthroughNodeIdSet.add(p.nodeId);
          }

          const n = nodeMap.get(p.nodeId);
          return {
            nodeId: p.nodeId,
            componentName: n?.name ?? p.nodeId,
            propKey: p.propKey,
            role,
            hookCount: hookCounts.get(p.nodeId) ?? 0,
            hasContextHook: contextFlags.get(p.nodeId) ?? false,
          };
        });

        const passthroughCount = chainNodes.filter((n) => n.role === 'passthrough').length;
        const sourceNode = nodeMap.get(sourceId);

        // Detect renames — use flatMap with original index so path[idx-1] refers to
        // the correct predecessor in the full path, not the filtered-array position.
        const renames = path.flatMap((p, idx) =>
          p.isRename
            ? [{ atNodeId: p.nodeId, fromKey: idx > 0 ? path[idx - 1].propKey : sourcePropName, toKey: p.propKey }]
            : []
        );

        chains.push({
          chainId: makeChainId(sourceId, fp, consumerNodeId),
          propName: sourcePropName,
          sourceNodeId: sourceId,
          sourceComponentName: sourceNode?.name ?? sourceId,
          consumerNodeIds: [consumerNodeId],
          consumerComponentNames: [consumerNode.name],
          path: chainNodes,
          depth: path.length,
          passthroughCount,
          severity: calculateSeverity(path.length, passthroughCount, 1),
          renames,
        });
      }
    }
  }

  // Deduplicate chains with identical chainIds
  const seen = new Set<string>();
  const dedupedChains = chains.filter((c) => {
    if (seen.has(c.chainId)) return false;
    seen.add(c.chainId);
    return true;
  });

  // Sort by severity (critical first) then depth
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  dedupedChains.sort((a, b) => {
    const s = severityOrder[a.severity] - severityOrder[b.severity];
    if (s !== 0) return s;
    return b.depth - a.depth;
  });

  return {
    chains: dedupedChains.slice(0, 50), // cap at 50 chains
    passthroughNodeIds: Array.from(passthroughNodeIdSet),
  };
}

/**
 * Schedule a prop drilling analysis. Debounced to run at most every 2 seconds.
 * Uses leading-edge semantics: fires immediately if ≥2s since last run, else waits.
 */
export function schedulePropDrillingAnalysis(
  tree: LiveTreeNode,
  fiberRefMap: Map<string, Fiber>,
  client: MinimalWsClient,
): void {
  if (analyzeTimer) clearTimeout(analyzeTimer);

  const now = Date.now();
  const elapsed = now - lastAnalysisTime;
  const delay = elapsed >= ANALYZE_INTERVAL_MS ? 0 : ANALYZE_INTERVAL_MS - elapsed;

  analyzeTimer = setTimeout(() => {
    analyzeTimer = null;
    if (!client.connected) return;

    try {
      lastAnalysisTime = Date.now();
      const { chains, passthroughNodeIds } = runAnalysis(tree, fiberRefMap);

      client.sendImmediate({
        type: 'runtime:propDrilling',
        payload: {
          chains,
          passthroughNodeIds,
          analysisTimestamp: lastAnalysisTime,
          treeSize: fiberRefMap.size,
        },
      } as RuntimeMessage);
    } catch (err) {
      // Analysis errors must never crash the user's app
      if (typeof console !== 'undefined') {
        console.warn('[FloTrace] Prop drilling analysis error:', err);
      }
    }
  }, delay);
}
