import type { SerializedValue } from './types';
import { FLOTRACE_SRC_ATTR } from './jsxRuntimeUtils';

/**
 * Maximum depth for object serialization to prevent infinite recursion
 */
const MAX_DEPTH = 5;

/**
 * Maximum string length sent in full. Generous (10 KB) so real inspection values —
 * bios, descriptions, URLs, error stacks, small JSON blobs — are never truncated; the
 * 500-char cap used to chop a 635-char bio down to a contentless marker. A ceiling
 * still exists because the serializer also runs on store-state-on-every-change, and an
 * unbounded multi-MB string (e.g. a base64 data URL held in state) would bloat the
 * WebSocket frame and add main-thread serialize cost on a hot path. When a string DOES
 * exceed this, we still send its leading `MAX_STRING_LENGTH` chars as a `preview` so the
 * inspector shows content, never an empty `[truncated]`.
 */
const MAX_STRING_LENGTH = 10000;

/**
 * Maximum array length before truncation
 */
const MAX_ARRAY_LENGTH = 50;

/**
 * Maximum object keys before truncation
 */
const MAX_OBJECT_KEYS = 30;

/**
 * Serialize a value for safe transmission over WebSocket.
 * Handles circular references, functions, symbols, and large values.
 */
export function serializeValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): SerializedValue {
  // Handle null
  if (value === null) {
    return null;
  }

  // Handle undefined
  if (value === undefined) {
    return { __type: 'undefined' };
  }

  // Handle primitives
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    // Handle special number values
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return value;
  }

  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) {
      return {
        __type: 'truncated',
        originalType: 'string',
        length: value.length,
        // Send the leading slice so the inspector shows real content instead of an
        // empty marker. The full length is in `length` so the UI can note how much
        // was elided.
        preview: value.slice(0, MAX_STRING_LENGTH),
      };
    }
    return value;
  }

  if (typeof value === 'symbol') {
    return {
      __type: 'symbol',
      description: value.description,
    };
  }

  if (typeof value === 'function') {
    return {
      __type: 'function',
      name: value.name || 'anonymous',
    };
  }

  // Handle objects
  if (typeof value === 'object') {
    // Check for circular reference
    if (seen.has(value)) {
      return { __type: 'circular' };
    }

    // Check depth limit
    if (depth >= MAX_DEPTH) {
      return {
        __type: 'truncated',
        originalType: Array.isArray(value) ? 'array' : 'object',
      };
    }

    // Add to seen set
    seen.add(value);

    // Handle arrays
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) {
        const truncated = value
          .slice(0, MAX_ARRAY_LENGTH)
          .map((item) => serializeValue(item, depth + 1, seen));
        return [
          ...truncated,
          {
            __type: 'truncated',
            originalType: 'array',
            length: value.length,
          },
        ];
      }
      return value.map((item) => serializeValue(item, depth + 1, seen));
    }

    // Handle Date
    if (value instanceof Date) {
      return value.toISOString();
    }

    // Handle Error
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
      };
    }

    // Handle Map
    if (value instanceof Map) {
      const obj: Record<string, SerializedValue> = {};
      let count = 0;
      for (const [k, v] of value.entries()) {
        if (count >= MAX_OBJECT_KEYS) {
          obj.__truncated = { __type: 'truncated', originalType: 'Map', length: value.size };
          break;
        }
        obj[String(k)] = serializeValue(v, depth + 1, seen);
        count++;
      }
      return obj;
    }

    // Handle Set
    if (value instanceof Set) {
      const arr = Array.from(value);
      if (arr.length > MAX_ARRAY_LENGTH) {
        return {
          __type: 'truncated',
          originalType: 'Set',
          length: arr.length,
        };
      }
      return arr.map((item) => serializeValue(item, depth + 1, seen));
    }

    // Handle RegExp
    if (value instanceof RegExp) {
      return value.toString();
    }

    // Handle plain objects
    const keys = Object.keys(value);
    const result: Record<string, SerializedValue> = {};

    for (let i = 0; i < Math.min(keys.length, MAX_OBJECT_KEYS); i++) {
      const key = keys[i];
      try {
        result[key] = serializeValue((value as Record<string, unknown>)[key], depth + 1, seen);
      } catch {
        result[key] = { __type: 'truncated', originalType: 'error' };
      }
    }

    if (keys.length > MAX_OBJECT_KEYS) {
      result.__truncated = {
        __type: 'truncated',
        originalType: 'object',
        length: keys.length,
      };
    }

    return result;
  }

  // Fallback for unknown types
  return { __type: 'truncated', originalType: typeof value };
}

/**
 * Serialize props object, filtering out React internals and children
 */
export function serializeProps(props: Record<string, unknown>): Record<string, SerializedValue> {
  const result: Record<string, SerializedValue> = {};

  for (const [key, value] of Object.entries(props)) {
    // Skip React internals
    if (key === 'children' || key === 'key' || key === 'ref') {
      continue;
    }

    // Skip internal props (starting with __)
    if (key.startsWith('__')) {
      continue;
    }

    // Skip FloTrace's own babel-plugin source-attribution attribute — it's an
    // internal marker injected onto every JSX element, never a real user prop.
    // Without this it leaks into the Props inspector as `data-flotrace-src`.
    if (key === FLOTRACE_SRC_ATTR) {
      continue;
    }

    try {
      result[key] = serializeValue(value);
    } catch (error) {
      console.error(`[FloTrace] Error serializing prop "${key}":`, error);
      result[key] = { __type: 'truncated', originalType: 'error' };
    }
  }

  return result;
}

/**
 * Get changed keys between two objects
 */
export function getChangedKeys(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): string[] {
  if (!prev) {
    return Object.keys(next);
  }

  const changed: string[] = [];
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(next)]);

  for (const key of allKeys) {
    if (!Object.is(prev[key], next[key])) {
      changed.push(key);
    }
  }

  return changed;
}
