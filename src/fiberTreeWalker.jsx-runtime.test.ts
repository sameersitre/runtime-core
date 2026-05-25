/**
 * Tests for the JSX-runtime integration in fiberTreeWalker:
 *
 *   - readJsxSourceFromFiber: reads + validates the FLOTRACE_SOURCE symbol off
 *     a fiber's memoizedProps.
 *   - resolveSourceConfidence: four-tier decision tree (exact / inferred /
 *     package / unknown).
 *   - resolveEffectiveSourcePath: priority ladder (JSX runtime → _debugSource
 *     → _debugOwner → _debugStack).
 *
 * The helpers are file-local in fiberTreeWalker.ts; we reach them via the
 * `__*ForTesting` escape-hatches (same convention as
 * `__walkFiberForTesting` / `__setWalkerFilterConfigForTesting`).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  __readJsxSourceFromFiberForTesting as readJsxSourceFromFiber,
  __resolveSourceConfidenceForTesting as resolveSourceConfidence,
  __resolveEffectiveSourcePathForTesting as resolveEffectiveSourcePath,
  __resolveEffectiveSourceLocationForTesting as resolveEffectiveSourceLocation,
  __parseFirstNonReactFrameForTesting as parseFirstNonReactFrame,
  __walkFiberForTesting as walkFiber,
  __setWalkerFilterConfigForTesting,
  __resetWalkerFilterConfigForTesting,
  type Fiber,
} from './fiberTreeWalker';
import {
  FLOTRACE_SOURCE,
  FLOTRACE_SRC_ATTR,
  isUserComponent,
  type FlotraceJsxSource,
} from './jsxRuntimeUtils';

// ─────────────────────────────────────────────────────────────────────────────
// Synthetic fiber builder — only the fields the helpers actually read.
// ─────────────────────────────────────────────────────────────────────────────

function createFiber(override: Partial<Fiber> = {}): Fiber {
  return {
    // Minimum viable Fiber shape — fill with no-op defaults.
    tag: 0,
    type: null,
    key: null,
    child: null,
    sibling: null,
    return: null,
    memoizedProps: null,
    pendingProps: null,
    memoizedState: null,
    ...override,
  } as Fiber;
}

const FULL_SOURCE: FlotraceJsxSource = {
  fileName: 'src/components/Header.tsx',
  lineNumber: 42,
  columnNumber: 8,
  callSiteId: 'deadbeef',
};

describe('fiberTreeWalker — JSX runtime integration', () => {
  describe('readJsxSourceFromFiber', () => {
    test('returns undefined when memoizedProps is null', () => {
      expect(readJsxSourceFromFiber(createFiber({ memoizedProps: null }))).toBeUndefined();
    });

    test('returns undefined when symbol is absent from props', () => {
      const fiber = createFiber({ memoizedProps: { title: 'Hi' } });
      expect(readJsxSourceFromFiber(fiber)).toBeUndefined();
    });

    test('returns the FlotraceJsxSource when symbol is present and shape is valid', () => {
      const fiber = createFiber({
        memoizedProps: {
          title: 'Hi',
          [FLOTRACE_SOURCE]: FULL_SOURCE,
        } as Record<string | symbol, unknown> as Record<string, unknown>,
      });
      expect(readJsxSourceFromFiber(fiber)).toBe(FULL_SOURCE);
    });

    test.each([
      ['missing fileName', { lineNumber: 1, columnNumber: 1, callSiteId: 'a' }],
      ['fileName not a string', { fileName: 123, lineNumber: 1, columnNumber: 1, callSiteId: 'a' }],
      [
        'lineNumber not a number',
        { fileName: 'x', lineNumber: '1', columnNumber: 1, callSiteId: 'a' },
      ],
      [
        'columnNumber not a number',
        { fileName: 'x', lineNumber: 1, columnNumber: '1', callSiteId: 'a' },
      ],
      [
        'callSiteId not a string',
        { fileName: 'x', lineNumber: 1, columnNumber: 1, callSiteId: 123 },
      ],
    ])('rejects malformed shape: %s', (_label, malformed) => {
      // Defensive: a Symbol.for('flotrace.source') collision from unrelated
      // tooling must not produce phantom node attribution.
      const fiber = createFiber({
        memoizedProps: {
          [FLOTRACE_SOURCE]: malformed,
        } as Record<string | symbol, unknown> as Record<string, unknown>,
      });
      expect(readJsxSourceFromFiber(fiber)).toBeUndefined();
    });

    test('returns undefined for non-object symbol value (string / number / null)', () => {
      for (const malformed of ['oops', 42, null]) {
        const fiber = createFiber({
          memoizedProps: {
            [FLOTRACE_SOURCE]: malformed,
          } as Record<string | symbol, unknown> as Record<string, unknown>,
        });
        expect(readJsxSourceFromFiber(fiber)).toBeUndefined();
      }
    });

    test('reads data-flotrace-src JSON payload from string-keyed prop (babel plugin route)', () => {
      // The nativewind / RN scenario: the symbol-keyed JSX-runtime opt-in
      // is unusable (another consumer owns `importSource`), so the babel
      // plugin injects a string-keyed JSONattribute instead. Walker must
      // parse that route too.
      const fiber = createFiber({
        memoizedProps: {
          'data-flotrace-src': JSON.stringify({
            f: '/abs/project/src/Foo.tsx',
            l: 42,
            c: 7,
          }),
        },
      });
      const result = readJsxSourceFromFiber(fiber);
      expect(result).toBeDefined();
      expect(result?.fileName).toBe('/abs/project/src/Foo.tsx');
      expect(result?.lineNumber).toBe(42);
      expect(result?.columnNumber).toBe(7);
      // callSiteId computed at read time — non-empty 8-char hex string.
      expect(result?.callSiteId).toMatch(/^[0-9a-f]{8}$/);
    });

    test('symbol-keyed route wins over data-flotrace-src when both are present', () => {
      // The JSX-runtime opt-in carries a precomputed callSiteId + inline
      // diagnostics; the babel-plugin route only carries position. Prefer
      // the higher-precision payload when both exist.
      const fiber = createFiber({
        memoizedProps: {
          [FLOTRACE_SOURCE]: FULL_SOURCE,
          'data-flotrace-src': JSON.stringify({ f: 'wrong.tsx', l: 1, c: 1 }),
        } as Record<string | symbol, unknown> as Record<string, unknown>,
      });
      expect(readJsxSourceFromFiber(fiber)?.fileName).toBe(FULL_SOURCE.fileName);
    });

    test('rejects malformed data-flotrace-src JSON', () => {
      // Anything that doesn't parse as `{f: string, l: number, c: number}`
      // must yield undefined rather than a partially-populated source — a
      // bad value here would silently steer click-to-IDE to nowhere.
      const cases = [
        'not json at all',
        JSON.stringify({ f: 'x.tsx', l: 'oops', c: 1 }),
        JSON.stringify({ f: 'x.tsx', c: 1 }), // missing l
        JSON.stringify(null),
        JSON.stringify(42),
      ];
      for (const malformed of cases) {
        const fiber = createFiber({
          memoizedProps: { 'data-flotrace-src': malformed },
        });
        expect(readJsxSourceFromFiber(fiber)).toBeUndefined();
      }
    });

    test('data-flotrace-src as a non-string prop is ignored (defensive)', () => {
      const fiber = createFiber({
        memoizedProps: {
          'data-flotrace-src': { f: 'x.tsx', l: 1, c: 1 } as unknown as string,
        },
      });
      expect(readJsxSourceFromFiber(fiber)).toBeUndefined();
    });

    test('reads data-flotrace-src off fiber.type as a fallback (definition-site attribution)', () => {
      // react-navigation scenario: a Screen instantiated via
      // React.createElement(component, ...) — its fiber's memoizedProps
      // never sees user JSX, but the babel plugin tagged the function
      // reference itself. The walker reads off fiber.type as the last
      // route before degrading to the heuristic ladder.
      const componentFn = function HomeScreen() {
        return null;
      };
      (componentFn as unknown as Record<string, unknown>)['data-flotrace-src'] =
        JSON.stringify({ f: '/p/HomeScreen.tsx', l: 5, c: 1 });

      const fiber = createFiber({
        memoizedProps: null,
        type: componentFn as unknown as Fiber['type'],
      });
      const result = readJsxSourceFromFiber(fiber);
      expect(result?.fileName).toBe('/p/HomeScreen.tsx');
      expect(result?.lineNumber).toBe(5);
    });

    test('memoizedProps route wins over fiber.type route', () => {
      // When the user wrote `<HomeScreen />` directly (call-site attribution
      // available), prefer that over the declaration's location — a user
      // clicking on a specific Screen instance in a tree of N instances
      // expects to land on the specific call, not the shared definition.
      const componentFn = function HomeScreen() {
        return null;
      };
      (componentFn as unknown as Record<string, unknown>)['data-flotrace-src'] =
        JSON.stringify({ f: '/p/HomeScreen.tsx', l: 1, c: 1 });

      const fiber = createFiber({
        memoizedProps: {
          'data-flotrace-src': JSON.stringify({
            f: '/p/CallSite.tsx',
            l: 42,
            c: 7,
          }),
        },
        type: componentFn as unknown as Fiber['type'],
      });
      expect(readJsxSourceFromFiber(fiber)?.fileName).toBe('/p/CallSite.tsx');
    });

    test('does not crash on string fiber.type (host component like "View")', () => {
      // RN host components have a string type ('View', 'Text'); strings
      // can't carry properties. The walker must skip the type route for
      // these rather than throwing.
      const fiber = createFiber({
        memoizedProps: null,
        type: 'View' as unknown as Fiber['type'],
      });
      expect(() => readJsxSourceFromFiber(fiber)).not.toThrow();
      expect(readJsxSourceFromFiber(fiber)).toBeUndefined();
    });

    test('skips fiber.type when the value is a non-string attribute', () => {
      const componentFn = function Foo() {
        return null;
      };
      (componentFn as unknown as Record<string, unknown>)['data-flotrace-src'] = 42;
      const fiber = createFiber({
        memoizedProps: null,
        type: componentFn as unknown as Fiber['type'],
      });
      expect(readJsxSourceFromFiber(fiber)).toBeUndefined();
    });
  });

  describe('resolveSourceConfidence — four-tier decision tree', () => {
    test('framework wins over node_modules source signal — returns "package"', () => {
      // A framework wrapper (real framework code lives in node_modules) with
      // _debugSource pointing there must classify as `package` so the UI
      // doesn't surface a file:line link or `?` pill on a framework wrapper.
      // The path-based check in `isUserComponent` rejects node_modules paths,
      // so the top-priority short-circuit doesn't fire and the framework flag
      // wins through the original code path.
      //
      // (Pre-Route-B-fallback, this test used `'fw/Wrapper.tsx'` as the
      // fixture — a path with no `node_modules` marker, which was unrealistic
      // for a framework component. Real frameworks ALWAYS live in node_modules;
      // the realistic fixture exercises the actual production code path.)
      const fiber = createFiber({
        _debugSource: {
          fileName: '/abs/project/node_modules/some-fw/Wrapper.tsx',
          lineNumber: 1,
        },
      });
      expect(resolveSourceConfidence(fiber, true, false)).toBe('package');
    });

    test('library wins over any source signal — returns "package"', () => {
      const fiber = createFiber({
        _debugSource: { fileName: 'node_modules/@radix-ui/popover/index.tsx', lineNumber: 1 },
      });
      expect(resolveSourceConfidence(fiber, false, true)).toBe('package');
    });

    test('JSX-runtime symbol present → "exact"', () => {
      const fiber = createFiber({
        memoizedProps: {
          [FLOTRACE_SOURCE]: FULL_SOURCE,
        } as Record<string | symbol, unknown> as Record<string, unknown>,
      });
      expect(resolveSourceConfidence(fiber, false, false)).toBe('exact');
    });

    test('_debugSource populated but no JSX symbol → "exact"', () => {
      const fiber = createFiber({
        _debugSource: { fileName: 'src/Foo.tsx', lineNumber: 10 },
      });
      expect(resolveSourceConfidence(fiber, false, false)).toBe('exact');
    });

    test('only owner-chain _debugSource → "inferred"', () => {
      const owner = createFiber({
        _debugSource: { fileName: 'src/Owner.tsx', lineNumber: 5 },
      });
      const fiber = createFiber({ _debugOwner: owner });
      expect(resolveSourceConfidence(fiber, false, false)).toBe('inferred');
    });

    test('no source signal at any tier → "unknown"', () => {
      const fiber = createFiber();
      expect(resolveSourceConfidence(fiber, false, false)).toBe('unknown');
    });
  });

  describe('resolveEffectiveSourcePath — priority ladder', () => {
    test('JSX-runtime symbol takes priority over _debugSource', () => {
      // The point of the JSX runtime is to provide the most precise source —
      // when both signals exist, the runtime wins.
      const fiber = createFiber({
        memoizedProps: {
          [FLOTRACE_SOURCE]: { ...FULL_SOURCE, fileName: 'jsx-runtime/path.tsx' },
        } as Record<string | symbol, unknown> as Record<string, unknown>,
        _debugSource: { fileName: 'debug-source/path.tsx', lineNumber: 1 },
      });
      expect(resolveEffectiveSourcePath(fiber)).toBe('jsx-runtime/path.tsx');
    });

    test('falls back to _debugSource when JSX symbol absent', () => {
      const fiber = createFiber({
        _debugSource: { fileName: 'src/Foo.tsx', lineNumber: 1 },
      });
      expect(resolveEffectiveSourcePath(fiber)).toBe('src/Foo.tsx');
    });

    test('falls back to owner-chain when fiber itself lacks signals', () => {
      const grandparent = createFiber({
        _debugSource: { fileName: 'src/Grandparent.tsx', lineNumber: 1 },
      });
      const parent = createFiber({ _debugOwner: grandparent });
      const child = createFiber({ _debugOwner: parent });
      expect(resolveEffectiveSourcePath(child)).toBe('src/Grandparent.tsx');
    });

    test('returns null when nothing resolves', () => {
      const fiber = createFiber();
      expect(resolveEffectiveSourcePath(fiber)).toBeNull();
    });
  });

  describe('parseFirstNonReactFrame — line/column extraction', () => {
    test('extracts fileName + lineNumber + columnNumber from a V8 frame (file:// stripped)', () => {
      // normalizeStackFramePath strips the `file://` prefix so the desktop's
      // editor IPC receives a plain absolute path — no special-casing needed
      // downstream.
      const stack = [
        'Error',
        '    at Component (file:///Users/me/app/src/Foo.tsx:42:8)',
      ].join('\n');
      expect(parseFirstNonReactFrame(stack)).toEqual({
        fileName: '/Users/me/app/src/Foo.tsx',
        lineNumber: 42,
        columnNumber: 8,
      });
    });

    test('extracts fileName + lineNumber + columnNumber from a Hermes frame', () => {
      // Hermes format (RN): "Component@/abs/path/file.tsx:10:5"
      const stack = ['Error', 'Component@/abs/path/Foo.tsx:10:5'].join('\n');
      expect(parseFirstNonReactFrame(stack)).toEqual({
        fileName: '/abs/path/Foo.tsx',
        lineNumber: 10,
        columnNumber: 5,
      });
    });

    test('skips React internal frames and returns the first user frame', () => {
      const stack = [
        'Error',
        '    at jsx (file:///node_modules/react-dom/cjs/react-dom.js:1:1)',
        '    at renderRoot (/scheduler/cjs/scheduler.js:2:2)',
        '    at performWork (file:///path/to/react-native/Libraries/Renderer.js:3:3)',
        '    at MyButton (file:///Users/me/app/src/Button.tsx:25:12)',
      ].join('\n');
      expect(parseFirstNonReactFrame(stack)).toEqual({
        fileName: '/Users/me/app/src/Button.tsx',
        lineNumber: 25,
        columnNumber: 12,
      });
    });

    test('returns null when no user frame is found', () => {
      const stack = [
        'Error',
        '    at jsx (file:///node_modules/react-dom/cjs/react-dom.js:1:1)',
      ].join('\n');
      expect(parseFirstNonReactFrame(stack)).toBeNull();
    });

    test('skips Metro bundle frames (RN dev) — no source-level signal available', () => {
      // Trovieapp scenario: Hermes stack frames in Metro dev reference the
      // bundle URL, not the source. Capturing this would produce a garbage
      // filePath like `http://10.0.2.2:8081/index.bundle?platform=android&...`
      // that the desktop's editor IPC then rejects with "File not found on disk".
      // Skipping these keeps RN dev at "no click-to-source button" (the
      // pre-fix behaviour) rather than "broken click-to-source button".
      const stack = [
        'Error',
        'App@http://10.0.2.2:8081/index.bundle?platform=android&dev=true&app=com.trovie:1234:56',
      ].join('\n');
      expect(parseFirstNonReactFrame(stack)).toBeNull();
    });

    test('falls through to a user frame after skipping a leading bundle frame', () => {
      // Defensive: if a real source frame happens to follow a bundle frame
      // (unusual but possible with mixed source-map states), we should still
      // surface it rather than bail on the first bundle hit.
      const stack = [
        'Error',
        'jsx@http://10.0.2.2:8081/index.bundle?platform=ios:1:1',
        '    at MyButton (file:///Users/me/app/src/Button.tsx:25:12)',
      ].join('\n');
      expect(parseFirstNonReactFrame(stack)).toEqual({
        fileName: '/Users/me/app/src/Button.tsx',
        lineNumber: 25,
        columnNumber: 12,
      });
    });

    test('normalizes Vite dev-server URLs to project-relative paths', () => {
      // Vite serves source files directly with HMR version queries:
      //   http://localhost:5173/src/App.tsx?t=1700000000000
      // After normalization → `src/App.tsx`, which the desktop resolves
      // against the active project root.
      const stack = [
        'Error',
        '    at App (http://localhost:5173/src/App.tsx?t=1700000000000:11:4)',
      ].join('\n');
      expect(parseFirstNonReactFrame(stack)).toEqual({
        fileName: 'src/App.tsx',
        lineNumber: 11,
        columnNumber: 4,
      });
    });
  });

  describe('resolveEffectiveSourceLocation — React 19 _debugStack fallback', () => {
    test('returns full location from JSX-runtime symbol', () => {
      const fiber = createFiber({
        memoizedProps: {
          [FLOTRACE_SOURCE]: FULL_SOURCE,
        } as Record<string | symbol, unknown> as Record<string, unknown>,
      });
      expect(resolveEffectiveSourceLocation(fiber)).toEqual({
        fileName: 'src/components/Header.tsx',
        lineNumber: 42,
        columnNumber: 8,
      });
    });

    test('returns fileName + lineNumber from _debugSource (React 18)', () => {
      const fiber = createFiber({
        _debugSource: { fileName: 'src/Foo.tsx', lineNumber: 17 },
      });
      expect(resolveEffectiveSourceLocation(fiber)).toEqual({
        fileName: 'src/Foo.tsx',
        lineNumber: 17,
      });
    });

    test('falls back to _debugStack with line/col when _debugSource is absent (React 19+)', () => {
      // The React-19 web scenario: _debugSource is undefined, only _debugStack
      // carries the JSX-creation site. Without this branch the click-to-source
      // button never renders. (RN dev separately falls through to null via the
      // bundle-URL skip — exercised in its own test below.)
      const fiber = createFiber({
        _debugStack: {
          stack: 'Error\n    at App (file:///app/src/App.tsx:11:4)',
        },
      });
      expect(resolveEffectiveSourceLocation(fiber)).toEqual({
        fileName: '/app/src/App.tsx',
        lineNumber: 11,
        columnNumber: 4,
      });
    });

    test('owner-chain hit yields fileName only (no line — wrapper line ≠ caller line)', () => {
      const grandparent = createFiber({
        _debugSource: { fileName: 'src/Grandparent.tsx', lineNumber: 1 },
      });
      const parent = createFiber({ _debugOwner: grandparent });
      const child = createFiber({ _debugOwner: parent });
      expect(resolveEffectiveSourceLocation(child)).toEqual({
        fileName: 'src/Grandparent.tsx',
      });
    });

    test('returns null when no evidence at all', () => {
      expect(resolveEffectiveSourceLocation(createFiber())).toBeNull();
    });
  });

  describe('walkFiber — LiveTreeNode.filePath/lineNumber from _debugStack (React 19)', () => {
    test('populates filePath + lineNumber from _debugStack when _debugSource is absent', () => {
      // React 19 web fiber shape — `_debugStack` carries a normal file URL
      // pointing at the actual source (not a bundle URL).
      const fn = function App() {} as unknown as { displayName?: string };
      fn.displayName = 'App';
      const fiber = createFiber({
        tag: 0, // FunctionComponent
        type: fn as unknown as Fiber['type'],
        _debugStack: {
          stack: 'Error\n    at App (file:///app/src/App.tsx:11:4)',
        },
      });
      const [node] = walkFiber(fiber);
      expect(node.filePath).toBe('/app/src/App.tsx');
      expect(node.lineNumber).toBe(11);
    });

    test('leaves filePath/lineNumber undefined when _debugStack is only a Metro bundle URL', () => {
      // The trovieapp scenario after this fix: bundle-only stack frames are
      // skipped, so the LiveTreeNode goes back to having no file info — same
      // as the pre-runtime-fix behaviour. Click-to-source button is hidden
      // (ComponentNode.tsx:75 gate `filePath && lineNumber > 0`), no garbage
      // path leaks to the desktop's editor IPC.
      const fn = function App() {} as unknown as { displayName?: string };
      fn.displayName = 'App';
      const fiber = createFiber({
        tag: 0,
        type: fn as unknown as Fiber['type'],
        _debugStack: {
          stack:
            'Error\nApp@http://10.0.2.2:8081/index.bundle?platform=android&dev=true:1234:56',
        },
      });
      const [node] = walkFiber(fiber);
      expect(node.filePath).toBeUndefined();
      expect(node.lineNumber).toBeUndefined();
    });

    test('_debugSource wins over _debugStack when both are present', () => {
      // Avoids spurious stack-frame churn for React 18 / early-19 fibers
      // that still carry _debugSource.
      const fn = function Foo() {} as unknown as { displayName?: string };
      fn.displayName = 'Foo';
      const fiber = createFiber({
        tag: 0,
        type: fn as unknown as Fiber['type'],
        _debugSource: { fileName: 'src/Foo.tsx', lineNumber: 5 },
        _debugStack: {
          stack: 'Error\n    at Foo (file:///elsewhere/Foo.tsx:99:1)',
        },
      });
      const [node] = walkFiber(fiber);
      expect(node.filePath).toBe('src/Foo.tsx');
      expect(node.lineNumber).toBe(5);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// New top-priority `isUserComponent` signal + walker short-circuits.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a function-component-shaped `fiber.type` carrying a `data-flotrace-src`
 * attribute (the babel plugin's declaration-tag payload). Mirrors what the
 * runtime sees: the function reference IS the fiber type, and the plugin's
 * post-declaration assignment set `Component['data-flotrace-src'] = '{...}'`.
 */
