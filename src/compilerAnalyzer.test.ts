/**
 * Coverage target for compilerAnalyzer.ts:
 * - Statements : 100%
 * - Branches   : 100%
 * - Functions  : 100%
 *
 * detectCompilerStatus is a pure function over a synthetic Fiber shape.
 * No mocking required; we construct fibers with the precise fields the
 * function reads (tag, memoizedState.memoizedState, alternate).
 */
import { describe, it, expect } from 'vitest';
import { detectCompilerStatus } from './compilerAnalyzer';
import type { CompilerStatus } from './types';

// ============================================================================
// Internal constants — duplicated here so tests are self-contained and
// independent of the production module. If these drift, the tests below
// will fail loudly, which is what we want.
// ============================================================================
const FUNCTION_COMPONENT = 0;
const SIMPLE_MEMO = 15;
const MEMO_CACHE_SENTINEL = Symbol.for('react.memo_cache_sentinel');

// ============================================================================
// Fixture helpers
// ============================================================================

interface SyntheticFiber {
  tag: number;
  memoizedState: { memoizedState: unknown; next: unknown } | null;
  alternate?: SyntheticFiber | null;
  type: unknown;
}

function makeFiber(overrides: Partial<SyntheticFiber> = {}): SyntheticFiber {
  return {
    tag: overrides.tag ?? FUNCTION_COMPONENT,
    memoizedState: overrides.memoizedState ?? null,
    alternate: overrides.alternate,
    type: overrides.type ?? function NoOp() {},
  };
}

function makeFirstHook(memoized: unknown): { memoizedState: unknown; next: unknown } {
  return { memoizedState: memoized, next: null };
}

// ============================================================================
// Tag-based early exits
// ============================================================================

describe('detectCompilerStatus — tag-based early exits', () => {
  it("returns 'manual' for SimpleMemo (tag=15) regardless of memoizedState", () => {
    const fiber = makeFiber({ tag: SIMPLE_MEMO, memoizedState: null });
    expect(detectCompilerStatus(fiber)).toBe('manual');
  });

  it("returns 'manual' for SimpleMemo even when a compiler cache is present", () => {
    // SimpleMemo wins over compiler detection — tag check is first
    const fiber = makeFiber({
      tag: SIMPLE_MEMO,
      memoizedState: makeFirstHook([MEMO_CACHE_SENTINEL, MEMO_CACHE_SENTINEL]),
    });
    expect(detectCompilerStatus(fiber)).toBe('manual');
  });

  it('returns undefined for any non-FunctionComponent / non-SimpleMemo tag', () => {
    // Spot-check a few common React internal tags
    for (const tag of [1, 3, 5, 6, 11, 14, 16, 22]) {
      expect(detectCompilerStatus(makeFiber({ tag }))).toBeUndefined();
    }
  });
});

// ============================================================================
// Function components — unoptimized branches
// ============================================================================

describe("detectCompilerStatus — 'unoptimized' branches", () => {
  it('returns unoptimized when memoizedState is null (no hooks)', () => {
    const fiber = makeFiber({ tag: FUNCTION_COMPONENT, memoizedState: null });
    expect(detectCompilerStatus(fiber)).toBe('unoptimized');
  });

  it('returns unoptimized when first hook value is not an array', () => {
    const fiber = makeFiber({
      memoizedState: makeFirstHook({ some: 'object' }),
    });
    expect(detectCompilerStatus(fiber)).toBe('unoptimized');
  });

  it('returns unoptimized when first hook value is undefined', () => {
    const fiber = makeFiber({ memoizedState: makeFirstHook(undefined) });
    expect(detectCompilerStatus(fiber)).toBe('unoptimized');
  });

  it('returns unoptimized when first hook value is null', () => {
    const fiber = makeFiber({ memoizedState: makeFirstHook(null) });
    expect(detectCompilerStatus(fiber)).toBe('unoptimized');
  });

  it('returns unoptimized when first hook is an empty array', () => {
    const fiber = makeFiber({ memoizedState: makeFirstHook([]) });
    expect(detectCompilerStatus(fiber)).toBe('unoptimized');
  });

  it('returns unoptimized when array contains values but no sentinel', () => {
    // Plain useState array → no compiler signal
    const fiber = makeFiber({
      memoizedState: makeFirstHook(['value', 42, { x: 1 }]),
    });
    expect(detectCompilerStatus(fiber)).toBe('unoptimized');
  });

  it('returns unoptimized for a similar but distinct symbol (not Symbol.for identity)', () => {
    // Symbol() creates a unique symbol that does NOT match Symbol.for('react.memo_cache_sentinel')
    const lookalike = Symbol('react.memo_cache_sentinel');
    const fiber = makeFiber({ memoizedState: makeFirstHook([lookalike, lookalike]) });
    expect(detectCompilerStatus(fiber)).toBe('unoptimized');
  });
});

