/**
 * Tests for the FloTrace source-attribution Babel plugin (canonical
 * implementation in runtime-core; re-exported by `@flotrace/runtime/babel-plugin`
 * and `@flotrace/runtime-native/babel-plugin`).
 *
 * Runs the plugin's visitor against a real Babel AST (parsed via
 * `@babel/parser`) and asserts the resulting code via `@babel/generator`.
 * Uses these directly instead of `@babel/core` because the runtime-core
 * package doesn't depend on `@babel/plugin-syntax-jsx` (the syntax plugin
 * is normally pulled in by `@babel/preset-env` / preset-react in the
 * consumer's build, not by us).
 *
 * Coverage:
 *   - Injects `data-flotrace-src='{"f":...,"l":...,"c":...}'` with correct
 *     line/column from the AST.
 *   - Preserves existing JSX attributes alongside the injected one.
 *   - Skips node_modules files (would bloat the bundle for no click-to-IDE
 *     benefit).
 *   - Skips Fragments (`<Fragment>`, `<React.Fragment>`).
 *   - Idempotent (running twice doesn't double-inject).
 *   - `development: false` no-ops for prod builds.
 */
import { describe, expect, test } from 'vitest';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';
import flotraceBabelPlugin from '../babel-plugin.js';
import { readJsxSourceFromFiber } from './jsxRuntimeUtils';

// `@babel/generator` and `@babel/traverse` ship as default exports — but
// some bundlers wrap them in `{default: fn}`. Normalize so `.call(...)`
// works regardless of which shape the runtime sees.
const gen: typeof generate =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (generate as any).default ?? generate;
const tr: typeof traverse =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (traverse as any).default ?? traverse;