function buildTaggedComponentType(filePath: string): unknown {
  const fn = function TaggedComponent() {
    return null;
  };
  (fn as unknown as Record<string, unknown>)[FLOTRACE_SRC_ATTR] = JSON.stringify({
    f: filePath,
    l: 1,
    c: 1,
  });
  return fn;
}

describe('isUserComponent — babel-plugin declaration-site signal (Route A)', () => {
  test.each([
    ['function ref tagged with user path', buildTaggedComponentType('/abs/project/src/Foo.tsx'), true],
    [
      'function ref tagged with node_modules path',
      buildTaggedComponentType('/abs/project/node_modules/lib/Bar.js'),
      false,
    ],
    ['function ref WITHOUT the tag (plugin missing or library code)', function Untagged() {}, false],
    ['host-component string type (e.g. "View")', 'View', false],
    ['null type (defensive)', null, false],
    ['undefined type (defensive)', undefined, false],
    [
      'ForwardRef object tagged with user path',
      (() => {
        const obj = { $$typeof: Symbol.for('react.forward_ref'), render: () => null };
        (obj as unknown as Record<string, unknown>)[FLOTRACE_SRC_ATTR] = JSON.stringify({
          f: '/abs/project/src/Btn.tsx',
          l: 1,
          c: 1,
        });
        return obj;
      })(),
      true,
    ],
    [
      'Memo object tagged with user path',
      (() => {
        const obj = { $$typeof: Symbol.for('react.memo'), type: () => null };
        (obj as unknown as Record<string, unknown>)[FLOTRACE_SRC_ATTR] = JSON.stringify({
          f: '/abs/project/src/Memo.tsx',
          l: 1,
          c: 1,
        });
        return obj;
      })(),
      true,
    ],
  ])('returns the expected verdict for %s', (_label, type, expected) => {
    expect(isUserComponent({ type })).toBe(expected);
  });

  test('rejects a function whose data-flotrace-src is malformed JSON', () => {
    const fn = function Mal() {};
    (fn as unknown as Record<string, unknown>)[FLOTRACE_SRC_ATTR] = 'not json at all';
    expect(isUserComponent({ type: fn })).toBe(false);
  });

  test('rejects a function whose attribute value is a non-string (defensive)', () => {
    const fn = function NumAttr() {};
    (fn as unknown as Record<string, unknown>)[FLOTRACE_SRC_ATTR] = 42;
    expect(isUserComponent({ type: fn })).toBe(false);
  });

  test('rejects when the parsed payload is missing the file field', () => {
    const fn = function NoFile() {};
    (fn as unknown as Record<string, unknown>)[FLOTRACE_SRC_ATTR] = JSON.stringify({
      l: 1,
      c: 1,
    });
    expect(isUserComponent({ type: fn })).toBe(false);
  });
});

