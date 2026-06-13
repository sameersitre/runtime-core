/**
 * FloTrace source-attribution Babel plugin (canonical implementation).
 *
 * Lives in runtime-core because (a) the reader side — `readJsxSourceFromFiber`,
 * `isUserComponent`, and the `FLOTRACE_SRC_ATTR` constant — lives next to it in
 * `jsxRuntimeUtils.ts` (single source of truth for the `data-flotrace-src`
 * attribute name), and (b) the plugin is cross-platform: `data-*` attributes
 * are valid on every React DOM host element AND silently ignored by the React
 * Native renderer (see point 3 below).
 *
 * Consumers never reference this path directly — they install an adapter and
 * use its re-export shim:
 *   - Web:          `@flotrace/runtime/babel-plugin`
 *   - React Native: `@flotrace/runtime-native/babel-plugin`
 * Both shims `require()` this file, so there is exactly one implementation.
 *
 * Injects source attribution into user code in two complementary places so
 * every fiber in the FloTrace tree gets click-to-IDE coverage:
 *
 *   (A) `data-flotrace-src` JSX attribute on every JSX element.
 *       Read at runtime from `fiber.memoizedProps['data-flotrace-src']`.
 *       This covers every fiber that was created via user-written JSX
 *       (`<MyComponent />`) — the "call site" attribution.
 *
 *   (B) `Component['data-flotrace-src'] = '{...}'` assignment after every
 *       PascalCase function / arrow / class declaration. Read at runtime
 *       from `fiber.type['data-flotrace-src']` as a fallback for fibers
 *       whose memoizedProps lacks the attribute — i.e. when the component
 *       was instantiated via `React.createElement(Component, ...)` from
 *       inside a library (react-navigation `<Stack.Screen component={X}>`,
 *       HOC-wrapped components, top-level App registered via
 *       AppRegistry.registerComponent). This is the "definition site"
 *       attribution.
 *
 * Together (A) + (B) ensure that every user component in the tree has a
 * source — never a broken-state "no nav button" card.
 *
 * Why a string-keyed JSXAttribute (route A) instead of the JSX-runtime opt-in:
 *
 *   1. Coexists with any other `jsxImportSource` consumer (nativewind /
 *      react-native-css-interop, Solid-style runtimes, etc.) — those claim
 *      the single `importSource` slot per file; this plugin is independent.
 *
 *   2. Survives React 19's keyed-element prop clone. Symbol-keyed props get
 *      silently dropped by React 19's `for-in` config clone whenever an
 *      element has a `key` prop (list rows, `.map()` children, navigation
 *      screens — the high-value source-tracking sites). String-keyed props
 *      enumerate via for-in and survive.
 *
 *   3. `data-*` attributes are valid on every React DOM host element (no
 *      unknown-prop warning) and silently ignored by React Native's native
 *      renderer (no warning either).
 *
 *   4. JSON-encoded string value parses safely on Windows paths (`C:\...`)
 *      where a `file:line:col` delimiter would be ambiguous.
 *
 * Usage in user babel.config.js (single line, no other config changes) —
 * reference the adapter you installed, not this package:
 *
 *   plugins: ['@flotrace/runtime/babel-plugin']         // web
 *   plugins: ['@flotrace/runtime-native/babel-plugin']  // React Native
 *
 * Options:
 *   - development (boolean, default true): when false, the plugin no-ops so
 *     production bundles aren't bloated with source attributions.
 *
 * No conflict with `@babel/plugin-transform-react-jsx` (any runtime/source/
 * importSource config) — this plugin only ADDS attributes and assignments,
 * it doesn't touch the JSX transform itself.
 */
'use strict';

const FLOTRACE_ATTR_NAME = 'data-flotrace-src';

// React-component naming convention. Anything starting with an uppercase
// letter is treated as a component candidate. Underscores tolerated for
// generated names (`_AppComponent` etc.).
const PASCAL_CASE_RE = /^[A-Z][A-Za-z0-9_$]*$/;

