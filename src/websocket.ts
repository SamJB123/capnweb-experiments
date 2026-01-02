// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

/// <reference types="@cloudflare/workers-types" />

import { RpcStub } from "./core.js";
import { RpcTransport, RpcSession, RpcSessionOptions } from "./rpc.js";
import type { RpcTraceEvent } from "./rpc.js";
import type {
  HibernatableSessionStore,
  HibernatableWebSocketAttachment,
  RpcSessionSnapshot,
} from "./hibernation.js";
import type { RpcSessionDebugState } from "./rpc.js";

export function newWebSocketRpcSession(
    webSocket: WebSocket | string, localMain?: any, options?: RpcSessionOptions): RpcStub {
  if (typeof webSocket === "string") {
    webSocket = new WebSocket(webSocket);
  }

  let transport = new WebSocketTransport(webSocket);
  let rpc = new RpcSession(transport, localMain, options);
  return rpc.getRemoteMain();
}

/**
 * For use in Cloudflare Workers: Construct an HTTP response that starts a WebSocket RPC session
 * with the given `localMain`.
 */
export function newWorkersWebSocketRpcResponse(
    request: Request, localMain?: any, options?: RpcSessionOptions): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This endpoint only accepts WebSocket requests.", { status: 400 });
  }

  let pair = new WebSocketPair();
  let server = pair[0];
  server.accept()
  newWebSocketRpcSession(server, localMain, options);
  return new Response(null, {
    status: 101,
    webSocket: pair[1],
  });
}

export type HibernatableWebSocketOptions = RpcSessionOptions & {
  /** Optional session store for persisting snapshots to durable storage as a
   *  backup. The primary persistence mechanism is the WebSocket attachment. */
  sessionStore?: HibernatableSessionStore;
  sessionId?: string;
  __experimental_trace?: (event: RpcTraceEvent | HibernatableTransportTraceEvent) => void;
};

export interface HibernatableWebSocketSession {
  sessionId: string;
  getRemoteMain(): RpcStub;
  getStats(): {imports: number, exports: number};
  __experimental_snapshot(): RpcSessionSnapshot;
  __experimental_debugState(): RpcSessionDebugState;
  handleMessage(message: string | ArrayBuffer): void;
  handleClose(code?: number, reason?: string, wasClean?: boolean): void;
  handleError(error: any): void;
}

type HibernatableWebSocket = WebSocket & {
  serializeAttachment?(value: unknown): void;
  deserializeAttachment?(): unknown;
};

export type HibernatableTransportTraceEvent = {
  source: "transport";
  phase: string;
  detail?: Record<string, unknown>;
};

/**
 * Cloudflare Durable Object-specific helper that restores an RPC session on top of a hibernating
 * WebSocket accepted via `DurableObjectState.acceptWebSocket()`.
 *
 * This is intentionally not a general-purpose WebSocket API. It relies on workerd's
 * `serializeAttachment()` / `deserializeAttachment()` behavior and the Durable Object
 * `webSocketMessage()` / `webSocketClose()` / `webSocketError()` event delivery model.
 */