describe('walker short-circuits driven by isUserComponent', () => {
  beforeEach(() => {
    __resetWalkerFilterConfigForTesting();
  });
  afterEach(() => {
    __resetWalkerFilterConfigForTesting();
  });

  // ─── 1. isFrameworkComponent (via the indirect-test through resolveSourceConfidence)
  //
  // We don't have a direct testing export for isFrameworkComponent itself.
  // The most direct way to lock the short-circuit is through
  // resolveSourceConfidence, which receives `isFramework` as a precomputed
  // arg and would normally collapse to 'package'. With the user-tag short-
  // circuit, it must return 'exact'.

  test('resolveSourceConfidence short-circuit: user-tag overrides isFramework=true → exact', () => {
    // The regression we want to prevent: a user component named the same as
    // a framework wrapper (e.g. `Provider`, `Modal`) gets flagged as
    // framework upstream — but the plugin signal on its type says it's
    // definitively user code. Confidence should be `'exact'`, not `'package'`.
    const userType = buildTaggedComponentType('/abs/project/src/Provider.tsx');
    const fiber = createFiber({ type: userType as Fiber['type'], memoizedProps: null });
    expect(resolveSourceConfidence(fiber, /* isFramework */ true, /* isLibrary */ false)).toBe(
      'exact',
    );
  });

  test('resolveSourceConfidence short-circuit: user-tag overrides isLibrary=true → exact', () => {
    const userType = buildTaggedComponentType('/abs/project/src/Tooltip.tsx');
    const fiber = createFiber({ type: userType as Fiber['type'], memoizedProps: null });
    expect(resolveSourceConfidence(fiber, /* isFramework */ false, /* isLibrary */ true)).toBe(
      'exact',
    );
  });

  // ─── 2. No-plugin fallback (the "additive, non-breaking" contract)
  //
  // With no `data-flotrace-src` on the type, isUserComponent returns false →
  // none of the short-circuits fire → existing logic runs unchanged. The
  // resolveSourceConfidence behavior must remain `'package'` for a fiber
  // marked as framework, exactly as before this patch.

  test('no-plugin fallback: resolveSourceConfidence returns "package" when type is untagged + isFramework=true', () => {
    const untaggedType = function Untagged() {};
    const fiber = createFiber({
      type: untaggedType as Fiber['type'],
      memoizedProps: null,
    });
    expect(resolveSourceConfidence(fiber, /* isFramework */ true, /* isLibrary */ false)).toBe(
      'package',
    );
  });

  test('no-plugin fallback: resolveSourceConfidence returns "package" when type is untagged + isLibrary=true', () => {
    const untaggedType = function Untagged() {};
    const fiber = createFiber({
      type: untaggedType as Fiber['type'],
      memoizedProps: null,
    });
    expect(resolveSourceConfidence(fiber, /* isFramework */ false, /* isLibrary */ true)).toBe(
      'package',
    );
  });

  // ─── 3. Walker end-to-end: a fiber whose name matches the framework list
  //       AND whose type carries the plugin tag → must be emitted as user
  //       code (NOT hidden as framework). Mirrors the practical trovieapp
  //       fix scenario.

  test('walker emits a user-tagged fiber whose name collides with the framework list', () => {
    // Pre-seed the framework names set with "Provider" so the name lookup
    // would normally hide this fiber.
    __setWalkerFilterConfigForTesting({
      frameworkNames: new Set(['Provider']),
    });
    const taggedType = buildTaggedComponentType('/abs/project/src/MyProvider.tsx');
    // The displayName drives the framework lookup. Set it to the colliding name.
    (taggedType as unknown as { displayName: string }).displayName = 'Provider';

    const fiber = createFiber({
      tag: 0, // FunctionComponent
      type: taggedType as Fiber['type'],
      memoizedProps: null,
    });

    const [node] = walkFiber(fiber);
    expect(node).toBeDefined();
    expect(node.isFramework).toBeUndefined(); // not flagged as framework
    expect(node.sourceConfidence).toBe('exact'); // user-tag wins
    expect(node.filePath).toBe('/abs/project/src/MyProvider.tsx');
  });
});

