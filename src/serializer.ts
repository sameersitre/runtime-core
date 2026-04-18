import type { SerializedValue } from './types';

/**
 * Maximum depth for object serialization to prevent infinite recursion
 */
const MAX_DEPTH = 5;

/**
 * Maximum string length before truncation
 */
const MAX_STRING_LENGTH = 500;

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
  seen = new WeakSet<object>()
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
        result[key] = serializeValue(
          (value as Record<string, unknown>)[key],
          depth + 1,
          seen
        );
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
export function serializeProps(
  props: Record<string, unknown>
): Record<string, SerializedValue> {
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
  next: Record<string, unknown>
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
