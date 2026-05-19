/**
 * Hand-curated `Default<Entity>` typed baselines for jsxRuntimeUtils tests.
 *
 * Convention (bolt vitest-default-dummy-data):
 *   - One `Default<Entity>` per type, annotated with `Required<T>` so every
 *     optional field is filled — adding a new field to the source type fails
 *     compilation here until the fixture is updated.
 *   - Pure data, no logic. Spread into overrides via `create<Entity>`
 *     builders; never mutated.
 */

import type { JsxSourceArg, FlotraceJsxSource } from './jsxRuntimeUtils';

export const DefaultJsxSourceArg: Required<JsxSourceArg> = {
  fileName: 'src/components/Header.tsx',
  lineNumber: 42,
  columnNumber: 8,
};

export const DefaultFlotraceJsxSource: Required<FlotraceJsxSource> = {
  fileName: 'src/components/Header.tsx',
  lineNumber: 42,
  columnNumber: 8,
  callSiteId: '00000000',
  inline: {},
};

/**
 * Bundler-specific path styles that all denote the SAME line of source code.
 * The path normalizer must collapse all of these to one canonical form so
 * `computeCallSiteId` produces a stable ID across bundler swaps.
 */
export const BUNDLER_PATH_STYLES: ReadonlyArray<{
  label: string;
  raw: string;
  normalized: string;
}> = [
  {
    label: 'plain absolute',
    raw: '/abs/src/Foo.tsx',
    normalized: '/abs/src/Foo.tsx',
  },
  {
    label: 'file:// prefix (Vite dev)',
    raw: 'file:///abs/src/Foo.tsx',
    normalized: '/abs/src/Foo.tsx',
  },
  {
    label: 'webpack-internal prefix',
    raw: 'webpack-internal:///./src/Foo.tsx',
    normalized: 'src/Foo.tsx',
  },
  {
    label: 'leading ./',
    raw: './src/Foo.tsx',
    normalized: 'src/Foo.tsx',
  },
  {
    label: 'Windows drive (uppercase)',
    raw: 'C:\\Users\\foo\\src\\Foo.tsx',
    normalized: 'c:\\Users\\foo\\src\\Foo.tsx',
  },
  {
    label: 'Windows drive (lowercase already)',
    raw: 'c:\\Users\\foo\\src\\Foo.tsx',
    normalized: 'c:\\Users\\foo\\src\\Foo.tsx',
  },
  {
    label: 'Windows drive with forward slash',
    raw: 'D:/users/foo/src/Foo.tsx',
    normalized: 'd:/users/foo/src/Foo.tsx',
  },
  {
    label: 'Vite on Windows (file:///C:/...)',
    raw: 'file:///C:/Users/foo/src/Foo.tsx',
    normalized: 'c:/Users/foo/src/Foo.tsx',
  },
  {
    label: 'Vite on Windows backslash variant (file:///C:\\...)',
    raw: 'file:///C:\\Users\\foo\\src\\Foo.tsx',
    normalized: 'c:\\Users\\foo\\src\\Foo.tsx',
  },
];