describe('isUserComponent — JSX-runtime symbol on memoizedProps (Next.js + tsconfig jsxImportSource)', () => {
  // The Next.js path: user sets `jsxImportSource: '@flotrace/runtime-core'` in
  // tsconfig.json, SWC compiles JSX through `@flotrace/runtime-core/jsx-dev-runtime`,
  // which attaches the FLOTRACE_SOURCE symbol to memoizedProps. No babel,
  // no Route C stack parse needed — this should fire via the readJsxSourceFromFiber
  // delegation in isUserComponent.

  test('returns true for a user-path FLOTRACE_SOURCE symbol on memoizedProps', () => {
    expect(
      isUserComponent({
        type: function NextJsPage() {},
        memoizedProps: {
          [FLOTRACE_SOURCE]: {
            fileName: '/abs/project/src/app/page.tsx',
            lineNumber: 1,
            columnNumber: 1,
            callSiteId: 'abcdef01',
          },
        } as Record<string | symbol, unknown> as Record<string, unknown>,
      }),
    ).toBe(true);
  });

  test('returns false for a node_modules FLOTRACE_SOURCE symbol path', () => {
    expect(
      isUserComponent({
        type: function LibComponent() {},
        memoizedProps: {
          [FLOTRACE_SOURCE]: {
            fileName: '/abs/project/node_modules/some-lib/dist/Lib.js',
            lineNumber: 1,
            columnNumber: 1,
            callSiteId: 'aaaaaaaa',
          },
        } as Record<string | symbol, unknown> as Record<string, unknown>,
      }),
    ).toBe(false);
  });

  test('returns true for the babel-plugin string attribute on memoizedProps (Route 2)', () => {
    // The middle route in readJsxSourceFromFiber — when the babel plugin tags
    // JSX-call props (not just the declaration), this is what fires.
    expect(
      isUserComponent({
        type: function Comp() {},
        memoizedProps: {
          'data-flotrace-src': JSON.stringify({
            f: '/abs/project/src/Comp.tsx',
            l: 5,
            c: 3,
          }),
        },
      }),
    ).toBe(true);
  });
});