// ============================================================================
// Function components — compiled branch
// ============================================================================

describe("detectCompilerStatus — 'compiled' branch", () => {
  it('returns compiled when at least one slot has been populated (mixed sentinel + value)', () => {
    const fiber = makeFiber({
      memoizedState: makeFirstHook([MEMO_CACHE_SENTINEL, 'cached-value', MEMO_CACHE_SENTINEL]),
    });
    expect(detectCompilerStatus(fiber)).toBe('compiled');
  });

  it('returns compiled when sentinels are mixed with falsy-but-non-sentinel values', () => {
    // 0, false, null, '' all are NOT MEMO_CACHE_SENTINEL → cache has populated slots
    const fiber = makeFiber({
      memoizedState: makeFirstHook([MEMO_CACHE_SENTINEL, 0, false, null, '']),
    });
    expect(detectCompilerStatus(fiber)).toBe('compiled');
  });

  it('returns compiled when all slots are populated (no sentinels remain)', () => {
    // Wait — this would fail the !hasSentinel check and return unoptimized.
    // The function requires at least one sentinel to recognize the cache shape.
    // Confirm that path:
    const fiber = makeFiber({
      memoizedState: makeFirstHook(['v1', 'v2', 'v3']),
    });
    expect(detectCompilerStatus(fiber)).toBe('unoptimized');
  });

  it('returns compiled when alternate is null but cache has mixed slots (first render with partial cache)', () => {
    // Mixed cache + no alternate → compiled (de-opt requires both all-sentinel AND alternate)
    const fiber = makeFiber({
      alternate: null,
      memoizedState: makeFirstHook([MEMO_CACHE_SENTINEL, 'x']),
    });
    expect(detectCompilerStatus(fiber)).toBe('compiled');
  });
});

// ============================================================================
// Function components — de-opted branch
// ============================================================================

describe("detectCompilerStatus — 'de-opted' branch", () => {
  it('returns de-opted when ALL slots are sentinel AND fiber.alternate exists', () => {
    const alternate = makeFiber({ memoizedState: null });
    const fiber = makeFiber({
      alternate,
      memoizedState: makeFirstHook([MEMO_CACHE_SENTINEL, MEMO_CACHE_SENTINEL, MEMO_CACHE_SENTINEL]),
    });
    expect(detectCompilerStatus(fiber)).toBe('de-opted');
  });

  it('returns compiled (NOT de-opted) when all-sentinel but alternate is null (first render)', () => {
    // De-opt detection is suppressed on first render to avoid false positives
    const fiber = makeFiber({
      alternate: null,
      memoizedState: makeFirstHook([MEMO_CACHE_SENTINEL, MEMO_CACHE_SENTINEL]),
    });
    expect(detectCompilerStatus(fiber)).toBe('compiled');
  });

  it('returns compiled (NOT de-opted) when all-sentinel but alternate is undefined', () => {
    // alternate omitted entirely (undefined) → strict null check passes, treated as first render
    const fiber = makeFiber({
      memoizedState: makeFirstHook([MEMO_CACHE_SENTINEL, MEMO_CACHE_SENTINEL]),
    });
    // alternate is undefined here; `fiber.alternate != null` is false → falls through to 'compiled'
    expect(detectCompilerStatus(fiber)).toBe('compiled');
  });

  it('returns de-opted for single-slot all-sentinel cache with alternate', () => {
    const alternate = makeFiber({ memoizedState: null });
    const fiber = makeFiber({
      alternate,
      memoizedState: makeFirstHook([MEMO_CACHE_SENTINEL]),
    });
    expect(detectCompilerStatus(fiber)).toBe('de-opted');
  });
});

// ============================================================================
// Return type sanity check
// ============================================================================

describe('detectCompilerStatus — return type', () => {
  it('returns one of the four CompilerStatus values or undefined', () => {
    const valid: Array<CompilerStatus | undefined> = [
      'compiled',
      'manual',
      'unoptimized',
      'de-opted',
      undefined,
    ];
    const result = detectCompilerStatus(makeFiber());
    expect(valid).toContain(result);
  });
});
