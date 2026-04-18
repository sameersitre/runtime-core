/**
 * Next.js App Router client-side detection.
 * - Emits runtime:nextjsContext on startup when Next.js is detected
 * - Provides per-fiber heuristics for isServerComponent / isClientBoundary
 *
 * All detection is heuristic and best-effort. Server Components themselves
 * don't create client-side fibers, so detection is approximate.
 */
import type { FloTraceWebSocketClient } from "./websocketClient";

/** File path patterns that suggest a Next.js Server Component */
const SERVER_COMPONENT_PATTERNS: RegExp[] = [
  /\.server\.[jt]sx?$/,     // explicit .server.tsx convention
  /[\\/]app[\\/].+[\\/]page\.[jt]sx?$/,    // Next.js app router page
  /[\\/]app[\\/].+[\\/]layout\.[jt]sx?$/,  // Next.js app router layout
  /[\\/]app[\\/].+[\\/]loading\.[jt]sx?$/, // Next.js loading UI
  /[\\/]app[\\/].+[\\/]error\.[jt]sx?$/,   // Next.js error UI
];

/** Display name patterns for Next.js-generated server reference wrappers */
const SERVER_REFERENCE_PATTERNS: RegExp[] = [
  /_ServerReference$/,
  /^RSC_/,
];

interface Fiber {
  _debugSource?: { fileName: string; lineNumber: number } | null;
  type: unknown;
}

type FiberType = {
  name?: string;
  displayName?: string;
};

let detectionEmitted = false;

/**
 * Detect Next.js presence from window globals and emit runtime:nextjsContext once.
 * Safe to call repeatedly — emits at most once per page load.
 */
export function maybeEmitNextjsContext(client: FloTraceWebSocketClient): void {
  if (detectionEmitted) return;

  try {
    const win = globalThis as Record<string, unknown>;
    const hasNextData = '__NEXT_DATA__' in win;
    const hasNextRouter = '__next_router_state_tree__' in win;
    const hasNext = 'next' in win && win.next !== null;

    if (!hasNextData && !hasNextRouter && !hasNext) return;

    detectionEmitted = true;

    // Attempt to extract version from __NEXT_DATA__
    let version: string | undefined;
    let isAppRouter = false;
    let initialRoute: string | undefined;

    try {
      const nextData = win.__NEXT_DATA__ as Record<string, unknown> | undefined;
      if (nextData) {
        version = typeof nextData.buildId === 'string' ? nextData.buildId : undefined;
        initialRoute = typeof nextData.page === 'string' ? nextData.page : undefined;
      }
      // App Router presence: __next_router_state_tree__ exists
      isAppRouter = hasNextRouter || !!win.__next_router_state_tree__;
    } catch {
      // Non-fatal
    }

    client.sendImmediate({
      type: 'runtime:nextjsContext',
      detected: true,
      version,
      isAppRouter,
      initialRoute,
      timestamp: Date.now(),
    });
  } catch {
    // Non-fatal — Next.js detection is best-effort
  }
}

/**
 * Heuristic: is this fiber likely a Next.js Server Component?
 * Uses _debugSource file path and display name patterns.
 * Approximate — Server Components don't exist as client fibers, but framework
 * wrappers/references that represent them do.
 */
export function detectServerComponent(fiber: Fiber): boolean {
  // Check display name for server reference wrapper pattern
  const type = fiber.type as FiberType | null;
  if (type) {
    const name = type.displayName || type.name || '';
    if (SERVER_REFERENCE_PATTERNS.some(p => p.test(name))) return true;
  }

  // Check source file path for explicit .server.* naming
  const fileName = fiber._debugSource?.fileName;
  if (fileName) {
    if (SERVER_COMPONENT_PATTERNS.some(p => p.test(fileName))) return true;
  }

  return false;
}

/** Reset detection state (useful for tests / hot-reload) */
export function resetNextjsDetection(): void {
  detectionEmitted = false;
}