describe('isUserComponent — `_debugSource` path fallback (Route B, React 18 + Babel JSX source)', () => {
  test('returns true for a user-path _debugSource (React 18 dev with Babel)', () => {
    expect(
      isUserComponent({
        type: function Foo() {},
        _debugSource: { fileName: '/abs/project/src/Foo.tsx', lineNumber: 1 },
      }),
    ).toBe(true);
  });

  test('returns false for a node_modules _debugSource (library code)', () => {
    expect(
      isUserComponent({
        type: function Bar() {},
        _debugSource: {
          fileName: '/abs/project/node_modules/some-lib/dist/Bar.js',
          lineNumber: 1,
        },
      }),
    ).toBe(false);
  });

  test('returns false when _debugSource is null/undefined and no other signal', () => {
    expect(isUserComponent({ type: function Q() {} })).toBe(false);
    expect(isUserComponent({ type: function Q() {}, _debugSource: null })).toBe(false);
  });

  test('Route A still wins when both Routes A and B are present and disagree', () => {
    // Defensive: if for some reason the babel plugin tagged the type with a
    // user path AND _debugSource somehow pointed at node_modules (unlikely
    // but possible with vendored re-bundles), Route A is the more precise
    // signal — the declaration site.
    const taggedType = buildTaggedComponentType('/abs/project/src/Real.tsx');
    expect(
      isUserComponent({
        type: taggedType,
        _debugSource: {
          fileName: '/abs/project/node_modules/should-not-win/x.js',
          lineNumber: 1,
        },
      }),
    ).toBe(true);
  });
});

