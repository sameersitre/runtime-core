/**
 * Fiber Attribution Utilities for @flotrace/runtime
 *
 * Provides React fiber introspection for component attribution.
 * Used by networkTracker to identify which component triggered a request.
 *
 * Works across React 18 and 19 by probing different internal property names.
 */

// Minimal fiber shape for attribution (avoid importing full Fiber type).
export interface FiberLike {
  type: {
    name?: string;
    displayName?: string;
    type?: { name?: string; displayName?: string };
    render?: { name?: string; displayName?: string };
  } | ((...args: unknown[]) => unknown) | string | null;
  return: FiberLike | null;
  tag: number;
}

/**
 * Structural check for a React fiber node.
 * Requires tag (number), type, return, AND memoizedState or stateNode
 * to distinguish from non-fiber objects that happen to have tag/type/return.
 */
function isFiberLike(val: unknown): val is FiberLike {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  return (
    typeof obj.tag === 'number' &&
    'type' in obj &&
    'return' in obj &&
    ('memoizedState' in obj || 'stateNode' in obj)
  );
}

/**
 * Get the currently rendering fiber across React 18 and 19.
 *
 * Strategy 1 (React 18): __SECRET_INTERNALS...ReactCurrentOwner.current
 * Strategy 2 (React 19): __CLIENT_INTERNALS...owner field (renamed + flattened)
 * Both return the fiber currently being rendered (null between renders).
 */
export function getCurrentRenderingFiber(): FiberLike | null {
  try {
    const win = window as unknown as Record<string, unknown>;

    // React 18: __SECRET_INTERNALS...ReactCurrentOwner.current
    const secret = win.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED as
      { ReactCurrentOwner?: { current: FiberLike | null } } | undefined;
    if (secret?.ReactCurrentOwner?.current) return secret.ReactCurrentOwner.current;

    // React 19: renamed + flattened — try known property names
    const client = win.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE as
      Record<string, unknown> | undefined;
    if (client) {
      // React 19 stores the current owner in a top-level property.
      // Walk all values looking for something that looks like a fiber.
      for (const val of Object.values(client)) {
        if (isFiberLike(val)) return val as FiberLike;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract display name from a fiber node.
 */
export function getComponentNameFromFiber(fiber: FiberLike): string | null {
  const type = fiber.type;
  if (!type) return null;

  if (typeof type === 'function') {
    return (type as { displayName?: string; name?: string }).displayName ||
      (type as { name?: string }).name || null;
  }

  if (typeof type === 'object' && type !== null) {
    // Memo wraps type
    if (type.type) {
      return type.type.displayName || type.type.name || null;
    }
    // ForwardRef wraps render
    if (type.render) {
      return type.render.displayName || type.render.name || null;
    }
    return type.displayName || type.name || null;
  }

  return null;
}

/**
 * Walk up the fiber tree to build an ancestor chain of component names.
 * Stops after 10 levels to prevent excessive traversal.
 */
export function buildAncestorChain(fiber: FiberLike): string[] {
  const chain: string[] = [];
  let current: FiberLike | null = fiber;
  const maxDepth = 10;

  while (current && chain.length < maxDepth) {
    const name = getComponentNameFromFiber(current);
    if (name) {
      chain.unshift(name);
    }
    current = current.return;
  }

  return chain;
}
