/**
 * Platform-agnostic request/response detail helpers shared by the web
 * (`@flotrace/runtime`) and native (`@flotrace/runtime-native`) network trackers.
 *
 * These are pure transforms — query-string parsing, header normalization, and
 * request/response body serialization. The platform-specific *reading* of bodies
 * (fetch `Response.clone().text()` on web, `XMLHttpRequest.responseText` on both)
 * stays in each tracker; only the shape-agnostic conversion lives here so the two
 * trackers can't drift.
 *
 * Param types for the header/body helpers are intentionally `unknown` (runtime
 * type-branching) so the emitted `.d.ts` doesn't reference DOM lib types — the
 * native package's tsconfig excludes `lib: ["DOM"]` and would otherwise fail to
 * resolve `BodyInit` / `HeadersInit` in this module's declaration file.
 */

import { serializeValue } from './serializer';
import type { SerializedValue } from './types';

/** Parse the query string of a URL into a flat record (repeated keys are comma-joined). */
export function parseQueryParams(url: string): Record<string, string> | undefined {
  let search: URLSearchParams;
  try {
    // `globalThis.location` is absent on React Native — fall back to a bare base.
    const base =
      (globalThis as { location?: { href?: string } }).location?.href ?? 'http://localhost';
    search = new URL(url, base).searchParams;
  } catch {
    const qIdx = url.indexOf('?');
    if (qIdx === -1) return undefined;
    search = new URLSearchParams(url.slice(qIdx + 1));
  }
  const out: Record<string, string> = {};
  for (const [key, value] of search) {
    out[key] = key in out ? `${out[key]}, ${value}` : value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalize any headers representation to a flat record. Handles `Headers`
 * instances, header-like objects with a `forEach` (RN's fetch Headers), `[k,v][]`
 * tuple arrays, and plain objects.
 */
export function headersToRecord(headers: unknown): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers as [string, string][]) out[key] = String(value);
  } else if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    // Header-like object (e.g. RN's whatwg Headers when not `instanceof Headers`).
    (headers as { forEach: (cb: (value: string, key: string) => void) => void }).forEach(
      (value, key) => {
        out[key] = value;
      },
    );
  } else if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      out[key] = String(value);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse a raw "Name: value\r\n" header block (XHR getAllResponseHeaders) into a record. */
export function parseRawHeaders(raw: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of raw.trim().split(/[\r\n]+/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Serialize a request body (string/JSON, URLSearchParams, FormData, or binary) for transport. */
export function serializeRequestBody(body: unknown): SerializedValue | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') {
    return serializeValue(tryParseJson(body));
  }
  if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
    return serializeValue(Object.fromEntries(body));
  }
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const obj: Record<string, unknown> = {};
    body.forEach((value, key) => {
      // `File` is undefined on React Native — guard before `instanceof` so it can't throw.
      obj[key] =
        typeof File !== 'undefined' && value instanceof File
          ? `[File ${value.name} ${value.size} bytes]`
          : value;
    });
    return serializeValue(obj);
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return `[Blob ${body.size} bytes${body.type ? `, type=${body.type}` : ''}]`;
  }
  if (body instanceof ArrayBuffer) {
    return `[ArrayBuffer ${body.byteLength} bytes]`;
  }
  if (ArrayBuffer.isView(body)) {
    return `[${body.constructor.name} ${body.byteLength} bytes]`;
  }
  return '[binary body]';
}

/** Serialize a response body string — parsed as JSON when it looks like JSON, else raw text. */
export function serializeResponseText(text: string, contentType: string | null): SerializedValue {
  const looksJson = contentType?.includes('json') || /^\s*[[{]/.test(text);
  return serializeValue(looksJson ? tryParseJson(text) : text);
}

/** Parse JSON, falling back to the original string when it isn't valid JSON. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * True for content types whose body is a (potentially infinite) stream we must NOT
 * buffer: `text/event-stream` (SSE — read via fetch + ReadableStream; `.text()` would
 * never resolve and would pin the clone forever).
 */
export function isStreamingContentType(contentType: string | null | undefined): boolean {
  return !!contentType && /text\/event-stream/i.test(contentType);
}
