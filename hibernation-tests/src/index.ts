import {
  __experimental_newDurableObjectSessionStore,
  __experimental_newHibernatableWebSocketRpcSession,
} from "../../src/index-workers.ts";
import {
  RpcTarget,
} from "../../src/index.ts";
import { DurableObject } from "cloudflare:workers";
import type { RpcTraceEvent } from "../../src/rpc.ts";
import type { HibernatableTransportTraceEvent } from "../../src/websocket.ts";

interface Env {
  HIB_RPC: DurableObjectNamespace<HibRpcDo>;
  CHAT_ROOM: DurableObjectNamespace<ChatRoomDo>;
  NO_STORE_HIB_RPC: DurableObjectNamespace<NoStoreHibRpcDo>;
}

type ChatMessage = {
  user: string;
  text: string;
  at: number;
};

class DurableCounterProxy extends RpcTarget {
  constructor(
      private ctx: DurableObjectState,
      readonly key: string) {
    super();
  }

  async increment(amount = 1) {
    const current = ((await this.ctx.storage.get(`counter:${this.key}`)) as number) ?? 0;
    const next = current + amount;
    await this.ctx.storage.put(`counter:${this.key}`, next);
    return next;
  }

  getValue() {
    return this.ctx.storage.get(`counter:${this.key}`).then(v => (v as number) ?? 0);
  }
}

class ChatRoomProxy extends RpcTarget {
  constructor(
      private env: Env,
      readonly roomName: string) {
    super();
  }

  async postMessage(user: string, text: string) {
    return this.env.CHAT_ROOM.getByName(this.roomName).postMessage(user, text);
  }

  async listMessages() {
    return this.env.CHAT_ROOM.getByName(this.roomName).listMessages();
  }

  async getMessageCount() {
    return this.env.CHAT_ROOM.getByName(this.roomName).getMessageCount();
  }
}

class HiddenArgProbe extends RpcTarget {
  #secret: string;

  constructor(
      private ctx: DurableObjectState,
      readonly label: string,
      secret: string) {
    super();
    this.#secret = secret;
  }

  async getStorageKind() {
    return this.ctx.storage.constructor?.name ?? "unknown";
  }

  getVisibleLabel() {
    return this.label;
  }

  getSecretEcho() {
    return this.#secret;
  }

  getSecretLength() {
    return this.#secret.length;
  }
}

class ChatRoomCapability extends RpcTarget {
  constructor(
      private ctx: DurableObjectState,
      readonly roomName: string) {
    super();
  }

  async postMessage(user: string, text: string) {
    const messages = ((await this.ctx.storage.get("messages")) as ChatMessage[] | undefined) ?? [];
    const last = { user, text, at: Date.now() };
    messages.push(last);
    await this.ctx.storage.put("messages", messages);
    return { count: messages.length, last };
  }

  async listMessages() {
    return ((await this.ctx.storage.get("messages")) as ChatMessage[] | undefined) ?? [];
  }

  async getMessageCount() {
    return (((await this.ctx.storage.get("messages")) as ChatMessage[] | undefined) ?? []).length;
  }
}

class ChatRoomRootTarget extends RpcTarget {
  constructor(
      private ctx: DurableObjectState,
      private roomName: string,
      private host: ChatRoomDo) {
    super();
  }

  getRoomCapability() {
    return new ChatRoomCapability(this.ctx, this.roomName);
  }

  getInstanceId() {
    return this.host.instanceId;
  }
}

export class ChatRoomDo extends DurableObject {
  instanceId: string;
  roomSessionStore: ReturnType<typeof __experimental_newDurableObjectSessionStore>;
  roomSessions = new Map<string, any>();
  roomReady: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.instanceId = crypto.randomUUID();
    this.roomSessionStore = __experimental_newDurableObjectSessionStore(ctx.storage, "room-hib:");
    console.log("[ChatRoomDo] constructor", JSON.stringify({
      instanceId: this.instanceId,
      existingSocketCount: this.ctx.getWebSockets("capnweb-room").length,
      at: new Date().toISOString(),
    }));
    this.roomReady = this.restoreRoomSessions();
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    console.log("[ChatRoomDo] fetch", JSON.stringify({
      instanceId: this.instanceId,
      pathname: url.pathname,
      method: req.method,
      at: new Date().toISOString(),
    }));