describe('isUserComponent — `_debugStack` path fallback (Route C, React 19+ web / Next.js SWC)', () => {
  // Next.js SWC builds, Vite + React 19, and any web dev setup that doesn't
  // run Babel — the only source signal React emits is `_debugStack`, an
  // Error whose stack frames contain dev-server URLs. Route C parses those.

  test('returns true for a Next.js webpack-internal user path', () => {
    // Typical Next.js Pages Router (Webpack dev) stack frame format.
    const stack = [
      'Error',
      '    at HomePage (webpack-internal:///./src/pages/index.tsx:42:7)',
    ].join('\n');
    expect(
      isUserComponent({
        type: function HomePage() {},
        _debugStack: { stack },
      }),
    ).toBe(true);
  });

  test('returns true for a Next.js Turbopack [project]/ user path', () => {
    const stack = [
      'Error',
      '    at HomePage ([project]/src/app/page.tsx:11:4)',
    ].join('\n');
    expect(
      isUserComponent({
        type: function HomePage() {},
        _debugStack: { stack },
      }),
    ).toBe(true);
  });

  test('returns true for a Vite http://localhost user path', () => {
    const stack = [
      'Error',
      '    at App (http://localhost:5173/src/App.tsx?t=1700000000000:11:4)',
    ].join('\n');
    expect(
      isUserComponent({
        type: function App() {},
        _debugStack: { stack },
      }),
    ).toBe(true);
  });

  test('returns false when _debugStack only contains node_modules frames', () => {
    const stack = [
      'Error',
      '    at LibButton (webpack-internal:///./node_modules/some-lib/dist/Button.js:1:1)',
    ].join('\n');
    expect(
      isUserComponent({
        type: function LibButton() {},
        _debugStack: { stack },
      }),
    ).toBe(false);
  });

  test('returns false when _debugStack only contains a Metro bundle URL (RN dev)', () => {
    // RN scenario: Hermes stack frames are bundle URLs only. parseFirstNonReactFrame
    // skips these via isJsBundlePath, so Route C yields null → fall through.
    // This locks in the contract: RN dev without the babel plugin still won't
    // give us a user-vs-framework signal via Route C (it must come from Route A).
    const stack = [
      'Error',
      'App@http://10.0.2.2:8081/index.bundle?platform=android&dev=true:1234:56',
    ].join('\n');
    expect(
      isUserComponent({
        type: function App() {},
        _debugStack: { stack },
      }),
    ).toBe(false);
  });

  test('returns false when stack only has React internal frames', () => {
    const stack = [
      'Error',
      '    at performWork (webpack-internal:///./node_modules/react-dom/cjs/react-dom.dev.js:1:1)',
      '    at scheduleRoot (webpack-internal:///./node_modules/scheduler/cjs/scheduler.dev.js:2:2)',
    ].join('\n');
    expect(
      isUserComponent({
        type: function X() {},
        _debugStack: { stack },
      }),
    ).toBe(false);
  });

  test('Route A still wins when both Routes A and C are present', () => {
    const taggedType = buildTaggedComponentType('/abs/project/src/Tagged.tsx');
    const stack = 'Error\n    at Tagged (webpack-internal:///./src/Tagged.tsx:1:1)';
    expect(
      isUserComponent({
        type: taggedType,
        _debugStack: { stack },
      }),
    ).toBe(true);
  });
});

