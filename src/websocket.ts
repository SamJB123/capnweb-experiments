// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

/// <reference types="@cloudflare/workers-types" />

import { RpcStub } from "./core.js";
import { RpcTransport, RpcSession, RpcSessionOptions } from "./rpc.js";
import type { RpcTraceEvent } from "./rpc.js";
import type {
  HibernatableEncryptedSnapshotEnvelope,
  HibernatableSnapshotSecurity,
  HibernatableSnapshotStorageMode,
  HibernatableSessionStore,
  HibernatableStoredSnapshot,
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
   *  When provided, the snapshot (or encrypted snapshot envelope) is stored
   *  here instead of in the WebSocket attachment (which has a 2048-byte limit
   *  in workerd). The attachment keeps only session lookup metadata. */
  sessionStore?: HibernatableSessionStore;
  sessionId?: string;
  /**
   * Optional snapshot encryption hook. When supplied, capnweb stores encrypted
   * snapshot envelopes instead of plaintext snapshots in both WebSocket
   * attachments and external session stores.
   */
  snapshotSecurity?: HibernatableSnapshotSecurity;
  /**
   * Additional authenticated context to bind to the snapshot, e.g. a verified user
   * ID or room ID. `sessionId` and storage mode are always included by capnweb.
   */
  snapshotSecurityAssociatedData?: unknown;
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

  const storageMode: HibernatableSnapshotStorageMode = options.sessionStore ? "sessionStore" : "inline";
  const associatedData = makeSnapshotAssociatedData(
    sessionId,
    storageMode,
    options.snapshotSecurityAssociatedData,
  );
  let storedSnapshot: HibernatableStoredSnapshot | undefined =
    attachment?.snapshotEnvelope ?? attachment?.snapshot;
  let sessionStoreSnapshotKnownPersisted = false;
  if (storedSnapshot === undefined && options.sessionStore) {
    storedSnapshot = await options.sessionStore.load(sessionId);
    sessionStoreSnapshotKnownPersisted = storedSnapshot !== undefined;
  }

  let snapshot: RpcSessionSnapshot | undefined;
  try {
    snapshot = await openStoredSnapshot(storedSnapshot);
  } catch (_err) {
    try { webSocket.close(1011, 'invalid snapshot'); } catch {}
    if (options.sessionStore) {
      await options.sessionStore.delete(sessionId);
    }
    return undefined;
  }

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
      let snapshotJson = JSON.stringify(snap);
      let existing = getAttachmentRecord(webSocket);
      let existingCapnweb = getAttachmentFromRaw(existing);
      let snapshotFingerprint = options.snapshotSecurity
        ? await options.snapshotSecurity.fingerprint({ plaintext: snapshotJson, associatedData })
        : undefined;
      let canReuseExistingSecurityEnvelope = !!snapshotFingerprint &&
          existingCapnweb?.snapshotFingerprint === snapshotFingerprint;
      if (options.sessionStore && !sessionStoreSnapshotKnownPersisted) {
        canReuseExistingSecurityEnvelope = false;
      }

      let capnwebData: HibernatableWebSocketAttachment;
      let stored: HibernatableStoredSnapshot | undefined;
      if (options.snapshotSecurity) {
        if (canReuseExistingSecurityEnvelope && existingCapnweb) {
          capnwebData = existingCapnweb;
        } else {
          const envelope = await sealSnapshot(snapshotJson, snapshotFingerprint);
          stored = envelope;
          capnwebData = options.sessionStore
            ? {
                sessionId,
                version: 3 satisfies 3,
                snapshotFingerprint: envelope.fingerprint,
              }
            : {
                sessionId,
                version: 3 satisfies 3,
                snapshotEnvelope: envelope,
                snapshotFingerprint: envelope.fingerprint,
              };
        }
      } else {
        stored = snap;
        capnwebData = options.sessionStore
          ? { sessionId, version: 2 satisfies 2 }
          : { sessionId, version: 2 satisfies 2, snapshot: snap };
      }

      let nextAttachment = { ...existing, __capnweb: capnwebData };

      if (options.sessionStore) {
        // When a session store is available, persist the full snapshot there
        // (no size limit) and only store compact metadata in the attachment.
        if (!snapshotFingerprint ||
            !sessionStoreSnapshotKnownPersisted ||
            existingCapnweb?.snapshotFingerprint !== snapshotFingerprint) {
          await options.sessionStore.save(sessionId, stored ?? snap);
          sessionStoreSnapshotKnownPersisted = true;
        }
      }

      if (JSON.stringify(existing) !== JSON.stringify(nextAttachment)) {
        webSocket.serializeAttachment(nextAttachment);
      }
    } catch (err) {
      transport.abort?.(err);
    }
  }

  async function openStoredSnapshot(stored: HibernatableStoredSnapshot | undefined):
      Promise<RpcSessionSnapshot | undefined> {
    if (!stored) return undefined;

    if (isEncryptedSnapshotEnvelope(stored)) {
      if (!options.snapshotSecurity) {
        throw new Error("Encrypted snapshot requires snapshotSecurity.open().");
      }
      if (stored.fingerprint &&
          attachment?.snapshotFingerprint &&
          stored.fingerprint !== attachment.snapshotFingerprint) {
        throw new Error("Encrypted snapshot fingerprint does not match the WebSocket attachment.");
      }
      const plaintext = await options.snapshotSecurity.open({ envelope: stored, associatedData });
      return JSON.parse(plaintext) as RpcSessionSnapshot;
    }

    if (options.snapshotSecurity?.required) {
      throw new Error("Plaintext snapshot rejected because snapshotSecurity is required.");
    }

    return stored;
  }

  async function sealSnapshot(
      snapshotJson: string,
      snapshotFingerprint: string | undefined): Promise<HibernatableEncryptedSnapshotEnvelope> {
    if (!options.snapshotSecurity) {
      throw new Error("snapshotSecurity is required to seal an encrypted snapshot.");
    }

    const envelope = await options.snapshotSecurity.seal({
      plaintext: snapshotJson,
      associatedData,
    });

    return {
      ...envelope,
      ...(envelope.fingerprint ? {} : { fingerprint: snapshotFingerprint }),
    };
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
  return getAttachmentFromRaw(webSocket.deserializeAttachment());
}