    if (url.pathname === "/instance-id") {
      return Response.json({ instanceId: this.instanceId });
    }

    if (url.pathname === "/diagnostics") {
      const messages = ((await this.ctx.storage.get("messages")) as ChatMessage[] | undefined) ?? [];
      return Response.json({
        instanceId: this.instanceId,
        messageCount: messages.length,
        lastMessage: messages.at(-1) ?? null,
      });
    }

    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, ["capnweb-room"]);
      await this.roomReady;
      await this.attachRoomSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  async postMessage(user: string, text: string): Promise<{count: number; last: ChatMessage}> {
    const messages = ((await this.ctx.storage.get("messages")) as ChatMessage[] | undefined) ?? [];
    const last = { user, text, at: Date.now() };
    messages.push(last);
    await this.ctx.storage.put("messages", messages);
    return { count: messages.length, last };
  }

  async listMessages(): Promise<ChatMessage[]> {
    return ((await this.ctx.storage.get("messages")) as ChatMessage[] | undefined) ?? [];
  }

  async getMessageCount(): Promise<number> {
    return (((await this.ctx.storage.get("messages")) as ChatMessage[] | undefined) ?? []).length;
  }

  getRoomCapability(roomName: string): ChatRoomCapability {
    return new ChatRoomCapability(this.ctx, roomName);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    await this.roomReady;
    const session = await this.getOrAttachRoomSession(ws);
    session.handleMessage(message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    await this.roomReady;
    const sid = this.getRoomSessionId(ws);
    const session = sid ? this.roomSessions.get(sid) : undefined;
    session?.handleClose(code, reason, wasClean);
    if (sid) this.roomSessions.delete(sid);
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    await this.roomReady;
    const sid = this.getRoomSessionId(ws);
    const session = sid ? this.roomSessions.get(sid) : undefined;
    session?.handleError(error);
  }

  private async restoreRoomSessions() {
    for (const ws of this.ctx.getWebSockets("capnweb-room")) {
      await this.attachRoomSession(ws);
    }
  }

  private async getOrAttachRoomSession(ws: WebSocket) {
    const sid = this.getRoomSessionId(ws);
    if (sid && this.roomSessions.has(sid)) {
      return this.roomSessions.get(sid);
    }
    return this.attachRoomSession(ws);
  }

  private async attachRoomSession(ws: WebSocket) {
    const knownSessionId = this.getRoomSessionId(ws);
      const session = await __experimental_newHibernatableWebSocketRpcSession(
        ws as any,
        new ChatRoomRootTarget(this.ctx, "direct-room", this),
        {
          sessionStore: this.roomSessionStore,
          onSendError(err) { return err; },
          sessionId: knownSessionId,
        });
    this.roomSessions.set(session.sessionId, session);
    return session;
  }

  private getRoomSessionId(ws: WebSocket): string | undefined {
    const raw = (ws as any).deserializeAttachment?.();
    // capnweb namespaces its data under __capnweb (see persistSnapshot in
    // src/websocket.ts). Fall back to raw for backwards compatibility.
    const attachment = raw?.__capnweb ?? raw;
    if (attachment && attachment.version === 1 && typeof attachment.sessionId === "string") {
      return attachment.sessionId;
    }
    return undefined;
  }
}

class RootTarget extends RpcTarget {
  constructor(
      private ctx: DurableObjectState,
      private env: Env,
      private host: HibRpcDo) {
    super();
  }

  getDurableCounter(key: string) {
    return new DurableCounterProxy(this.ctx, key);
  }

  getChatRoom(roomName: string) {
    return new ChatRoomProxy(this.env, roomName);
  }

  getHiddenArgProbe(label: string, secret: string) {
    return new HiddenArgProbe(this.ctx, label, secret);
  }

  storeClientCallback(name: string, callback: any) {
    this.host.clientCallbacks.set(name, typeof callback?.dup === "function" ? callback.dup() : callback);
    return this.host.clientCallbacks.size;
  }

  getStoredClientCallbackCount() {
    return this.host.clientCallbacks.size;
  }

  clearStoredClientCallbacks() {
    this.host.clientCallbacks.clear();
    return 0;
  }