/**
 * Is `name` a React-component-shaped identifier (PascalCase) rather than a
 * SCREAMING_SNAKE_CASE constant?
 *
 * Components are PascalCase and ALWAYS contain a lowercase letter (`App`,
 * `MediaRow`, `Button`). All-caps names (`CARD_WIDTH`, `PAGE_SIZE`,
 * `DEFAULT_MAX_ITEMS`) are constants — never components — so tagging them is
 * pure noise and, when they hold a runtime-computed primitive
 * (`const CARD_WIDTH = screenWidth / 2.5`), used to crash the consumer app at
 * module eval ("Cannot create property 'data-flotrace-src' on number"). The
 * lowercase-letter requirement excludes them. A rare single-/all-uppercase
 * component (`const UI = …`) loses only the definition-site (route B) tag; it
 * still gets the call-site (route A) JSX-attribute tag.
 */
function isComponentName(name) {
  return PASCAL_CASE_RE.test(name) && /[a-z]/.test(name);
}

/** Build the JSON payload string for the `data-flotrace-src` value. */
function buildPayload(filename, loc) {
  return JSON.stringify({
    f: filename,
    l: loc.start.line,
    c: loc.start.column + 1, // 1-indexed to match React's convention
  });
}

/** Filename + loc validation gates shared by all visitors. */
function shouldVisit(state, loc) {
  if (state.opts && state.opts.development === false) return null;
  const filename = state.file && state.file.opts && state.file.opts.filename;
  if (!filename) return null;
  if (filename.indexOf('/node_modules/') !== -1) return null;
  if (filename.indexOf('\\node_modules\\') !== -1) return null;
  if (!loc || !loc.start) return null;
  return filename;
}

/**
 * Reject obviously-non-component initializer types. PascalCase + a function
 * / class / HOC-call init IS a component (or close enough that tagging is
 * harmless). PascalCase + a primitive / array / object literal is NOT.
 *
 * The primitive group below also covers arithmetic / comparison / logical-not /
 * `typeof` / `void` expressions (`const CARD_WIDTH = screenWidth / 2.5` is a
 * BinaryExpression; `const X = -y` / `!flag` are UnaryExpressions) — these always
 * yield a primitive, so excluding them stops a dead (and, before the runtime
 * typeof guard, crashing) declaration tag from being emitted.
 */
function isComponentLikeInit(node) {
  if (!node) return false;
  switch (node.type) {
    case 'NullLiteral':
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'BigIntLiteral':
    case 'ArrayExpression':
    case 'ObjectExpression':
    case 'TemplateLiteral':
    case 'RegExpLiteral':
    case 'BinaryExpression':
    case 'UnaryExpression':
      return false;
    default:
      // Component-shaped: ArrowFunctionExpression, FunctionExpression,
      // ClassExpression, CallExpression (HOC wrap), Identifier (re-export),
      // MemberExpression (`X.Y`), ConditionalExpression, LogicalExpression
      // (`A || Fallback`), etc. The runtime typeof guard below makes a
      // mis-classified primitive here a harmless no-op rather than a crash.
      return true;
  }
}

