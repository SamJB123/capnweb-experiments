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
  /** Optional session store for persisting snapshots to durable storage.
   *  When provided, the full snapshot is stored here instead of in the
   *  WebSocket attachment (which has a 2048-byte limit in workerd). The
   *  attachment will only contain the session ID for restore lookup. */
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
    webSocket: WebSocket,
    localMain: any,
    options: HibernatableWebSocketOptions): Promise<HibernatableWebSocketSession | undefined> {

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
      if (options.sessionStore) {
        await options.sessionStore.delete(sessionId);
      }
      return undefined;
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
      if (options.sessionStore) {
        options.sessionStore.delete(sessionId).catch((err) => {
          console.error(`[capnweb] Failed to delete session ${sessionId} from store:`, err);
        });
      }
    },
    handleError(error: any) {
      transport.notifyError(error);
    },
  };

  async function persistSnapshot() {
    try {
      let snap = rpc.__experimental_snapshot();
      if (options.sessionStore) {
        // When a session store is available, persist the full snapshot there
        // (no size limit) and only store the session ID in the attachment
        // (which has a 2048-byte limit in workerd).
        await options.sessionStore.save(sessionId, snap);
      }

      // Namespace capnweb data under __capnweb in the attachment so we don't
      // clobber other libraries (e.g. partyserver) that also use the attachment
      // for their own per-connection metadata.
      let capnwebData: HibernatableWebSocketAttachment = options.sessionStore
        ? { sessionId, version: 1 satisfies 1 }
        : { sessionId, version: 1 satisfies 1, snapshot: snap };
      let existing = webSocket.deserializeAttachment() ?? {};
      if (typeof existing !== "object" || existing === null) existing = {};
      webSocket.serializeAttachment({ ...existing, __capnweb: capnwebData });
    } catch (err) {
      transport.abort?.(err);
    }
  }
}

/**
 * Clean up session store entries for clients that disconnected during
 * hibernation. Call this once on Durable Object wake-up.
 *
 * Reads the capnweb sessionId from each live WebSocket's attachment,
 * then delegates to `sessionStore.deleteOrphans()` to remove any stored
 * sessions that no longer have a connected WebSocket.
 *
 * @param webSockets - All currently connected WebSockets (from `ctx.getWebSockets()`)
 * @param sessionStore - The session store used when creating sessions
 * @returns Number of orphaned sessions deleted, or 0 if the store doesn't support deleteOrphans
 */
export async function __experimental_cleanupOrphanedSessions(
    webSockets: WebSocket[],
    sessionStore: HibernatableSessionStore): Promise<number> {
  if (!sessionStore.deleteOrphans) return 0;

  const liveIds = new Set<string>();
  for (const ws of webSockets) {
    const attachment = getAttachment(ws);
    if (attachment?.sessionId) {
      liveIds.add(attachment.sessionId);
    }
  }

  return sessionStore.deleteOrphans(liveIds);
}

export async function __experimental_resumeHibernatableWebSocketRpcSession(
    webSocket: WebSocket,
    localMain: any,
    options: HibernatableWebSocketOptions): Promise<HibernatableWebSocketSession | undefined> {
  return __experimental_newHibernatableWebSocketRpcSession(webSocket, localMain, options);
}

/**
 * Returns the capnweb session ID associated with this WebSocket, if any.
 *
 * A session ID is stamped onto the WebSocket's attachment by
 * `__experimental_newHibernatableWebSocketRpcSession` the first time a
 * session is opened over it. The attachment survives hibernation, so this
 * is the right way — from inside `webSocketMessage`, `webSocketClose`, etc.
 * — to tell whether you've already seen a given WebSocket and can reuse a
 * cached session instance.
 *
 * The session ID is always on the attachment regardless of whether a
 * `sessionStore` was provided: in store mode the snapshot lives in the
 * store while the attachment keeps just the ID; in inline mode the
 * snapshot lives alongside the ID on the attachment itself. Either way,
 * this function reads the same field.
 *
 * Returns `undefined` if the WebSocket has no capnweb attachment (e.g. a
 * fresh connection that hasn't been handed to
 * `__experimental_newHibernatableWebSocketRpcSession` yet).
 *
 * Typical usage in a Durable Object:
 *
 *     private sessions = new Map<string, MySessionEntry>();
 *
 *     async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
 *       const sid = __experimental_hibernatableWebSocketSessionId(ws);
 *       const entry = (sid && this.sessions.get(sid)) ?? await this.attach(ws);
 *       entry.session.handleMessage(message);
 *     }
 */
export function __experimental_hibernatableWebSocketSessionId(
    webSocket: WebSocket): string | undefined {
  return getAttachment(webSocket)?.sessionId;
}

function getAttachment(webSocket: WebSocket): HibernatableWebSocketAttachment | undefined {
  let raw = webSocket.deserializeAttachment() as Record<string, unknown> | null | undefined;
  // Look for capnweb data under __capnweb namespace first (coexistence with
  // other libraries), falling back to the raw attachment for backwards compat.
  let attachment = (raw?.__capnweb ?? raw) as HibernatableWebSocketAttachment | null | undefined;
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
      } else if (typeof event.data === "string") {
        if (this.#receiveResolver) {
          this.#receiveResolver(event.data);
          this.#receiveResolver = undefined;
          this.#receiveRejecter = undefined;
        } else {
          this.#receiveQueue.push(event.data);
        }
      } else {
        this.#receivedError(new TypeError("Received non-string message from WebSocket."));
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
  #sendQueue?: string[];  // only if not opened yet
  #receiveResolver?: (message: string) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: string[] = [];
  #error?: any;

  async send(message: string): Promise<void> {
    if (this.#sendQueue === undefined) {
      this.#webSocket.send(message);
    } else {
      // Not open yet, queue for later.
      this.#sendQueue.push(message);
    }
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
      try { message = JSON.stringify(reason); } catch { message = `${reason}`; }
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
      try { message = JSON.stringify(reason); } catch { message = `${reason}`; }
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
