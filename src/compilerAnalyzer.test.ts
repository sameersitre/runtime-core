/**
 * Coverage target for compilerAnalyzer.ts:
 * - Statements : 100%
 * - Branches   : 100%
 * - Functions  : 100%
 *
 * detectCompilerStatus is a pure function over a synthetic Fiber shape.
 * No mocking required; we construct fibers with the precise fields the
 * function reads (tag, memoizedState.memoizedState, alternate).
 *
 * Conventions follow the bolt vitest skills:
 *   - vitest-utility-function-tests: two-level describe (module → behaviour),
 *     `test` (not `it`), behaviour-grouped tests with multiple expects per test,
 *     no oracle pattern.
 *   - vitest-default-dummy-data: `Default<Entity>` typed baseline annotated
 *     with `Required<T>` so missing fields fail compilation when the synthetic
 *     shape drifts.
 *   - vitest-faker-utilities: `create<Entity>(override?)` typed object builder.
 *   - File-local helpers (not extracted) — only one consumer, ~220 lines total.
 */
import { describe, expect, test } from 'vitest';
import { detectCompilerStatus } from './compilerAnalyzer';
import type { CompilerStatus } from './types';

// --- Internal constants (duplicated for self-containment; drift fails loudly) ---
const FUNCTION_COMPONENT = 0;
const SIMPLE_MEMO = 15;
const MEMO_CACHE_SENTINEL = Symbol.for('react.memo_cache_sentinel');

// --- Synthetic fiber shape + Default baseline (Required<T> enforces drift) ---

interface SyntheticHook {
  memoizedState: unknown;
  next: unknown;
}

interface SyntheticFiber {
  tag: number;
  memoizedState: SyntheticHook | null;
  alternate?: SyntheticFiber | null;
  type: unknown;
}

const DefaultSyntheticFiber: Required<SyntheticFiber> = {
  tag: FUNCTION_COMPONENT,
  memoizedState: null,
  alternate: null,
  type: function NoOp() {},
};

// --- create<Entity>(override?) typed builders ---

function createSyntheticFiber(overrides: Partial<SyntheticFiber> = {}): SyntheticFiber {
  return { ...DefaultSyntheticFiber, ...overrides };
}

function createFirstHook(memoized: unknown): SyntheticHook {
  return { memoizedState: memoized, next: null };
}

// ============================================================================
// Module-level describe (vitest-utility-function-tests two-level convention)
// ============================================================================

