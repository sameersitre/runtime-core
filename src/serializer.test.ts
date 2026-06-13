import { describe, expect, test } from 'vitest';
import { serializeProps, serializeValue } from './serializer';
import { FLOTRACE_SRC_ATTR } from './jsxRuntimeUtils';

const MAX_STRING_LENGTH = 10000;

describe('serializer', () => {
  describe('serializeValue — strings', () => {
    test('sends normal-length strings through in full (no truncation)', () => {
      // A 635-char bio used to be chopped to a contentless marker by the old 500 cap.
      const bio = 'x'.repeat(635);
      expect(serializeValue(bio)).toBe(bio);
    });

    test('sends a string exactly at the cap in full', () => {
      const atCap = 'a'.repeat(MAX_STRING_LENGTH);
      expect(serializeValue(atCap)).toBe(atCap);
    });

    test('truncates only beyond the cap, and includes a content preview + full length', () => {
      const huge = 'z'.repeat(MAX_STRING_LENGTH + 500);
      const result = serializeValue(huge);

      expect(result).toEqual({
        __type: 'truncated',
        originalType: 'string',
        length: MAX_STRING_LENGTH + 500,
        preview: 'z'.repeat(MAX_STRING_LENGTH),
      });
      // The preview carries real content — never an empty marker.
      expect((result as { preview: string }).preview.length).toBe(MAX_STRING_LENGTH);
    });
  });


  describe('serializeProps', () => {
    test('serializes ordinary user props through to the wire', () => {
      const result = serializeProps({ title: 'hello', count: 3, active: true });

      expect(result).toEqual({ title: 'hello', count: 3, active: true });
    });

    test('strips React internals (children / key / ref) and __-prefixed props', () => {
      const result = serializeProps({
        title: 'hello',
        children: 'should be dropped',
        key: 'k1',
        ref: {},
        __internal: 'nope',
      });

      expect(result).toEqual({ title: 'hello' });
    });

    test('never leaks the FloTrace babel-plugin source-attribution attribute', () => {
      const result = serializeProps({
        onPress: () => {},
        [FLOTRACE_SRC_ATTR]: '{"f":"/Users/me/app/src/components/RowCard.tsx","l":51,"c":4}',
      });

      expect(result).not.toHaveProperty(FLOTRACE_SRC_ATTR);
      expect(result).not.toHaveProperty('data-flotrace-src');
      expect(Object.keys(result)).toEqual(['onPress']);
    });
  });
});