function transform(
  code: string,
  options: { filename?: string; development?: boolean } = {},
): string {
  const filename = options.filename ?? '/abs/project/src/Foo.tsx';
  const ast = parse(code, {
    sourceType: 'module',
    plugins: ['jsx', 'typescript'],
  });

  // The plugin module exports a factory `(api) => { visitor }`. Invoke it
  // with the minimal `{types: t}` API and a synthetic `state` shape that
  // mirrors what `@babel/core` would pass to a visitor. Build a wrapped
  // visitor that injects `state` into every node visit so the plugin's
  // visitors (which expect a 2-arg `(path, state)` signature) work with
  // `@babel/traverse`'s native single-arg visitor protocol.
  const pluginInstance = flotraceBabelPlugin({ types: t });
  const state = {
    opts: { development: options.development },
    file: { opts: { filename } },
  };

  const wrappedVisitor: Record<string, (path: unknown) => void> = {};
  // The plugin's `visitor` is a strongly-typed Babel `Visitor` (no string index
  // signature); we drive it manually by node-type name, so cast to a record.
  const visitorMap = pluginInstance.visitor as unknown as Record<
    string,
    ((path: unknown, state: unknown) => void) | undefined
  >;
  for (const nodeType of Object.keys(visitorMap)) {
    const fn = visitorMap[nodeType];
    if (typeof fn !== 'function') continue;
    wrappedVisitor[nodeType] = (path: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fn(path as any, state);
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tr(ast, wrappedVisitor as any);

  return gen(ast).code;
}

/**
 * Helper: walk the original (transformed) AST and extract the JSON payload
 * from the first `data-flotrace-src` attribute. AST walk is more reliable
 * than regexing generator output — the generator's quote-and-escape
 * heuristics vary across Babel versions.
 */
function extractPayloadFromAst(ast: ReturnType<typeof parse>): {
  f: string;
  l: number;
  c: number;
} | null {
  let found: { f: string; l: number; c: number } | null = null;
  tr(ast, {
    JSXAttribute(path) {
      if (found) return;
      const name = path.node.name;
      if (name.type !== 'JSXIdentifier' || name.name !== 'data-flotrace-src') return;
      const value = path.node.value;
      if (!value || value.type !== 'JSXExpressionContainer') return;
      const expr = value.expression;
      if (expr.type !== 'StringLiteral') return;
      found = JSON.parse(expr.value);
    },
  });
  return found;
}

function transformAndExtract(
  code: string,
  options: { filename?: string; development?: boolean } = {},
): { f: string; l: number; c: number } | null {
  const filename = options.filename ?? '/abs/project/src/Foo.tsx';
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  const pluginInstance = flotraceBabelPlugin({ types: t });
  const state = {
    opts: { development: options.development },
    file: { opts: { filename } },
  };
  const wrappedVisitor: Record<string, (path: unknown) => void> = {};
  // The plugin's `visitor` is a strongly-typed Babel `Visitor` (no string index
  // signature); we drive it manually by node-type name, so cast to a record.
  const visitorMap = pluginInstance.visitor as unknown as Record<
    string,
    ((path: unknown, state: unknown) => void) | undefined
  >;
  for (const nodeType of Object.keys(visitorMap)) {
    const fn = visitorMap[nodeType];
    if (typeof fn !== 'function') continue;
    wrappedVisitor[nodeType] = (path: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fn(path as any, state);
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tr(ast, wrappedVisitor as any);
  return extractPayloadFromAst(ast);
}

describe('flotrace babel plugin — injects data-flotrace-src', () => {
  test('adds data-flotrace-src attribute with JSON-encoded {f,l,c} payload', () => {
    const payload = transformAndExtract('const x = <View />;', {
      filename: '/abs/project/src/Foo.tsx',
    });
    expect(payload).toEqual({
      f: '/abs/project/src/Foo.tsx',
      l: 1,
      c: 11, // 1-indexed (Babel reports 0-indexed col 10 for `<View`)
    });
  });

  test('preserves existing JSX attributes alongside the injected one', () => {
    const out = transform('const x = <View className="bg-red-500" testID="root" />;');
    expect(out).toContain('className="bg-red-500"');
    expect(out).toContain('testID="root"');
    expect(out).toContain('data-flotrace-src');
  });

  test('captures the line number from the JSXOpeningElement location', () => {
    // Three-line layout: the JSX opens on line 2.
    const payload = transformAndExtract('const x = (\n  <View />\n);', {
      filename: '/p/Foo.tsx',
    });
    expect(payload?.l).toBe(2);
  });

  test('tags every JSXOpeningElement (parents AND children)', () => {
    const out = transform('const x = <View><Text /></View>;');
    const hits = out.match(/data-flotrace-src/g) ?? [];
    expect(hits.length).toBe(2); // View + Text
  });

  test('produces valid JSX that Babel can re-parse round-trip', () => {
    // Critical: an earlier draft used a bare `t.stringLiteral` for the
    // attribute value — generator emitted C-style escapes that JSX doesn't
    // support, breaking re-parse. The expression-container form (current
    // implementation) round-trips cleanly. This test guards against the
    // regression.
    const out = transform('const x = <View />;');
    expect(() => parse(out, { sourceType: 'module', plugins: ['jsx'] })).not.toThrow();
  });
});

describe('flotrace babel plugin — skip rules', () => {
  test('skips files inside node_modules (Unix path)', () => {
    const out = transform('const x = <View />;', {
      filename: '/abs/project/node_modules/some-lib/dist/Foo.js',
    });
    expect(out).not.toContain('data-flotrace-src');
  });

  test('skips files inside node_modules (Windows path)', () => {
    const out = transform('const x = <View />;', {
      filename: 'C:\\app\\node_modules\\lib\\Foo.js',
    });
    expect(out).not.toContain('data-flotrace-src');
  });

  test('skips named Fragment (<Fragment>)', () => {
    // Fragment doesn't accept arbitrary props; the inner View still gets tagged.
    const out = transform('const x = <Fragment><View /></Fragment>;');
    const hits = out.match(/data-flotrace-src/g) ?? [];
    expect(hits.length).toBe(1); // only the View
  });

  test('skips React.Fragment (member expression)', () => {
    const out = transform('const x = <React.Fragment><View /></React.Fragment>;');
    const hits = out.match(/data-flotrace-src/g) ?? [];
    expect(hits.length).toBe(1);
  });

  test('no-ops when development: false', () => {
    const out = transform('const x = <View />;', { development: false });
    expect(out).not.toContain('data-flotrace-src');
  });
});

describe('flotrace babel plugin — idempotency', () => {
  test('does not double-inject when the visitor runs a second time', () => {
    // Direct second-pass simulation: parse the already-tagged output and
    // run the plugin again. The attribute-presence check should short-circuit.
    const once = transform('const x = <View />;');
    const twice = transform(once);
    const hits = twice.match(/data-flotrace-src/g) ?? [];
    expect(hits.length).toBe(1);
  });
});

describe('flotrace babel plugin — tags component definitions', () => {
  test('injects `Component["data-flotrace-src"] = ...` after a function declaration', () => {
    // The react-navigation scenario: `<Stack.Screen component={HomeScreen}/>`
    // instantiates HomeScreen via React.createElement, bypassing user JSX.
    // The component's fiber memoizedProps therefore lacks data-flotrace-src,
    // so the walker reads it off `fiber.type` (the function itself). For
    // that route to work, the plugin must attach the attribute to the
    // function reference at declaration time.
    const out = transform('function HomeScreen() { return <View />; }', {
      filename: '/p/HomeScreen.tsx',
    });
    expect(out).toMatch(/HomeScreen\["data-flotrace-src"\]\s*=/);
  });

  test('injects after an arrow-function const declaration', () => {
    const out = transform('const HomeScreen = () => <View />;');
    expect(out).toMatch(/HomeScreen\["data-flotrace-src"\]\s*=/);
  });

  test('injects after a class declaration', () => {
    const out = transform('class HomeScreen extends React.Component { render() { return null; } }');
    expect(out).toMatch(/HomeScreen\["data-flotrace-src"\]\s*=/);
  });

  test('injects after an HOC-wrapped const (CallExpression init)', () => {
    // `const Foo = memo(InnerFoo)` / `const Foo = withRouter(Inner)` —
    // PascalCase + CallExpression init counts as component-like.
    const out = transform('const Foo = memo(InnerFoo);');
    expect(out).toMatch(/Foo\["data-flotrace-src"\]\s*=/);
  });

  test('injects after `export default function Name() {}` AFTER the export', () => {
    // Function declarations are hoisted, so the assignment after the
    // export still finds the binding. Without the parent-path step-up,
    // the assignment would land inside the ExportDefaultDeclaration
    // statement which Babel doesn't allow as a sibling.
    const out = transform('export default function HomeScreen() { return null; }');
    expect(out).toContain('export default function HomeScreen');
    expect(out).toMatch(/HomeScreen\["data-flotrace-src"\]\s*=/);
  });

  test('injects after `export const Foo = ...` AFTER the export', () => {
    const out = transform('export const Foo = () => null;');
    expect(out).toContain('export const Foo');
    expect(out).toMatch(/Foo\["data-flotrace-src"\]\s*=/);
  });

  test('skips lowercase identifiers (utility functions / variables)', () => {
    const out = transform(`
      function helperFn() { return 1; }
      const result = computeSomething();
      const config = { theme: 'dark' };
    `);
    expect(out).not.toMatch(/helperFn\["data-flotrace-src"\]/);
    expect(out).not.toMatch(/result\["data-flotrace-src"\]/);
    expect(out).not.toMatch(/config\["data-flotrace-src"\]/);
  });

  test('skips PascalCase const bound to non-component literals (number/string/obj)', () => {
    // PascalCase identifiers are sometimes used for non-component constants
    // (style configs, enum-like objects, prebuilt option lists). Tagging
    // those would emit a useless attribute and could throw if the binding
    // is frozen.
    const out = transform(`
      const PAGE_SIZE = 20;
      const APP_NAME = "Trovie";
      const COLORS = { primary: '#fff' };
      const SUPPORTED_LANGS = ['en', 'fr'];
    `);
    expect(out).not.toMatch(/PAGE_SIZE\["data-flotrace-src"\]/);
    expect(out).not.toMatch(/APP_NAME\["data-flotrace-src"\]/);
    expect(out).not.toMatch(/COLORS\["data-flotrace-src"\]/);
    expect(out).not.toMatch(/SUPPORTED_LANGS\["data-flotrace-src"\]/);
  });

  test('skips SCREAMING_SNAKE_CASE consts with a runtime-computed init (crash regression)', () => {
    // Regression: `const CARD_WIDTH = screenWidth / 2.5` (a BinaryExpression, NOT
    // a NumericLiteral, so the old literal-only init check let it through) matched
    // the old PascalCase regex and emitted `if (CARD_WIDTH) CARD_WIDTH[...] = ...`.
    // At runtime CARD_WIDTH is the number 160.8, so the truthy `if` passed and the
    // property assignment threw "Cannot create property 'data-flotrace-src' on
    // number", crashing the consumer's RN app on load / Fast Refresh.
    const out = transform(`
      const { width: screenWidth } = Dimensions.get('window');
      const CARD_WIDTH = screenWidth / 2.5;
      const CARD_HEIGHT = CARD_WIDTH * 1.5;
      const SKELETON_ITEMS = Array.from({ length: 6 });
      const DEFAULT_MAX_ITEMS = 10;
    `);
    expect(out).not.toMatch(/CARD_WIDTH\["data-flotrace-src"\]/);
    expect(out).not.toMatch(/CARD_HEIGHT\["data-flotrace-src"\]/);
    expect(out).not.toMatch(/SKELETON_ITEMS\["data-flotrace-src"\]/);
    expect(out).not.toMatch(/DEFAULT_MAX_ITEMS\["data-flotrace-src"\]/);
  });

  test('skips PascalCase const with an arithmetic init (BinaryExpression → primitive)', () => {
    // PascalCase (has lowercase, so the name check passes) but the init is a
    // BinaryExpression that yields a number — must not be tagged.
    const out = transform('const Spacing = base * 2;');
    expect(out).not.toMatch(/Spacing\["data-flotrace-src"\]/);
  });

  test('runtime typeof guard makes statically-unknowable inits crash-proof', () => {
    // A PascalCase const whose init we CANNOT statically prove is a primitive
    // (`Dimensions.get(...).width` is a MemberExpression → could be anything) is
    // still tagged, but the emitted guard restricts the assignment to objects /
    // functions, so when it resolves to a number at runtime the assignment is a
    // no-op instead of a throw. This is the bulletproof safety net.
    const out = transform("const CardWidth = Dimensions.get('window').width;");
    expect(out).toMatch(/CardWidth\["data-flotrace-src"\]\s*=/);
    expect(out).toMatch(/typeof CardWidth === "object"/);
    expect(out).toMatch(/typeof CardWidth === "function"/);
  });

  test('emitted declaration tag is guarded by a typeof object/function check', () => {
    // Locks in the crash fix for the common component case too: the assignment
    // must be wrapped so it never runs against a primitive binding.
    const out = transform('const HomeScreen = () => <View />;');
    expect(out).toMatch(/typeof HomeScreen === "object"/);
    expect(out).toMatch(/typeof HomeScreen === "function"/);
  });

  test('wraps the declaration tag in try/catch (consumer-agnostic, can never crash the host)', () => {
    const out = transform('const HomeScreen = () => <View />;');
    expect(out).toMatch(/try\s*\{/);
    expect(out).toMatch(/catch\s*\(/);
    expect(out).toMatch(/HomeScreen\["data-flotrace-src"\]\s*=/);
  });

  test('emitted tag does NOT throw on a frozen-object binding at runtime', () => {
    // `Object.freeze({...})` is a CallExpression init → tagged, and typeof is
    // "object" so the typeof guard passes — only the try/catch prevents the
    // strict-mode "Cannot add property, object is not extensible" throw. This is
    // the general guarantee the typeof guard ALONE does not provide (a common
    // real-world pattern: `const Routes = Object.freeze({...})`).
    const out = transform('const Routes = Object.freeze({ home: "/" });');
    expect(out).toMatch(/Routes\["data-flotrace-src"\]\s*=/);
    // Module output runs in strict mode; execute it and assert nothing escapes.
    expect(() => new Function('"use strict";\n' + out)()).not.toThrow();
  });

  test('emitted tag does NOT throw when a PascalCase binding resolves to a primitive at runtime', () => {
    // CallExpression init the static heuristics cannot reject; resolves to a number.
    const out = transform('function compute() { return 160.8; }\nconst CardWidth = compute();');
    expect(() => new Function('"use strict";\n' + out)()).not.toThrow();
  });

  test('skips node_modules files for declaration tagging too', () => {
    const out = transform('function HomeScreen() { return <View />; }', {
      filename: '/abs/project/node_modules/lib/HomeScreen.js',
    });
    expect(out).not.toMatch(/HomeScreen\["data-flotrace-src"\]/);
  });

  test('no-ops declaration tagging when development: false', () => {
    const out = transform('function HomeScreen() { return null; }', {
      development: false,
    });
    expect(out).not.toMatch(/HomeScreen\["data-flotrace-src"\]/);
  });

  test('does not double-inject the declaration tag on a second pass', () => {
    const once = transform('function HomeScreen() { return null; }');
    const twice = transform(once);
    const hits = twice.match(/HomeScreen\["data-flotrace-src"\]/g) ?? [];
    expect(hits.length).toBe(1);
  });
});

describe('flotrace babel plugin — contract with walker', () => {
  test('plugin-emitted payload round-trips through readJsxSourceFromFiber (call site)', () => {
    // Contract test for route (A): JSXAttribute → memoizedProps. If the
    // plugin's payload shape ever drifts from `parseDataFlotraceSrc`'s
    // expectations (e.g. someone renames `f`/`l`/`c` to `file`/`line`/
    // `column`), both halves still pass their isolated tests but
    // click-to-source silently breaks at runtime. This test fails the
    // build the moment the contract diverges.
    const payload = transformAndExtract('const x = <View />;', {
      filename: '/abs/project/src/Foo.tsx',
    });
    expect(payload).not.toBeNull();

    // Simulate what React's reconciliation passes to the fiber: the JSON
    // string from the JSXAttribute lands on memoizedProps['data-flotrace-src'].
    const fiber = {
      memoizedProps: { 'data-flotrace-src': JSON.stringify(payload) },
    };
    const source = readJsxSourceFromFiber(fiber);
    expect(source).toBeDefined();
    expect(source?.fileName).toBe('/abs/project/src/Foo.tsx');
    expect(source?.lineNumber).toBe(1);
    expect(source?.columnNumber).toBe(11);
    expect(source?.callSiteId).toMatch(/^[0-9a-f]{8}$/);
  });

  test('plugin-emitted declaration tag round-trips through readJsxSourceFromFiber (definition site)', () => {
    // Contract test for route (B): declaration tagging → fiber.type. This
    // is the fix for "some user components don't have nav-to-source": when
    // react-navigation instantiates a screen via React.createElement, the
    // fiber's memoizedProps is empty BUT fiber.type === the function
    // reference that the plugin tagged. The walker must read off `type`.
    //
    // We can't easily extract the plugin's exact declaration-tag payload
    // from the AST (it's an IfStatement, not a JSXAttribute) — but we know
    // the payload shape is identical to the JSX-attribute version. So we
    // construct the simulated component manually using the same shape and
    // verify the walker reads it back correctly.
    const componentFunction = function HomeScreen() {
      return null;
    };
    // Simulate the plugin's `HomeScreen["data-flotrace-src"] = '{...}'`
    // assignment that runs at module load.
    (componentFunction as unknown as Record<string, unknown>)['data-flotrace-src'] = JSON.stringify(
      { f: '/p/HomeScreen.tsx', l: 1, c: 1 },
    );

    // A react-navigation-instantiated fiber: empty memoizedProps, but
    // fiber.type IS the tagged function.
    const fiber = {
      memoizedProps: null,
      type: componentFunction,
    };
    const source = readJsxSourceFromFiber(fiber);
    expect(source).toBeDefined();
    expect(source?.fileName).toBe('/p/HomeScreen.tsx');
    expect(source?.lineNumber).toBe(1);
    expect(source?.callSiteId).toMatch(/^[0-9a-f]{8}$/);
  });
});