module.exports = function flotraceSourceAttributionPlugin({ types: t }) {
  /**
   * Build:
   *   try {
   *     if (X && (typeof X === 'object' || typeof X === 'function'))
   *       X['data-flotrace-src'] = '<payload>';
   *   } catch (_flotraceErr) {}
   *
   * This is the CONSUMER-AGNOSTIC "can never crash the host app" guarantee — it
   * holds for ANY binding `X`, not just the reported numeric case. Two layers:
   *
   *   - `try/catch` (the catch-all): assigning a property can throw for reasons
   *     no static AST analysis can rule out — a frozen/sealed/non-extensible
   *     object (`const Routes = Object.freeze({...})` — a common pattern, and a
   *     CallExpression init so it passes every static heuristic), a Proxy with a
   *     throwing `set` trap, or a getter-only property. The catch swallows all of
   *     them so source attribution can never break the consumer's app.
   *
   *   - `typeof` guard (cheap pre-check): the COMMON mis-classification is a
   *     PascalCase binding that resolves to a PRIMITIVE at runtime
   *     (`const CARD_WIDTH = screenWidth / 2.5` → number, `const Color =
   *     theme.primary` → string) — assigning to a primitive throws in strict
   *     mode. The guard skips those without entering the throw path, so the
   *     try/catch only ever actually fires for the rare exotic-object cases and
   *     "pause on caught exceptions" debuggers stay quiet during normal runs.
   *     `X &&` short-circuits null/undefined before `typeof` (`typeof null ===
   *     'object'` would otherwise slip through).
   */
  function buildDeclTaggingStatement(name, payload) {
    const memberAccess = t.memberExpression(
      t.identifier(name),
      t.stringLiteral(FLOTRACE_ATTR_NAME),
      /* computed */ true,
    );
    const isObject = t.binaryExpression(
      '===',
      t.unaryExpression('typeof', t.identifier(name)),
      t.stringLiteral('object'),
    );
    const isFunction = t.binaryExpression(
      '===',
      t.unaryExpression('typeof', t.identifier(name)),
      t.stringLiteral('function'),
    );
    const guard = t.logicalExpression(
      '&&',
      t.identifier(name),
      t.logicalExpression('||', isObject, isFunction),
    );
    const guardedAssign = t.ifStatement(
      guard,
      t.expressionStatement(
        t.assignmentExpression('=', memberAccess, t.stringLiteral(payload)),
      ),
    );
    // Explicit catch binding (not optional-catch) for maximum engine
    // compatibility — older Hermes / Metro targets predate ES2019.
    return t.tryStatement(
      t.blockStatement([guardedAssign]),
      t.catchClause(t.identifier('_flotraceErr'), t.blockStatement([])),
    );
  }

  /**
   * Insert a sibling assignment immediately after a top-level declaration
   * path. `path` here is the *outermost* statement we want to insert after
   * — for an `export default function X() {}`, the outer path is the
   * ExportDefaultDeclaration, not the FunctionDeclaration inside it.
   * Returns true when injection happened (used by callers to mark the node
   * as visited and prevent re-injection).
   */
  /**
   * Does `stmt` assign `name['data-flotrace-src']`? Matches the injected shape
   * `try { if (<guard>) name['data-flotrace-src'] = … } catch {}` by looking at
   * the ASSIGNMENT TARGET, so it survives changes to the guard / wrapper shape.
   */
  function isExistingDeclTag(stmt, name) {
    if (!stmt || stmt.type !== 'TryStatement' || !stmt.block) return false;
    const body = stmt.block.body || [];
    for (let i = 0; i < body.length; i++) {
      const inner = body[i];
      if (!inner || inner.type !== 'IfStatement' || !inner.consequent) continue;
      const cons = inner.consequent;
      const expr = cons.type === 'ExpressionStatement' ? cons.expression : null;
      if (!expr || expr.type !== 'AssignmentExpression') continue;
      const left = expr.left;
      if (
        left.type === 'MemberExpression' &&
        left.computed &&
        left.object.type === 'Identifier' &&
        left.object.name === name &&
        left.property.type === 'StringLiteral' &&
        left.property.value === FLOTRACE_ATTR_NAME
      ) {
        return true;
      }
    }
    return false;
  }

  function insertDeclTagAfter(path, name, payload) {
    // Idempotency: skip if a previous run already injected the tag for this
    // identifier. Babel can re-visit the path after other plugins mutate the
    // program (and the plugin runs again on already-transformed output).
    const siblings =
      path.parentPath && path.parentPath.get('body')
        ? [].concat(path.parentPath.get('body'))
        : [];
    for (let i = 0; i < siblings.length; i++) {
      if (isExistingDeclTag(siblings[i].node, name)) return false;
    }
    path.insertAfter(buildDeclTaggingStatement(name, payload));
    return true;
  }

  return {
    name: 'flotrace-source-attribution',
    visitor: {
      // ────────────────────────────────────────────────────────────
      // (A) Tag every JSX element with its call-site source.
      // ────────────────────────────────────────────────────────────
      JSXOpeningElement(path, state) {
        const filename = shouldVisit(state, path.node.loc);
        if (!filename) return;

        // Idempotency: skip if a previous run already injected the attribute
        // (Babel can re-traverse after another plugin mutates the node).
        const attrs = path.node.attributes;
        for (let i = 0; i < attrs.length; i++) {
          const attr = attrs[i];
          if (
            attr.type === 'JSXAttribute' &&
            attr.name &&
            attr.name.type === 'JSXIdentifier' &&
            attr.name.name === FLOTRACE_ATTR_NAME
          ) {
            return;
          }
        }

        // Skip `<Fragment>` openings — Fragment doesn't accept arbitrary
        // props, and React would warn on the unknown attribute. Note that
        // `<></>` short-syntax is a `JSXFragment` AST node (not a
        // `JSXOpeningElement`), so the visitor never fires for it — only
        // the named forms reach this point.
        const openingName = path.node.name;
        if (openingName.type === 'JSXIdentifier' && openingName.name === 'Fragment') {
          return;
        }
        // `<React.Fragment>` / `<MyNs.Fragment>` — JSXMemberExpression with
        // a trailing `Fragment` identifier. (`React.Fragment` cannot appear
        // as a plain JSXIdentifier — identifiers don't permit dots.)
        if (
          openingName.type === 'JSXMemberExpression' &&
          openingName.property &&
          openingName.property.name === 'Fragment'
        ) {
          return;
        }

        const payload = buildPayload(filename, path.node.loc);
        // Wrap the JSON payload in a JSX expression container so the value
        // uses JS-string-literal escaping rules. A bare `t.stringLiteral`
        // here would render as `data-flotrace-src="..."` — but JSX string
        // attributes don't support C-style escapes, so embedded `"` chars
        // produce invalid JSX. The expression-container form (`name={...}`)
        // sidesteps the whole quoting problem.
        attrs.push(
          t.jsxAttribute(
            t.jsxIdentifier(FLOTRACE_ATTR_NAME),
            t.jsxExpressionContainer(t.stringLiteral(payload)),
          ),
        );
      },

      // ────────────────────────────────────────────────────────────
      // (B) Tag every PascalCase component definition with its declaration
      //     source. Covers fibers instantiated via `React.createElement`
      //     from inside a library (react-navigation screens, HOC-wrapped
      //     components, AppRegistry-registered roots).
      // ────────────────────────────────────────────────────────────
      FunctionDeclaration(path, state) {
        const id = path.node.id;
        if (!id || !isComponentName(id.name)) return;
        const filename = shouldVisit(state, path.node.loc);
        if (!filename) return;
        // If wrapped in `export default function X() {}` /
        // `export function X() {}`, attach the assignment AFTER the export
        // statement so it's evaluated at module-eval time (function decls
        // are hoisted, so the identifier is defined by then).
        const target =
          path.parentPath.isExportDefaultDeclaration() ||
          path.parentPath.isExportNamedDeclaration()
            ? path.parentPath
            : path;
        const payload = buildPayload(filename, path.node.loc);
        insertDeclTagAfter(target, id.name, payload);
      },

      ClassDeclaration(path, state) {
        const id = path.node.id;
        if (!id || !isComponentName(id.name)) return;
        const filename = shouldVisit(state, path.node.loc);
        if (!filename) return;
        const target =
          path.parentPath.isExportDefaultDeclaration() ||
          path.parentPath.isExportNamedDeclaration()
            ? path.parentPath
            : path;
        const payload = buildPayload(filename, path.node.loc);
        insertDeclTagAfter(target, id.name, payload);
      },

      VariableDeclarator(path, state) {
        const id = path.node.id;
        if (!id || id.type !== 'Identifier') return;
        if (!isComponentName(id.name)) return;
        if (!isComponentLikeInit(path.node.init)) return;
        const filename = shouldVisit(state, path.node.loc);
        if (!filename) return;
        // VariableDeclarator's parent is VariableDeclaration; that may be
        // wrapped in ExportNamedDeclaration (`export const Foo = ...`).
        // Walk up to the outermost statement so the assignment lands at
        // the right scope.
        let target = path.parentPath; // VariableDeclaration
        if (
          target.parentPath &&
          (target.parentPath.isExportNamedDeclaration() ||
            target.parentPath.isExportDefaultDeclaration())
        ) {
          target = target.parentPath;
        }
        const payload = buildPayload(filename, path.node.loc);
        insertDeclTagAfter(target, id.name, payload);
      },
    },
  };
};

// Re-export the attribute name so the runtime reader and tests have a
// single source of truth (no string drift between plugin and walker).
module.exports.FLOTRACE_ATTR_NAME = FLOTRACE_ATTR_NAME;
