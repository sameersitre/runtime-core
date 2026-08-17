// @vitest-environment jsdom
/**
 * Fast Refresh detection — the guard that stops hot-reload re-renders being
 * reported as avoidable cascades.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  installHmrDetector,
  uninstallHmrDetector,
  isHmrInduced,
  markHmrActivity,
  __resetHmrStateForTesting,
} from './hmrDetector';

describe('hmrDetector', () => {
  // The detector patches `window`; jsdom supplies one (see the pragma above).
  const win = window as unknown as Record<string, unknown>;

  beforeEach(() => {
    __resetHmrStateForTesting();
    delete win.webpackHotUpdate_N_E;
    delete win.$RefreshHelpers$;
  });
  afterEach(() => {
    uninstallHmrDetector();
    __resetHmrStateForTesting();
    delete win.webpackHotUpdate_N_E;
    delete win.$RefreshHelpers$;
  });

  describe('isHmrInduced', () => {
    test('is false before any hot update — a fresh session is not suspect', () => {
      expect(isHmrInduced(1_000_000)).toBe(false);
    });

    test.each([
      { label: 'the same instant', offset: 0, expected: true },
      { label: 'just inside the window', offset: 1999, expected: true },
      { label: 'exactly at the window edge', offset: 2000, expected: false },
      { label: 'well after', offset: 10_000, expected: false },
    ])('a commit $label is $expected', ({ offset, expected }) => {
      markHmrActivity(1_000_000);
      expect(isHmrInduced(1_000_000 + offset)).toBe(expected);
    });

    test('ignores commits BEFORE the update — they cannot have been caused by it', () => {
      markHmrActivity(1_000_000);
      expect(isHmrInduced(999_000)).toBe(false);
    });

    test('a window covers the several commits one hot update produces', () => {
      // React remounts the refresh boundary across more than one commit; only
      // the first is adjacent to the hook call, which is why this is a window
      // rather than a single-commit flag.
      markHmrActivity(1_000_000);
      for (const t of [1_000_010, 1_000_120, 1_000_800]) {
        expect(isHmrInduced(t)).toBe(true);
      }
    });
  });

  describe('installHmrDetector', () => {
    test('marks activity when webpack runs a hot update, and still calls through', () => {
      const inner = vi.fn(() => 'result');
      win.webpackHotUpdate_N_E = inner;
      installHmrDetector();

      const out = (win.webpackHotUpdate_N_E as () => unknown)();

      expect(out).toBe('result');
      expect(inner).toHaveBeenCalledTimes(1);
      expect(isHmrInduced(Date.now())).toBe(true);
    });

    test('marks activity from react-refresh scheduleUpdate', () => {
      const inner = vi.fn();
      win.$RefreshHelpers$ = { scheduleUpdate: inner };
      installHmrDetector();

      (win.$RefreshHelpers$ as { scheduleUpdate: () => void }).scheduleUpdate();

      expect(inner).toHaveBeenCalledTimes(1);
      expect(isHmrInduced(Date.now())).toBe(true);
    });

    test('patches any webpackHotUpdate* global — the suffix is build-specific', () => {
      // Next.js emits `webpackHotUpdate_N_E`; other configs differ.
      const inner = vi.fn();
      win.webpackHotUpdate_my_app = inner;
      installHmrDetector();
      (win.webpackHotUpdate_my_app as () => void)();
      expect(isHmrInduced(Date.now())).toBe(true);
      delete win.webpackHotUpdate_my_app;
    });

    test.each([
      { label: 'no HMR globals at all (production build)', setup: () => {} },
      {
        label: 'a non-function where a hook would be',
        setup: () => {
          win.webpackHotUpdate_N_E = 'not-a-function';
        },
      },
    ])('is a no-op with $label', ({ setup }) => {
      setup();
      expect(() => installHmrDetector()).not.toThrow();
      expect(isHmrInduced(Date.now())).toBe(false);
    });
  });

  describe('uninstallHmrDetector', () => {
    test('restores the original hook', () => {
      const inner = vi.fn();
      win.webpackHotUpdate_N_E = inner;
      installHmrDetector();
      expect(win.webpackHotUpdate_N_E).not.toBe(inner);

      uninstallHmrDetector();
      expect(win.webpackHotUpdate_N_E).toBe(inner);
    });

    test('leaves a later patch alone rather than clobbering it', () => {
      // Same sentinel discipline the fetch patches use: only restore when OUR
      // wrapper is still the installed value.
      const inner = vi.fn();
      win.webpackHotUpdate_N_E = inner;
      installHmrDetector();
      const somebodyElse = vi.fn();
      win.webpackHotUpdate_N_E = somebodyElse;

      uninstallHmrDetector();

      expect(win.webpackHotUpdate_N_E).toBe(somebodyElse);
    });
  });
});