  async invokeStoredClientCallback(name: string, message: string) {
    const callback = this.host.clientCallbacks.get(name);
    if (!callback) {
      throw new Error(`No stored client callback named ${name}`);
    }
    return callback.notify(message);
  }

  square(n: number) {
    return n * n;
  }

  echo(msg: string) {
    return msg;
  }

  getInstanceId() {
    return this.host.instanceId;
  }

  async delayedDurableIncrement(name: string, amount = 1, delayMs = 10) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return this.getDurableCounter(name).increment(amount);
  }
}

export class HibRpcDo extends DurableObject {
  sessionStore: ReturnType<typeof __experimental_newDurableObjectSessionStore>;
  sessions = new Map<string, any>();
  ready: Promise<void>;
  instanceId: string;
  restoreAttempts = 0;
  restoreSuccesses = 0;
  attachSessionCalls = 0;
  webSocketMessageCount = 0;
  reusedSessionCount = 0;
  createdSessionCount = 0;
  lastMessageKind: string | null = null;
  sessionTraces = new Map<string, Array<{
    at: number;
    source: string;
    phase: string;
    detail?: Record<string, unknown>;
  }>>();
  clientCallbacks = new Map<string, any>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.instanceId = crypto.randomUUID();
    this.sessionStore = __experimental_newDurableObjectSessionStore(ctx.storage, "hib:");
    const existingSockets = this.ctx.getWebSockets("capnweb");
    console.log("[HibRpcDo] constructor", JSON.stringify({
      instanceId: this.instanceId,
      existingSocketCount: existingSockets.length,
      wakeReason: existingSockets.length > 0 ? "hibernation-wake-or-restart-with-open-sockets" : "fresh-init",
      at: new Date().toISOString(),
    }));
    this.ready = this.restoreSessions();
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    console.log("[HibRpcDo] fetch", JSON.stringify({
      instanceId: this.instanceId,
      pathname: url.pathname,
      method: req.method,
      upgrade: req.headers.get("Upgrade") ?? null,
      at: new Date().toISOString(),
    }));

    if (url.pathname === "/instance-id") {
      return Response.json({ instanceId: this.instanceId });
    }

    if (url.pathname === "/attachments") {
      const sockets = this.ctx.getWebSockets("capnweb");
      // capnweb stores snapshots in the sessionStore (when provided) instead of
      // inline on the attachment, so consult both sources for hasSnapshot/snapshot.
      const attachments = await Promise.all(sockets.map(async (ws) => {
        const raw = (ws as any).deserializeAttachment?.();
        const attachment = raw?.__capnweb ?? raw;
        const sessionId = attachment?.sessionId ?? null;
        const stored = sessionId ? await this.sessionStore.load(sessionId) : undefined;
        const snap: any = attachment?.snapshot ?? stored ?? null;
        return {
          sessionId,
          version: attachment?.version ?? null,
          hasSnapshot: !!snap,
          snapshot: snap ? {
            nextExportId: snap.nextExportId ?? null,
            exportCount: snap.exports?.length ?? 0,
            importCount: snap.imports?.length ?? 0,
          } : null,
        };
      }));
      return Response.json({
        instanceId: this.instanceId,
        count: attachments.length,
        attachments,
      });
    }