describe('walker short-circuits via Routes B + C (no babel plugin, web only)', () => {
  beforeEach(() => {
    __resetWalkerFilterConfigForTesting();
  });
  afterEach(() => {
    __resetWalkerFilterConfigForTesting();
  });

  test('Next.js scenario: user component with name colliding with framework list + Route C path → exact, not framework', () => {
    // Reproduces the Next.js case the user flagged: no babel plugin, so
    // Route A is absent. The only signal is _debugStack with a user path.
    // Without Route C, this fiber would be hidden as framework.
    __setWalkerFilterConfigForTesting({
      frameworkNames: new Set(['Provider']),
    });
    const componentFn = function Provider() {};
    const fiber = createFiber({
      tag: 0,
      type: componentFn as Fiber['type'],
      memoizedProps: null,
      _debugStack: {
        stack: 'Error\n    at Provider (webpack-internal:///./src/Provider.tsx:1:1)',
      },
    });
    expect(
      resolveSourceConfidence(fiber, /* isFramework */ true, /* isLibrary */ false),
    ).toBe('exact');
  });

  test('React 18 + Babel scenario: _debugSource + framework name collision → exact via Route B', () => {
    __setWalkerFilterConfigForTesting({
      frameworkNames: new Set(['Modal']),
    });
    const fiber = createFiber({
      tag: 0,
      type: function Modal() {} as Fiber['type'],
      memoizedProps: null,
      _debugSource: { fileName: '/abs/project/src/Modal.tsx', lineNumber: 1 },
    });
    expect(
      resolveSourceConfidence(fiber, /* isFramework */ true, /* isLibrary */ false),
    ).toBe('exact');
  });

  test('no-signal fallback: untagged type + no _debugSource + no _debugStack + isFramework=true → "package"', () => {
    // The "additive, non-breaking" contract: when NO source signal exists,
    // isUserComponent returns false and existing behavior is preserved.
    const fiber = createFiber({
      tag: 0,
      type: function Anon() {} as Fiber['type'],
      memoizedProps: null,
    });
    expect(
      resolveSourceConfidence(fiber, /* isFramework */ true, /* isLibrary */ false),
    ).toBe('package');
  });
});