describe('compilerAnalyzer', () => {
  describe('detectCompilerStatus — tag-based early exits', () => {
    test("returns 'manual' for SimpleMemo (tag=15) regardless of memoizedState", () => {
      // SimpleMemo wins over compiler detection — the tag check runs first,
      // so even a populated compiler cache is still classified as manual.
      expect(detectCompilerStatus(createSyntheticFiber({ tag: SIMPLE_MEMO }))).toBe('manual');

      const withCache = createSyntheticFiber({
        tag: SIMPLE_MEMO,
        memoizedState: createFirstHook([MEMO_CACHE_SENTINEL, MEMO_CACHE_SENTINEL]),
      });
      expect(detectCompilerStatus(withCache)).toBe('manual');
    });

    test('returns undefined for any non-FunctionComponent / non-SimpleMemo tag', () => {
      // Spot-check a few common React internal tags
      for (const tag of [1, 3, 5, 6, 11, 14, 16, 22]) {
        expect(detectCompilerStatus(createSyntheticFiber({ tag }))).toBeUndefined();
      }
    });
  });

  describe("detectCompilerStatus — 'unoptimized' branches", () => {
    test('returns unoptimized when memoizedState is null, not-an-array, undefined, null, or empty', () => {
      // Behaviour-grouped: every shape that fails the `isArray && length>0` check
      // collapses to the unoptimized branch.
      expect(detectCompilerStatus(createSyntheticFiber({ memoizedState: null }))).toBe(
        'unoptimized',
      );
      expect(
        detectCompilerStatus(
          createSyntheticFiber({ memoizedState: createFirstHook({ some: 'object' }) }),
        ),
      ).toBe('unoptimized');
      expect(
        detectCompilerStatus(createSyntheticFiber({ memoizedState: createFirstHook(undefined) })),
      ).toBe('unoptimized');
      expect(
        detectCompilerStatus(createSyntheticFiber({ memoizedState: createFirstHook(null) })),
      ).toBe('unoptimized');
      expect(
        detectCompilerStatus(createSyntheticFiber({ memoizedState: createFirstHook([]) })),
      ).toBe('unoptimized');
    });

    test('returns unoptimized when array contains values but no sentinel (plain useState)', () => {
      const fiber = createSyntheticFiber({
        memoizedState: createFirstHook(['value', 42, { x: 1 }]),
      });
      expect(detectCompilerStatus(fiber)).toBe('unoptimized');
    });

    test('returns unoptimized for a similar but distinct symbol (Symbol.for identity required)', () => {
      // Symbol() creates a unique symbol that does NOT match Symbol.for('react.memo_cache_sentinel')
      const lookalike = Symbol('react.memo_cache_sentinel');
      const fiber = createSyntheticFiber({
        memoizedState: createFirstHook([lookalike, lookalike]),
      });
      expect(detectCompilerStatus(fiber)).toBe('unoptimized');
    });
  });

  describe("detectCompilerStatus — 'compiled' branch", () => {
    test('returns compiled when sentinels are mixed with cached values (any non-sentinel slot)', () => {
      // Grouped: any populated slot — string, falsy, or arbitrary value — qualifies.
      const mixedString = createSyntheticFiber({
        memoizedState: createFirstHook([MEMO_CACHE_SENTINEL, 'cached-value', MEMO_CACHE_SENTINEL]),
      });
      expect(detectCompilerStatus(mixedString)).toBe('compiled');

      // 0, false, null, '' all are NOT MEMO_CACHE_SENTINEL → cache has populated slots
      const mixedFalsy = createSyntheticFiber({
        memoizedState: createFirstHook([MEMO_CACHE_SENTINEL, 0, false, null, '']),
      });
      expect(detectCompilerStatus(mixedFalsy)).toBe('compiled');
    });

    test('returns compiled when alternate is null but cache has mixed slots (first-render partial cache)', () => {
      // Mixed cache + no alternate → compiled (de-opt requires both all-sentinel AND alternate)
      const fiber = createSyntheticFiber({
        alternate: null,
        memoizedState: createFirstHook([MEMO_CACHE_SENTINEL, 'x']),
      });
      expect(detectCompilerStatus(fiber)).toBe('compiled');
    });
  });

  describe("detectCompilerStatus — 'de-opted' branch", () => {
    test('returns de-opted when ALL slots are sentinel AND fiber.alternate exists', () => {
      const alternate = createSyntheticFiber({ memoizedState: null });
      const fiber = createSyntheticFiber({
        alternate,
        memoizedState: createFirstHook([
          MEMO_CACHE_SENTINEL,
          MEMO_CACHE_SENTINEL,
          MEMO_CACHE_SENTINEL,
        ]),
      });
      expect(detectCompilerStatus(fiber)).toBe('de-opted');
    });

    test('returns de-opted for single-slot all-sentinel cache with alternate', () => {
      const alternate = createSyntheticFiber({ memoizedState: null });
      const fiber = createSyntheticFiber({
        alternate,
        memoizedState: createFirstHook([MEMO_CACHE_SENTINEL]),
      });
      expect(detectCompilerStatus(fiber)).toBe('de-opted');
    });

    test('returns compiled (NOT de-opted) on first render when alternate is null or undefined', () => {
      // Behaviour-grouped: de-opt detection is suppressed on first render (no alternate)
      // to avoid false positives. Both null and undefined alternates take this branch.
      const nullAlternate = createSyntheticFiber({
        alternate: null,
        memoizedState: createFirstHook([MEMO_CACHE_SENTINEL, MEMO_CACHE_SENTINEL]),
      });
      expect(detectCompilerStatus(nullAlternate)).toBe('compiled');

      // alternate omitted entirely (undefined). `fiber.alternate != null` is false → 'compiled'.
      const undefinedAlternate: SyntheticFiber = {
        ...DefaultSyntheticFiber,
        memoizedState: createFirstHook([MEMO_CACHE_SENTINEL, MEMO_CACHE_SENTINEL]),
      };
      delete (undefinedAlternate as Partial<SyntheticFiber>).alternate;
      expect(detectCompilerStatus(undefinedAlternate)).toBe('compiled');
    });
  });

  describe('detectCompilerStatus — return type', () => {
    test('returns one of the four CompilerStatus values or undefined', () => {
      const valid: Array<CompilerStatus | undefined> = [
        'compiled',
        'manual',
        'unoptimized',
        'de-opted',
        undefined,
      ];
      const result = detectCompilerStatus(createSyntheticFiber());
      expect(valid).toContain(result);
    });
  });
});
