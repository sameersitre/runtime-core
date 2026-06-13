import React from 'react';
import type {
  RuntimeMessage,
  ExtensionToRuntimeMessage,
  FloTraceConfig,
  ResolvedFloTraceConfig,
} from './types';
import { DEFAULT_CONFIG } from './types';
import { isJsxRuntimeActive } from './jsxRuntimeUtils';

type MessageHandler = (message: ExtensionToRuntimeMessage) => void;
type ConnectionHandler = (connected: boolean) => void;

/**
 * WebSocket client for connecting to FloTrace VS Code extension.
 * Handles connection, reconnection, and message batching.
 */
export class FloTraceWebSocketClient {
  private ws: WebSocket | null = null;
  private config: ResolvedFloTraceConfig;
  private messageQueue: RuntimeMessage[] = [];
  private flushTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private isConnecting = false;
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  private static readonly MAX_RECONNECT_INTERVAL = 30_000; // 30s cap
  private static readonly BATCH_FLUSH_MS = 100; // Flush batched messages every 100ms
  private static readonly MAX_QUEUE_SIZE = 500; // Prevent unbounded queue growth when disconnected
  private messageHandlers: Set<MessageHandler> = new Set();
  private connectionHandlers: Set<ConnectionHandler> = new Set();

  constructor(config: FloTraceConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Connect to the FloTrace WebSocket server
   */
  connect(): void {
    if (this.ws || this.isConnecting) {
      return;
    }

    if (!this.config.enabled) {
      console.log('[FloTrace] Runtime disabled, skipping connection');
      return;
    }

    // Require a WebSocket implementation — present in browsers and in React Native runtimes.
    // (The native adapter relies on RN's built-in global WebSocket; no DOM is needed.)
    if (typeof WebSocket === 'undefined') {
      console.log('[FloTrace] WebSocket not available, skipping connection');
      return;
    }

    this.isConnecting = true;

    try {
      const host = this.config.host ?? '127.0.0.1';
      // LAN auth token rides in the query string — WebSocket browser API can't set custom
      // request headers, and RN's fetch-polyfilled WebSocket is inconsistent about them too.
      // The desktop server accepts either `?token=` or the `Sec-WebSocket-Protocol` header.
      const tokenParam = this.config.authToken
        ? `?token=${encodeURIComponent(this.config.authToken)}`
        : '';
      const url = `ws://${host}:${this.config.port}${tokenParam}`;
      console.log(`[FloTrace] Connecting to ${url.replace(/token=[^&]+/, 'token=***')}...`);

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0; // Reset budget on successful connection
        console.log('[FloTrace] Connected to VS Code extension');
        this.notifyConnectionChange(true);

        // Send ready message
        this.send({
          type: 'runtime:ready',
          appName: this.config.appName,
          reactVersion: this.getReactVersion(),
          appUrl: this.config.getAppUrl?.(),
          platform: this.config.platform,
          appId: this.config.appId,
          appVersion: this.config.appVersion,
          frameworkName: this.config.frameworkName,
          frameworkVersion: this.config.frameworkVersion,
          reactNativeVersion: this.config.reactNativeVersion,
          runtimeVersion: this.config.runtimeVersion,
          // P5: JSX runtime adoption signal — read at WS-open time so
          // multiple fibers have already rendered by the moment we report.
          // `isJsxRuntimeActive` reads `globalThis[Symbol.for('flotrace.jsx-runtime-active')]`,
          // which the dev jsx-runtime sets on first jsxDEV call.
          jsxRuntimeActive: isJsxRuntimeActive(),
        });

        // Flush any queued messages
        this.flush();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as ExtensionToRuntimeMessage;
          this.handleMessage(message);
        } catch (error) {
          console.error('[FloTrace] Failed to parse message:', error);
        }
      };

      this.ws.onclose = () => {
        this.isConnecting = false;
        this.ws = null;
        console.log('[FloTrace] Disconnected from VS Code extension');
        this.notifyConnectionChange(false);

        // Attempt to reconnect
        if (this.config.autoReconnect) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.isConnecting = false;
        // The WebSocket `error` event is opaque by spec (no actionable detail) and is
        // always immediately followed by `onclose`, which logs the disconnect + schedules
        // a reconnect. Demote to `console.warn` (was `console.error`) so React Native's
        // LogBox doesn't raise a full-screen red overlay for this expected, self-healing
        // condition (desktop app not running / mid-reconnect). The previous
        // `console.error('...', error)` also dumped an unhelpful `{"_type":"error",...}`
        // serialization of the event. The message is kept stable (host:port only) so
        // LogBox collapses repeated reconnect attempts into a single dismissible notice.
        console.warn(
          `[FloTrace] Could not reach the desktop app at ${host}:${this.config.port} — is FloTrace running?`,
        );
      };
    } catch (error) {
      this.isConnecting = false;
      console.error('[FloTrace] Failed to connect:', error);

      if (this.config.autoReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    if (this.ws) {
      try {
        this.send({ type: 'runtime:disconnect', reason: 'Client disconnect' });
      } catch (error) {
        console.error('[FloTrace] Error sending disconnect message:', error);
      }
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Send a message to the extension (queued and batched)
   */
  send(message: RuntimeMessage): void {
    if (!this.config.enabled) {
      return;
    }

    this.messageQueue.push(message);

    // Cap queue size to prevent unbounded growth when disconnected
    if (this.messageQueue.length > FloTraceWebSocketClient.MAX_QUEUE_SIZE) {
      this.messageQueue = this.messageQueue.slice(-FloTraceWebSocketClient.MAX_QUEUE_SIZE);
    }

    // Schedule flush with dedicated batch interval (NOT reconnectInterval)
    if (!this.flushTimeout) {
      this.flushTimeout = setTimeout(() => {
        this.flush();
      }, FloTraceWebSocketClient.BATCH_FLUSH_MS);
    }

    // Immediate flush if queue is full
    if (this.messageQueue.length >= (this.config.trackAllRenders ? 50 : 10)) {
      this.flush();
    }
  }

  /**
   * Send a message immediately (not batched)
   */
  sendImmediate(message: RuntimeMessage): void {
    if (!this.config.enabled || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error('[FloTrace] Failed to send message:', error);
    }
  }

  /**
   * Flush the message queue
   */
  private flush(): void {
    if (this.flushTimeout) {
      clearTimeout(this.flushTimeout);
      this.flushTimeout = null;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.messageQueue.length === 0) {
      return;
    }

    try {
      // Send messages individually (extension expects individual messages)
      for (const message of this.messageQueue) {
        this.ws.send(JSON.stringify(message));
      }
      this.messageQueue = [];
    } catch (error) {
      console.error('[FloTrace] Failed to flush messages:', error);
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      return;
    }

    // Budget: stop trying after MAX_RECONNECT_ATTEMPTS to avoid infinite retries
    if (this.reconnectAttempts >= FloTraceWebSocketClient.MAX_RECONNECT_ATTEMPTS) {
      console.warn(
        `[FloTrace] Reconnection budget exhausted (${FloTraceWebSocketClient.MAX_RECONNECT_ATTEMPTS} attempts). ` +
          'Reload the page or restart the extension to retry.',
      );
      return;
    }

    // Exponential backoff: 2s → 4s → 8s → ... capped at 30s
    const baseDelay = this.config.reconnectInterval || 2000;
    const delay = Math.min(
      baseDelay * Math.pow(2, this.reconnectAttempts),
      FloTraceWebSocketClient.MAX_RECONNECT_INTERVAL,
    );
    this.reconnectAttempts++;

    console.log(
      `[FloTrace] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${FloTraceWebSocketClient.MAX_RECONNECT_ATTEMPTS})`,
    );

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, delay);
  }

  /**
   * Handle incoming message from extension
   */
  private handleMessage(message: ExtensionToRuntimeMessage): void {
    // Respond to server heartbeat before fan-out so app-level handlers don't
    // have to know about it. Uses sendImmediate so the pong isn't delayed by
    // the 100ms batch-flush window — crash detection relies on round-trip
    // latency being tight.
    if (message.type === 'ext:ping') {
      this.sendImmediate({ type: 'runtime:pong', timestamp: Date.now() });
      return;
    }

    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch (error) {
        console.error('[FloTrace] Message handler error:', error);
      }
    }
  }

  /**
   * Notify connection state change
   */
  private notifyConnectionChange(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(connected);
      } catch (error) {
        console.error('[FloTrace] Connection handler error:', error);
      }
    }
  }

  /**
   * Add a message handler
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  /**
   * Add a connection state handler
   */
  onConnectionChange(handler: ConnectionHandler): () => void {
    this.connectionHandlers.add(handler);
    return () => this.connectionHandlers.delete(handler);
  }

  /**
   * Check if connected
   */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get React version if available.
   *
   * Historical note: an earlier implementation read `globalThis.React?.version` —
   * but React is an ES-module import in modern bundles (Vite/webpack/Next.js) and
   * is never placed on `globalThis`, so the probe returned undefined for every
   * typical bundled app. Reading `React.version` via a direct import is
   * authoritative across web (both CJS and ESM bundles), React Native, and SSR.
   */
  private getReactVersion(): string | undefined {
    try {
      return (React as unknown as { version?: string }).version;
    } catch {
      return undefined;
    }
  }
}

// Singleton instance
let clientInstance: FloTraceWebSocketClient | null = null;

/**
 * Get or create the singleton WebSocket client
 */
export function getWebSocketClient(config?: FloTraceConfig): FloTraceWebSocketClient {
  if (!clientInstance) {
    clientInstance = new FloTraceWebSocketClient(config);
  }
  return clientInstance;
}

/**
 * Dispose the singleton client
 */
export function disposeWebSocketClient(): void {
  if (clientInstance) {
    clientInstance.disconnect();
    clientInstance = null;
  }
}
