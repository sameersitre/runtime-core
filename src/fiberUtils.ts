/**
 * Shared fiber display name resolution.
 *
 * Both cascadeAnalyzer and dispatchWrapper need to resolve a fiber's `type`
 * field to a human-readable component name. This module is the single source
 * of truth for that logic, preventing the two from drifting apart.
 */

/**
 * Resolve a React fiber's `type` field to a display name.
 * Handles function components, class components, forwardRef, and memo wrappers.
 */
export function getFiberDisplayName(type: unknown): string {
  if (!type) return 'Unknown';
  if (typeof type === 'function') {
    return (type as { displayName?: string; name?: string }).displayName
      || (type as { name?: string }).name
      || 'Anonymous';
  }
  if (typeof type === 'object') {
    const t = type as {
      type?: { name?: string; displayName?: string };
      render?: { name?: string };
      displayName?: string;
      name?: string;
    };
    return t.type?.displayName || t.type?.name || t.render?.name || t.displayName || t.name || 'Unknown';
  }
  return 'Unknown';
}
