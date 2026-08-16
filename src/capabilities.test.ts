/**
 * Unit tests for capabilities.ts — what this runtime declares it can produce.
 *
 * The load-bearing property is that the set is read at SEND time, not captured
 * at import: `runtime:ready` is re-sent on every reconnect, and trackers come
 * and go between them (HMR, a consumer toggling a panel off).
 */
import { beforeEach, describe, expect, test } from 'vitest';
import {
  __resetCapabilitiesForTesting,
  getCapabilities,
  registerCapability,
  unregisterCapability,
} from './capabilities';

describe('capabilities', () => {
  beforeEach(() => {
    __resetCapabilitiesForTesting();
  });

  describe('getCapabilities', () => {
    test('starts empty and reflects registrations', () => {
      expect(getCapabilities()).toEqual([]);

      registerCapability('errorCapture');
      registerCapability('routeTracking');

      expect(getCapabilities()).toEqual(['errorCapture', 'routeTracking']);
    });

    test('is sorted and deduplicated, so the ready frame is byte-stable', () => {
      // An unstable frame would look like a changed payload to anything
      // diffing it, and re-registration happens on every reconnect.
      registerCapability('routeTracking');
      registerCapability('errorCapture');
      registerCapability('routeTracking');

      expect(getCapabilities()).toEqual(['errorCapture', 'routeTracking']);
    });

    test('drops a capability when its tracker uninstalls', () => {
      registerCapability('errorCapture');
      registerCapability('networkCapture');
      unregisterCapability('errorCapture');

      expect(getCapabilities()).toEqual(['networkCapture']);
    });

    test('unregistering something never registered is a no-op', () => {
      unregisterCapability('interactionTiming');
      expect(getCapabilities()).toEqual([]);
    });
  });
});