    if (url.pathname === "/resume-diagnostics") {
      const sockets = this.ctx.getWebSockets("capnweb");
      const diagnostics = await Promise.all(sockets.map(async (ws) => {
        const raw = (ws as any).deserializeAttachment?.();
        const attachment = raw?.__capnweb ?? raw;
        const sessionId = attachment?.sessionId;
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        let snapshot: any = null;
        let debugState: any = null;
        try {
          snapshot = session?.__experimental_snapshot?.();
        } catch (err: any) {
          snapshot = { error: err?.message ?? `${err}` };
        }
        try {
          debugState = session?.__experimental_debugState?.() ?? null;
        } catch (err: any) {
          debugState = { error: err?.message ?? `${err}` };
        }
        // The fork stores snapshots in the sessionStore (instead of inline on
        // the attachment) when one is provided. Surface the persisted snapshot
        // here so the tests can verify persistence end-to-end.
        const storedSnap = sessionId ? await this.sessionStore.load(sessionId) : undefined;
        const persistedSnap: any = attachment?.snapshot ?? storedSnap ?? null;
        return {
          sessionId: sessionId ?? null,
          hasAttachment: !!attachment,
          hasSnapshot: !!persistedSnap,
          hasSession: !!session,
          stats: session?.getStats?.() ?? null,
          attachmentSnapshot: persistedSnap ? {
            nextExportId: persistedSnap.nextExportId ?? null,
            exportCount: persistedSnap.exports?.length ?? 0,
            importCount: persistedSnap.imports?.length ?? 0,
          } : null,
          snapshot: snapshot ? {
            nextExportId: snapshot.nextExportId ?? null,
            exportCount: snapshot.exports?.length ?? 0,
            importCount: snapshot.imports?.length ?? 0,
            error: snapshot.error ?? null,
          } : null,
          debugState,
          traces: sessionId ? (this.sessionTraces.get(sessionId) ?? []) : [],
        };
      }));
      return Response.json({
        instanceId: this.instanceId,
        sessionCount: this.sessions.size,
        counters: {
          restoreAttempts: this.restoreAttempts,
          restoreSuccesses: this.restoreSuccesses,
          attachSessionCalls: this.attachSessionCalls,
          webSocketMessageCount: this.webSocketMessageCount,
          reusedSessionCount: this.reusedSessionCount,
          createdSessionCount: this.createdSessionCount,
          lastMessageKind: this.lastMessageKind,
          clientCallbackCount: this.clientCallbacks.size,
        },
        sessions: diagnostics,
      });
    }

    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, ["capnweb"]);
    await this.ready;
    await this.attachSession(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    await this.ready;
    this.webSocketMessageCount += 1;
    this.lastMessageKind = typeof message === "string" ? "string" : `binary(${message.byteLength})`;
    console.log("[HibRpcDo] webSocketMessage", JSON.stringify({
      instanceId: this.instanceId,
      sessionId: this.getSessionId(ws) ?? null,
      messageKind: this.lastMessageKind,
      webSocketMessageCount: this.webSocketMessageCount,
      at: new Date().toISOString(),
    }));
    const session = await this.getOrAttachSession(ws);
    session.handleMessage(message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    await this.ready;
    const sid = this.getSessionId(ws);
    console.log("[HibRpcDo] webSocketClose", JSON.stringify({
      instanceId: this.instanceId,
      sessionId: sid ?? null,
      code,
      reason,
      wasClean,
      at: new Date().toISOString(),
    }));
    const session = sid ? this.sessions.get(sid) : undefined;
    session?.handleClose(code, reason, wasClean);
    if (sid) this.sessions.delete(sid);
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    await this.ready;
    const sid = this.getSessionId(ws);
    console.log("[HibRpcDo] webSocketError", JSON.stringify({
      instanceId: this.instanceId,
      sessionId: sid ?? null,
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    }));
    const session = sid ? this.sessions.get(sid) : undefined;
    session?.handleError(error);
  }

  private async restoreSessions() {
    console.log("[HibRpcDo] restoreSessions.begin", JSON.stringify({
      instanceId: this.instanceId,
      socketCount: this.ctx.getWebSockets("capnweb").length,
      at: new Date().toISOString(),
    }));
    for (const ws of this.ctx.getWebSockets("capnweb")) {
      this.restoreAttempts += 1;
      await this.attachSession(ws);
      this.restoreSuccesses += 1;
    }
    console.log("[HibRpcDo] restoreSessions.end", JSON.stringify({
      instanceId: this.instanceId,
      restoreAttempts: this.restoreAttempts,
      restoreSuccesses: this.restoreSuccesses,
      sessionCount: this.sessions.size,
      at: new Date().toISOString(),
    }));
  }

  private async getOrAttachSession(ws: WebSocket) {
    const sid = this.getSessionId(ws);
    if (sid && this.sessions.has(sid)) {
      this.reusedSessionCount += 1;
      return this.sessions.get(sid);
    }
    this.createdSessionCount += 1;
    return this.attachSession(ws);
  }

  private async attachSession(ws: WebSocket) {
    this.attachSessionCalls += 1;
    const knownSessionId = this.getSessionId(ws);
    console.log("[HibRpcDo] attachSession.begin", JSON.stringify({
      instanceId: this.instanceId,
      knownSessionId: knownSessionId ?? null,
      attachSessionCalls: this.attachSessionCalls,
      at: new Date().toISOString(),
    }));
    const session = await __experimental_newHibernatableWebSocketRpcSession(
        ws as any,
        new RootTarget(this.ctx, this.env as Env, this),
        {
          sessionStore: this.sessionStore,
          onSendError(err) { return err; },
          sessionId: knownSessionId,
          __experimental_trace: (event: RpcTraceEvent | HibernatableTransportTraceEvent) => {
            const sessionId = this.getSessionId(ws) ?? knownSessionId ?? "pending";
            this.pushTrace(sessionId, event);
            if (
              event.phase === "receive" ||
              event.phase === "readLoop.push" ||
              event.phase === "readLoop.pull" ||
              event.phase === "readLoop.resolve" ||
              event.phase === "readLoop.reject" ||
              event.phase === "send" ||
              event.phase === "ensureResolvingExport.start" ||
              event.phase === "ensureResolvingExport.resolve" ||
              event.phase === "ensureResolvingExport.reject" ||
              event.phase === "getOrRestoreExportHook.restore"
            ) {
              console.log("[HibRpcDo] trace", JSON.stringify({
                instanceId: this.instanceId,
                sessionId,
                source: event.source,
                phase: event.phase,
                detail: event.detail ?? null,
                at: new Date().toISOString(),
              }));
            }
          },
        });
    this.sessions.set(session.sessionId, session);
    if (knownSessionId && knownSessionId !== session.sessionId) {
      const pending = this.sessionTraces.get(knownSessionId);
      if (pending) {
        this.sessionTraces.delete(knownSessionId);
        this.sessionTraces.set(session.sessionId, pending);
      }
    }
    this.pushTrace(session.sessionId, {
      source: "worker",
      phase: "attachSession.complete",
      detail: { knownSessionId: knownSessionId ?? null },
    });
    console.log("[HibRpcDo] attachSession.end", JSON.stringify({
      instanceId: this.instanceId,
      sessionId: session.sessionId,
      sessionCount: this.sessions.size,
      at: new Date().toISOString(),
    }));
    return session;
  }

  private getSessionId(ws: WebSocket): string | undefined {
    const raw = (ws as any).deserializeAttachment?.();
    // capnweb namespaces its data under __capnweb (see persistSnapshot in
    // src/websocket.ts). Fall back to raw for backwards compatibility.
    const attachment = raw?.__capnweb ?? raw;
    if (attachment && attachment.version === 1 && typeof attachment.sessionId === "string") {
      return attachment.sessionId;
    }
    return undefined;
  }

  private pushTrace(
      sessionId: string,
      event: {
        source: string;
        phase: string;
        detail?: Record<string, unknown>;
      }) {
    const current = this.sessionTraces.get(sessionId) ?? [];
    current.push({
      at: Date.now(),
      source: event.source,
      phase: event.phase,
      ...(event.detail ? { detail: event.detail } : {}),
    });
    if (current.length > 200) {
      current.splice(0, current.length - 200);
    }
    this.sessionTraces.set(sessionId, current);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NoStoreHibRpcDo: same shape as HibRpcDo but does NOT pass a sessionStore to
// __experimental_newHibernatableWebSocketRpcSession. In that mode the library
// inlines the snapshot into the WebSocket attachment instead of persisting it
// to a separate store. This DO + its endpoints exist so we can verify the
// attachment-only persistence path end-to-end.
// ─────────────────────────────────────────────────────────────────────────────

class NoStoreRootTarget extends RpcTarget {
  constructor(private ctx: DurableObjectState, private host: NoStoreHibRpcDo) { super(); }
  echo(msg: string) { return msg; }
  square(n: number) { return n * n; }
  getInstanceId() { return this.host.instanceId; }
  getDurableCounter(key: string) { return new DurableCounterProxy(this.ctx, key); }
}

export class NoStoreHibRpcDo extends DurableObject {
  sessions = new Map<string, any>();
  instanceId: string;
  ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.instanceId = crypto.randomUUID();
    this.ready = this.restoreSessions();
  }

  private async restoreSessions() {
    for (const ws of this.ctx.getWebSockets("capnweb-no-store")) {
      await this.attachSession(ws);
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/instance-id") {
      return Response.json({ instanceId: this.instanceId });
    }

    if (url.pathname === "/attachments") {
      const sockets = this.ctx.getWebSockets("capnweb-no-store");
      const attachments = sockets.map((ws) => {
        const raw = (ws as any).deserializeAttachment?.();
        const attachment = raw?.__capnweb ?? raw;
        return {
          sessionId: attachment?.sessionId ?? null,
          version: attachment?.version ?? null,
          // No sessionStore is provided to the session, so the snapshot must
          // live inline on the attachment.
          hasSnapshot: !!attachment?.snapshot,
          snapshot: attachment?.snapshot ? {
            nextExportId: attachment.snapshot.nextExportId ?? null,
            exportCount: attachment.snapshot.exports?.length ?? 0,
            importCount: attachment.snapshot.imports?.length ?? 0,
          } : null,
        };
      });
      return Response.json({ instanceId: this.instanceId, count: attachments.length, attachments });
    }

    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ["capnweb-no-store"]);
    await this.ready;
    await this.attachSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    await this.ready;
    const session = await this.getOrAttachSession(ws);
    session.handleMessage(message);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    await this.ready;
    const sid = this.getSessionId(ws);
    const session = sid ? this.sessions.get(sid) : undefined;
    session?.handleClose(code, reason, wasClean);
    if (sid) this.sessions.delete(sid);
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    await this.ready;
    const sid = this.getSessionId(ws);
    const session = sid ? this.sessions.get(sid) : undefined;
    session?.handleError(error);
  }

  private async getOrAttachSession(ws: WebSocket) {
    const sid = this.getSessionId(ws);
    if (sid && this.sessions.has(sid)) return this.sessions.get(sid);
    return this.attachSession(ws);
  }

  private async attachSession(ws: WebSocket) {
    const knownSessionId = this.getSessionId(ws);
    // Note: NO sessionStore here — snapshot will live inline on the attachment.
    const session = await __experimental_newHibernatableWebSocketRpcSession(
        ws as any,
        new NoStoreRootTarget(this.ctx, this),
        {
          onSendError(err) { return err; },
          sessionId: knownSessionId,
        });
    this.sessions.set(session.sessionId, session);
    return session;
  }

  private getSessionId(ws: WebSocket): string | undefined {
    const raw = (ws as any).deserializeAttachment?.();
    const attachment = raw?.__capnweb ?? raw;
    if (attachment && attachment.version === 1 && typeof attachment.sessionId === "string") {
      return attachment.sessionId;
    }
    return undefined;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (
        url.pathname === "/ws" ||
        url.pathname === "/instance-id" ||
        url.pathname === "/attachments" ||
        url.pathname === "/resume-diagnostics") {
      const stub = env.HIB_RPC.getByName("test");
      return stub.fetch(request);
    }

    if (
        url.pathname === "/no-store-ws" ||
        url.pathname === "/no-store-instance-id" ||
        url.pathname === "/no-store-attachments") {
      const stub = env.NO_STORE_HIB_RPC.getByName("no-store-test");
      const innerUrl = new URL(request.url);
      innerUrl.pathname = url.pathname.replace(/^\/no-store-/, "/");
      if (innerUrl.pathname === "/ws") innerUrl.pathname = "/ws";
      return stub.fetch(new Request(innerUrl.toString(), request));
    }

    if (
        url.pathname === "/chat-room-instance" ||
        url.pathname === "/chat-room-diagnostics") {
      const roomName = url.searchParams.get("room");
      if (!roomName) {
        return new Response("Missing room query parameter", { status: 400 });
      }
      const stub = env.CHAT_ROOM.getByName(roomName);
      const innerUrl = new URL(request.url);
      innerUrl.pathname = url.pathname === "/chat-room-instance" ? "/instance-id" : "/diagnostics";
      return stub.fetch(new Request(innerUrl.toString(), request));
    }

    if (url.pathname === "/chat-room-ws") {
      const roomName = url.searchParams.get("room");
      if (!roomName) {
        return new Response("Missing room query parameter", { status: 400 });
      }
      const stub = env.CHAT_ROOM.getByName(roomName);
      const innerUrl = new URL(request.url);
      innerUrl.pathname = "/ws";
      return stub.fetch(new Request(innerUrl.toString(), request));
    }

    return new Response("Not found", { status: 404 });
  },
};
