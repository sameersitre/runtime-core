/**
 * @flotrace/runtime-core/babel-plugin
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
 * Usage in user babel.config.js (single line, no other config changes):
 *
 *   plugins: ['@flotrace/runtime-core/babel-plugin']
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
      return false;
    default:
      // Component-shaped: ArrowFunctionExpression, FunctionExpression,
      // ClassExpression, CallExpression (HOC wrap), Identifier (re-export),
      // MemberExpression (`X.Y`), ConditionalExpression, etc.
      return true;
  }
}

module.exports = function flotraceSourceAttributionPlugin({ types: t }) {
  /**
   * Build the `Identifier['data-flotrace-src'] = '<payload>';` statement.
   * Guarded with `if (Identifier)` so reassignments to `undefined`/`null`
   * before the assignment runs don't throw at module load.
   */
  function buildDeclTaggingStatement(name, payload) {
    const idRef = t.identifier(name);
    const memberAccess = t.memberExpression(
      t.identifier(name),
      t.stringLiteral(FLOTRACE_ATTR_NAME),
      /* computed */ true,
    );
    return t.ifStatement(
      idRef,
      t.expressionStatement(
        t.assignmentExpression('=', memberAccess, t.stringLiteral(payload)),
      ),
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
  function insertDeclTagAfter(path, name, payload) {
    // Idempotency: scan siblings for an existing assignment to the same
    // identifier + same attribute. Babel can re-visit the path after other
    // plugins mutate the program.
    const siblings =
      path.parentPath && path.parentPath.get('body')
        ? [].concat(path.parentPath.get('body'))
        : [];
    for (let i = 0; i < siblings.length; i++) {
      const sib = siblings[i].node;
      if (
        sib &&
        sib.type === 'IfStatement' &&
        sib.test &&
        sib.test.type === 'Identifier' &&
        sib.test.name === name &&
        sib.consequent &&
        sib.consequent.type === 'ExpressionStatement' &&
        sib.consequent.expression &&
        sib.consequent.expression.type === 'AssignmentExpression'
      ) {
        const left = sib.consequent.expression.left;
        if (
          left.type === 'MemberExpression' &&
          left.computed &&
          left.property.type === 'StringLiteral' &&
          left.property.value === FLOTRACE_ATTR_NAME
        ) {
          return false;
        }
      }
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
        if (!id || !PASCAL_CASE_RE.test(id.name)) return;
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
        if (!id || !PASCAL_CASE_RE.test(id.name)) return;
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
        if (!PASCAL_CASE_RE.test(id.name)) return;
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
