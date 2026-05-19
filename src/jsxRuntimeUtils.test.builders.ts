/**
 * Typed `create<Entity>` builders for jsxRuntimeUtils tests.
 *
 * Convention (bolt vitest-faker-utilities):
 *   - One builder per type, accepting a `Partial<T>` override.
 *   - Spread baseline first, override last — never mutate the baseline.
 */

import type { JsxSourceArg } from './jsxRuntimeUtils';
import { DefaultJsxSourceArg } from './jsxRuntimeUtils.test.fixtures';

export function createJsxSourceArg(override: Partial<JsxSourceArg> = {}): JsxSourceArg {
  return { ...DefaultJsxSourceArg, ...override };
}