function getAttachmentFromRaw(raw: unknown): HibernatableWebSocketAttachment | undefined {
  // Look for capnweb data under __capnweb namespace first (coexistence with
  // other libraries), falling back to the raw attachment for backwards compat.
  let rawRecord = (typeof raw === "object" && raw !== null) ? raw as Record<string, unknown> : undefined;
  let attachment = (rawRecord?.__capnweb ?? raw) as HibernatableWebSocketAttachment | null | undefined;
  if ((attachment?.version === 1 || attachment?.version === 2 || attachment?.version === 3) &&
      typeof attachment.sessionId === "string") {
    return attachment;
  }

  return undefined;
}

function getAttachmentRecord(webSocket: WebSocket): Record<string, unknown> {
  let existing = webSocket.deserializeAttachment();
  if (typeof existing !== "object" || existing === null) return {};
  return existing as Record<string, unknown>;
}

function isEncryptedSnapshotEnvelope(value: unknown): value is HibernatableEncryptedSnapshotEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as HibernatableEncryptedSnapshotEnvelope;
  return envelope.kind === "encrypted" &&
      typeof envelope.alg === "string" &&
      typeof envelope.nonce === "string" &&
      typeof envelope.ciphertext === "string";
}

function makeSnapshotAssociatedData(
    sessionId: string,
    storageMode: HibernatableSnapshotStorageMode,
    associatedData: unknown): string {
  return [
    "capnweb-hibernatable-websocket-snapshot-v1",
    storageMode,
    sessionId,
    JSON.stringify(associatedData ?? null),
  ].join("\n");
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