export async function __experimental_newHibernatableWebSocketRpcSession(
    webSocket: HibernatableWebSocket,
    localMain: any,
    options: HibernatableWebSocketOptions): Promise<HibernatableWebSocketSession> {

  let attachment = getAttachment(webSocket);
  const sessionId = options.sessionId ?? attachment?.sessionId ?? makeSessionId();
  const trace = (event: RpcTraceEvent | HibernatableTransportTraceEvent) => {
    try {
      options.__experimental_trace?.(event);
    } catch (_err) {
      // Ignore trace hook failures.
    }
  };

  let snapshot = attachment?.snapshot
      ?? (options.sessionStore ? await options.sessionStore.load(sessionId) : undefined);

  let rpc!: RpcSession;
  let persistScheduled = false;
  let transport = new HibernatableWebSocketTransport(webSocket, () => {
    if (!persistScheduled) {
      persistScheduled = true;
      queueMicrotask(() => {
        persistScheduled = false;
        void persistSnapshot();
      });
    }
  }, trace);

  try {
    rpc = new RpcSession(transport, localMain, {
      ...options,
      __experimental_restoreSnapshot: snapshot,
      __experimental_trace: (event) => trace(event),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('no such entry on exports table')) {
      // The snapshot references exports from a disconnected peer (e.g. a client
      // callback that no longer exists). This WebSocket is stale — close it so
      // the DO can clean up the dead connection.
      trace({
        source: "transport",
        phase: "snapshot.restore.staleSession",
        detail: { error: msg, sessionId },
      });
      try { webSocket.close(1011, 'stale session'); } catch {}
      throw err;
    }
    throw err;
  }

  await persistSnapshot();

  return {
    sessionId,
    getRemoteMain() {
      return rpc.getRemoteMain();
    },
    getStats() {
      return rpc.getStats();
    },
    __experimental_snapshot() {
      return rpc.__experimental_snapshot();
    },
    __experimental_debugState() {
      return rpc.__experimental_debugState();
    },
    handleMessage(message: string | ArrayBuffer) {
      transport.pushIncoming(message);
    },
    handleClose(code?: number, reason?: string, wasClean?: boolean) {
      transport.notifyClosed(code, reason, wasClean);
    },
    handleError(error: any) {
      transport.notifyError(error);
    },
  };

  async function persistSnapshot() {
    try {
      let snap = rpc.__experimental_snapshot();
      webSocket.serializeAttachment?.({
        sessionId,
        version: 1 satisfies 1,
        snapshot: snap,
      } satisfies HibernatableWebSocketAttachment);
      if (options.sessionStore) {
        await options.sessionStore.save(sessionId, snap);
      }
    } catch (err) {
      transport.abort?.(err);
    }
  }
}

export async function __experimental_resumeHibernatableWebSocketRpcSession(
    webSocket: HibernatableWebSocket,
    localMain: any,
    options: HibernatableWebSocketOptions): Promise<HibernatableWebSocketSession> {
  return __experimental_newHibernatableWebSocketRpcSession(webSocket, localMain, options);
}

function getAttachment(webSocket: HibernatableWebSocket): HibernatableWebSocketAttachment | undefined {
  let attachment = webSocket.deserializeAttachment?.() as HibernatableWebSocketAttachment | null | undefined;
  if (attachment?.version === 1 && typeof attachment.sessionId === "string") {
    return attachment;
  }

  return undefined;
}

function makeSessionId(): string {
  if ("crypto" in globalThis && typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return `capnweb-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

class WebSocketTransport implements RpcTransport {
  constructor (webSocket: WebSocket) {
    this.#webSocket = webSocket;

    // Ensure we receive ArrayBuffer instead of Blob for binary messages
    webSocket.binaryType = 'arraybuffer';

    if (webSocket.readyState === WebSocket.CONNECTING) {
      this.#sendQueue = [];
      webSocket.addEventListener("open", event => {
        try {
          for (let message of this.#sendQueue!) {
            webSocket.send(message);
          }
        } catch (err) {
          this.#receivedError(err);
        }
        this.#sendQueue = undefined;
      });
    }

    webSocket.addEventListener("message", (event: MessageEvent<any>) => {
      if (this.#error) {
        // Ignore further messages.
      } else {
        // Handle various binary message types:
        // - ArrayBuffer (browser standard)
        // - Uint8Array (both browser and Node)
        // - Buffer (Node.js ws module)
        // - ArrayBufferView (generic typed array)
        let message: Uint8Array | undefined;
        const data = event.data;

        if (data instanceof ArrayBuffer) {
          message = new Uint8Array(data);
        } else if (data instanceof Uint8Array) {
          message = data;
        } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
          // Node.js Buffer (from ws module)
          message = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        } else if (ArrayBuffer.isView(data)) {
          // Generic ArrayBufferView (TypedArray or DataView)
          message = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }

        if (message) {
          if (this.#receiveResolver) {
            this.#receiveResolver(message);
            this.#receiveResolver = undefined;
            this.#receiveRejecter = undefined;
          } else {
            this.#receiveQueue.push(message);
          }
        } else {
          this.#receivedError(new TypeError(`Received non-binary message from WebSocket: ${typeof data} ${Object.prototype.toString.call(data)}`));
        }
      }
    });

    webSocket.addEventListener("close", (event: CloseEvent) => {
      this.#receivedError(new Error(`Peer closed WebSocket: ${event.code} ${event.reason}`));
    });

    webSocket.addEventListener("error", (event: Event) => {
      this.#receivedError(new Error(`WebSocket connection failed.`));
    });
  }

  #webSocket: WebSocket;
  #sendQueue?: Uint8Array[];  // only if not opened yet
  #receiveResolver?: (message: Uint8Array) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: Uint8Array[] = [];
  #error?: any;

  async send(message: Uint8Array): Promise<void> {
    if (this.#sendQueue === undefined) {
      this.#webSocket.send(message);
    } else {
      // Not open yet, queue for later.
      this.#sendQueue.push(message);
    }
  }

  async receive(): Promise<Uint8Array> {
    if (this.#receiveQueue.length > 0) {
      return this.#receiveQueue.shift()!;
    } else if (this.#error) {
      throw this.#error;
    } else {
      return new Promise<Uint8Array>((resolve, reject) => {
        this.#receiveResolver = resolve;
        this.#receiveRejecter = reject;
      });
    }
  }

  abort?(reason: any): void {
    let message: string;
    if (reason instanceof Error) {
      message = reason.message;
    } else {
      message = `${reason}`;
    }
    this.#webSocket.close(3000, message);

    if (!this.#error) {
      this.#error = reason;
      // No need to call receiveRejecter(); RPC implementation will stop listening anyway.
    }
  }

  #receivedError(reason: any) {
    if (!this.#error) {
      this.#error = reason;
      if (this.#receiveRejecter) {
        this.#receiveRejecter(reason);
        this.#receiveResolver = undefined;
        this.#receiveRejecter = undefined;
      }
    }
  }
}

class HibernatableWebSocketTransport implements RpcTransport {
  constructor(
      private webSocket: WebSocket,
      private onActivity?: () => void,
      private trace?: (event: HibernatableTransportTraceEvent) => void) {}

  #sendQueue?: string[];
  #receiveResolver?: (message: string) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: string[] = [];
  #error?: any;

  async send(message: string): Promise<void> {
    if (this.#error) throw this.#error;

    this.trace?.({
      source: "transport",
      phase: "send.attempt",
      detail: {
        readyState: this.webSocket.readyState,
        byteLength: message.length,
      },
    });

    if (this.webSocket.readyState === WebSocket.CONNECTING) {
      if (!this.#sendQueue) this.#sendQueue = [];
      this.#sendQueue.push(message);
      this.trace?.({
        source: "transport",
        phase: "send.queued",
        detail: { queuedCount: this.#sendQueue.length },
      });
      return;
    }

    if (this.#sendQueue && this.#sendQueue.length > 0) {
      for (let queued of this.#sendQueue) {
        this.webSocket.send(queued);
      }
      this.trace?.({
        source: "transport",
        phase: "send.flushQueue",
        detail: { queuedCount: this.#sendQueue.length },
      });
      this.#sendQueue = undefined;
    }

    this.webSocket.send(message);
    this.trace?.({
      source: "transport",
      phase: "send.sent",
      detail: { readyState: this.webSocket.readyState, byteLength: message.length },
    });
    this.onActivity?.();
  }

  async receive(): Promise<string> {
    if (this.#receiveQueue.length > 0) {
      return this.#receiveQueue.shift()!;
    } else if (this.#error) {
      throw this.#error;
    } else {
      return new Promise<string>((resolve, reject) => {
        this.#receiveResolver = resolve;
        this.#receiveRejecter = reject;
      });
    }
  }

  abort?(reason: any): void {
    let message: string;
    if (reason instanceof Error) {
      message = reason.message;
    } else {
      message = `${reason}`;
    }

    try {
      this.webSocket.close(3000, message);
    } catch (err) {
      // Ignore close failures, but still record the session error below.
    }

    this.#setError(reason);
  }

  pushIncoming(message: string | ArrayBuffer): void {
    if (this.#error) return;

    this.trace?.({
      source: "transport",
      phase: "receive.incoming",
      detail: {
        messageType: typeof message,
        byteLength: typeof message === "string" ? message.length : message.byteLength,
      },
    });

    if (typeof message !== "string") {
      this.#setError(new TypeError("Received non-string message from hibernatable WebSocket."));
      return;
    }

    if (this.#receiveResolver) {
      this.#receiveResolver(message);
      this.#receiveResolver = undefined;
      this.#receiveRejecter = undefined;
    } else {
      this.#receiveQueue.push(message);
    }
    this.onActivity?.();
  }

  notifyClosed(code?: number, reason?: string, wasClean?: boolean): void {
    this.trace?.({
      source: "transport",
      phase: "socket.closed",
      detail: { code: code ?? null, reason: reason ?? null, wasClean: wasClean ?? null },
    });
    this.#setError(new Error(`Peer closed WebSocket: ${code ?? 1005} ${reason ?? ""}`.trim()));
  }

  notifyError(error: any): void {
    this.trace?.({
      source: "transport",
      phase: "socket.error",
      detail: { error: error instanceof Error ? error.message : String(error) },
    });
    this.#setError(error instanceof Error ? error : new Error(`${error}`));
  }

  #setError(reason: any) {
    if (!this.#error) {
      this.#error = reason;
      if (this.#receiveRejecter) {
        this.#receiveRejecter(reason);
        this.#receiveResolver = undefined;
        this.#receiveRejecter = undefined;
      }
    }
  }
}
