/**
 * Type declarations for `@flotrace/runtime-core/babel-plugin`.
 *
 * The plugin itself is a plain CommonJS module (`babel-plugin.js`) so Babel
 * — which loads plugins via `require()` — can consume it without a build
 * step. These declarations give the test suite and any TypeScript consumer
 * a typed handle on the export.
 */

import type * as BabelTypes from '@babel/types';
import type { NodePath } from '@babel/traverse';
// `PluginObj` is exported from `@babel/core` (via `@types/babel__core`), NOT
// `@babel/traverse` — importing it from traverse resolves to `any`/errors.
import type { PluginObj } from '@babel/core';

export interface FlotraceBabelPluginOptions {
  /** Set to `false` to no-op (e.g. for production builds). Default `true`. */
  development?: boolean;
}

export interface FlotraceBabelPluginState {
  opts: FlotraceBabelPluginOptions;
  file: { opts: { filename?: string | null } };
}

declare const flotraceBabelPlugin: {
  (api: { types: typeof BabelTypes }): PluginObj<FlotraceBabelPluginState> & {
    visitor: {
      JSXOpeningElement(
        path: NodePath<BabelTypes.JSXOpeningElement>,
        state: FlotraceBabelPluginState,
      ): void;
    };
  };
  /** Constant attribute name — `data-flotrace-src`. Avoid string drift. */
  FLOTRACE_ATTR_NAME: string;
};

export default flotraceBabelPlugin;
