/**
 * Unit tests for timeOrigin.ts — the single clock every wire timestamp uses.
 */
import { describe, expect, test } from 'vitest';
import { __getTimeOriginForTesting, nowEpochMs } from './timeOrigin';

describe('timeOrigin', () => {
  describe('nowEpochMs', () => {
    test('returns a value comparable to Date.now()', () => {
      const before = Date.now();
      const value = nowEpochMs();
      const after = Date.now();

      // Allow 1ms of slack in each direction for sub-ms rounding.
      expect(value).toBeGreaterThanOrEqual(before - 1);
      expect(value).toBeLessThanOrEqual(after + 1);
    });

    test('is monotonic across successive calls', () => {
      const samples = Array.from({ length: 50 }, () => nowEpochMs());
      for (let i = 1; i < samples.length; i++) {
        expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
      }
    });

    test('keeps sub-millisecond resolution rather than rounding to Date.now()', () => {
      // performance.now() is fractional; the offset must not truncate it.
      const samples = Array.from({ length: 200 }, () => nowEpochMs());
      expect(samples.some((s) => !Number.isInteger(s))).toBe(true);
    });

    test('sits in the epoch-millisecond range, not the since-page-load range', () => {
      // The bug this file fixes: performance.now() values are small (< 1e12),
      // so the desktop could not tell them apart from a real epoch timestamp
      // without a heuristic. Assert we are unambiguously in epoch territory.
      expect(nowEpochMs()).toBeGreaterThan(1e12);
    });

    test('derives from a stable origin captured once at module init', () => {
      const origin = __getTimeOriginForTesting();
      expect(__getTimeOriginForTesting()).toBe(origin);
      expect(Math.abs(nowEpochMs() - (origin + performance.now()))).toBeLessThan(2);
    });
  });
});
