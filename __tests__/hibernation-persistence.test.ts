// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { describe, expect, it } from "vitest";
import {
  RpcTarget,
  newWebSocketRpcSession,
  __experimental_newHibernatableWebSocketRpcSession,
  type HibernatableSnapshotSecurity,
  type HibernatableWebSocketOptions,
  type HibernatableSessionStore,
  type HibernatableStoredSnapshot,
} from "../src/index.js";

interface EchoApi {
  echo(value: string): string;
}

class EchoTarget extends RpcTarget {
  echo(value: string): string {
    return value;
  }
}

class CountingSessionStore implements HibernatableSessionStore {
  readonly snapshots = new Map<string, HibernatableStoredSnapshot>();
  readonly saveCounts = new Map<string, number>();

  async load(sessionId: string): Promise<HibernatableStoredSnapshot | undefined> {
    return this.snapshots.get(sessionId);
  }

  async save(sessionId: string, snapshot: HibernatableStoredSnapshot): Promise<void> {
    this.snapshots.set(sessionId, structuredClone(snapshot));
    this.saveCounts.set(sessionId, (this.saveCounts.get(sessionId) ?? 0) + 1);
  }

  async delete(sessionId: string): Promise<void> {
    this.snapshots.delete(sessionId);
  }

  count(sessionId: string): number {
    return this.saveCounts.get(sessionId) ?? 0;
  }
}

type Listener = (event: any) => void;

class FakeWebSocket {
  readonly sent: string[] = [];
  serializeAttachmentCount = 0;
  closeCount = 0;
  closeReason = "";
  readyState = globalThis.WebSocket?.OPEN ?? 1;

  private attachment: unknown;
  private peer?: FakeWebSocket;
  private listeners = new Map<string, Listener[]>();

  connect(peer: FakeWebSocket): void {
    this.peer = peer;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(message: string): void {
    this.sent.push(message);
    queueMicrotask(() => {
      this.peer?.emit("message", { data: message });
    });
  }

  close(code = 1000, reason = ""): void {
    this.closeCount += 1;
    this.closeReason = reason;
    this.readyState = globalThis.WebSocket?.CLOSED ?? 3;
    this.emit("close", { code, reason, wasClean: true });
    this.peer?.emit("close", { code, reason, wasClean: true });
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  getAttachment(): unknown {
    return structuredClone(this.attachment);
  }

  serializeAttachment(value: unknown): void {
    this.serializeAttachmentCount += 1;
    this.attachment = structuredClone(value);
  }

  setAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  private emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createFakeWebSocketPair(): { client: FakeWebSocket; server: FakeWebSocket } {
  const client = new FakeWebSocket();
  const server = new FakeWebSocket();
  client.connect(server);
  server.connect(client);
  return { client, server };
}

function makeTestSnapshotSecurity(secret: string): HibernatableSnapshotSecurity {
  const sealed = new Map<string, { plaintext: string; associatedData: string }>();
  let nextCiphertext = 0;

  return {
    fingerprint({ plaintext, associatedData }): string {
      const input = `${secret}\n${associatedData}\n${plaintext}`;
      let hash = 0;
      for (let i = 0; i < input.length; i++) {
        hash = Math.imul(hash ^ input.charCodeAt(i), 16777619);
      }
      return `fingerprint:${hash >>> 0}`;
    },
    seal({ plaintext, associatedData }) {
      const ciphertext = `ciphertext:${++nextCiphertext}`;
      sealed.set(ciphertext, { plaintext, associatedData });
      return {
        kind: "encrypted",
        alg: "test",
        nonce: `nonce:${nextCiphertext}`,
        ciphertext,
        fingerprint: this.fingerprint({ plaintext, associatedData }),
      } as const;
    },
    open({ envelope, associatedData }) {
      const entry = sealed.get(envelope.ciphertext);
      if (!entry || entry.associatedData !== associatedData) {
        throw new Error("invalid encrypted snapshot");
      }
      return entry.plaintext;
    },
    required: true,
  };
}

async function connectEchoSession(
    store = new CountingSessionStore(),
    options: Partial<HibernatableWebSocketOptions> = {}) {
  const { client, server } = createFakeWebSocketPair();
  const serverSession = await __experimental_newHibernatableWebSocketRpcSession(
    server as unknown as WebSocket,
    new EchoTarget(),
    { sessionStore: store, ...options },
  );
  if (!serverSession) throw new Error("failed to create hibernatable session");

  server.addEventListener("message", (event) => {
    serverSession.handleMessage(event.data);
  });

  return {
    api: newWebSocketRpcSession<EchoApi>(client as unknown as WebSocket),
    server,
    serverSession,
    store,
  };
}

async function connectInlineEchoSession(options: Partial<HibernatableWebSocketOptions> = {}) {
  const { client, server } = createFakeWebSocketPair();
  const serverSession = await __experimental_newHibernatableWebSocketRpcSession(
    server as unknown as WebSocket,
    new EchoTarget(),
    options,
  );
  if (!serverSession) throw new Error("failed to create hibernatable session");

  server.addEventListener("message", (event) => {
    serverSession.handleMessage(event.data);
  });

  return {
    api: newWebSocketRpcSession<EchoApi>(client as unknown as WebSocket),
    server,
    serverSession,
  };
}

describe("hibernatable WebSocket snapshot persistence", () => {
  it("does not persist an unchanged session-store snapshot or attachment after repeated activity", async () => {
    const { api, server, serverSession, store } = await connectEchoSession(
      undefined,
      {
        snapshotSecurity: makeTestSnapshotSecurity("secret"),
        snapshotSecurityAssociatedData: { userId: "one" },
      },
    );

    expect(store.count(serverSession.sessionId)).toBe(1);
    expect(server.serializeAttachmentCount).toBe(1);
    expect("ciphertext" in store.snapshots.get(serverSession.sessionId)!).toBe(true);

    expect(await api.echo("one")).toBe("one");
    expect(await api.echo("two")).toBe("two");
    expect(await api.echo("three")).toBe("three");

    expect(store.count(serverSession.sessionId)).toBe(1);
    expect(server.serializeAttachmentCount).toBe(1);
  });

  it("does not reserialize an unchanged inline snapshot attachment after repeated activity", async () => {
    const { api, server } = await connectInlineEchoSession({
      snapshotSecurity: makeTestSnapshotSecurity("secret"),
      snapshotSecurityAssociatedData: { userId: "one" },
    });

    expect(server.serializeAttachmentCount).toBe(1);
    expect(JSON.stringify(server.getAttachment())).not.toContain("exports");

    expect(await api.echo("one")).toBe("one");
    expect(await api.echo("two")).toBe("two");
    expect(await api.echo("three")).toBe("three");

    expect(server.serializeAttachmentCount).toBe(1);
  });

  it("keeps the unchanged-snapshot cache scoped to each connection", async () => {
    const store = new CountingSessionStore();
    const first = await connectEchoSession(store, {
      snapshotSecurity: makeTestSnapshotSecurity("secret"),
      snapshotSecurityAssociatedData: { userId: "one" },
    });
    const second = await connectEchoSession(store, {
      snapshotSecurity: makeTestSnapshotSecurity("secret"),
      snapshotSecurityAssociatedData: { userId: "two" },
    });

    expect(store.count(first.serverSession.sessionId)).toBe(1);
    expect(store.count(second.serverSession.sessionId)).toBe(1);
    expect(first.server.serializeAttachmentCount).toBe(1);
    expect(second.server.serializeAttachmentCount).toBe(1);

    expect(await first.api.echo("first")).toBe("first");
    expect(await first.api.echo("first again")).toBe("first again");
    expect(await second.api.echo("second")).toBe("second");

    expect(store.count(first.serverSession.sessionId)).toBe(1);
    expect(store.count(second.serverSession.sessionId)).toBe(1);
    expect(first.server.serializeAttachmentCount).toBe(1);
    expect(second.server.serializeAttachmentCount).toBe(1);
  });

  it("rejects a session-store snapshot whose encryption context does not match", async () => {
    const store = new CountingSessionStore();
    const snapshotSecurity = makeTestSnapshotSecurity("secret");
    const first = await connectEchoSession(store, {
      snapshotSecurity,
      snapshotSecurityAssociatedData: { userId: "one" },
    });
    const sessionId = first.serverSession.sessionId;
    expect(store.snapshots.has(sessionId)).toBe(true);

    const { server } = createFakeWebSocketPair();
    server.setAttachment(first.server.getAttachment());

    const restored = await __experimental_newHibernatableWebSocketRpcSession(
      server as unknown as WebSocket,
      new EchoTarget(),
      {
        sessionStore: store,
        sessionId,
        snapshotSecurity,
        snapshotSecurityAssociatedData: { userId: "two" },
      },
    );

    expect(restored).toBeUndefined();
    expect(server.closeCount).toBe(1);
    expect(server.closeReason).toBe("invalid snapshot");
    expect(store.snapshots.has(sessionId)).toBe(false);
  });

  it("does not fall back to plaintext when the session store entry is missing", async () => {
    const store = new CountingSessionStore();
    const snapshotSecurity = makeTestSnapshotSecurity("secret");
    const first = await connectEchoSession(store, {
      snapshotSecurity,
      snapshotSecurityAssociatedData: { userId: "one" },
    });
    const sessionId = first.serverSession.sessionId;
    const attachment = first.server.getAttachment();
    store.snapshots.delete(sessionId);

    const { server } = createFakeWebSocketPair();
    server.setAttachment(attachment);

    const restored = await __experimental_newHibernatableWebSocketRpcSession(
      server as unknown as WebSocket,
      new EchoTarget(),
      {
        sessionStore: store,
        sessionId,
        snapshotSecurity,
        snapshotSecurityAssociatedData: { userId: "one" },
      },
    );

    expect(restored).not.toBeUndefined();
    expect("ciphertext" in store.snapshots.get(sessionId)!).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// importReplay binding: a call that BOTH captures a client capability AND
// returns a capability must survive hibernation.
//
// This is the scenario uncovered in the threejs-playground: `players(writer)`
// captured the writer (a subscription side effect) AND returned a `Subscription`
// handle whose disposal tears the subscription down. The importReplay used to
// re-run the call (re-establishing the subscription) and then DISPOSE the
// returned handle — undoing the very side effect it just restored. The fix
// records the returned capability's export id (`producesExportId`) at resolve
// time and, on restore, binds the re-run result into that export instead of
// disposing it.
// ───────────────────────────────────────────────────────────────────────────

interface UpdateSink {
  onUpdate(value: string): void;
}

/** Client-side callback that records what the server pushes to it. */
class RecordingSink extends RpcTarget {
  readonly received: string[] = [];
  onUpdate(value: string): void {
    this.received.push(value);
  }
}

/** Server-side handle whose disposal is DESTRUCTIVE — it removes the subscriber.
 *  This mirrors the portal `Subscription`: holding it = subscribed, disposing it
 *  = unsubscribed. It's exactly what importReplay used to wrongly dispose. */
class Subscription extends RpcTarget {
  constructor(private readonly unsubscribe: () => void) {
    super();
  }
  [Symbol.dispose](): void {
    this.unsubscribe();
  }
}

/** Server capability. Captures client callbacks (imported caps) and pushes to
 *  them. The `subscribers` set is in-memory: on a wake it starts empty and is
 *  re-populated purely by the importReplay re-running `subscribe`. */
class Hub extends RpcTarget {
  readonly subscribers = new Set<any>();

  /** Captures the callback AND returns a destructive-dispose handle. */
  subscribe(sink: any): Subscription {
    const held = sink.dup();
    this.subscribers.add(held);
    return new Subscription(() => {
      if (this.subscribers.delete(held)) held[Symbol.dispose]();
    });
  }

  /** Captures the callback and returns NOTHING — the case that always worked. */
  subscribeVoid(sink: any): void {
    this.subscribers.add(sink.dup());
  }

  /** Captures the callback and returns the handle NESTED inside an object.
   *  `producesExportId` is only captured for a BARE `["export", N]` return, so
   *  this case is not yet handled (see the "not yet supported" describe block). */
  subscribeNested(sink: any): { handle: Subscription } {
    const held = sink.dup();
    this.subscribers.add(held);
    return {
      handle: new Subscription(() => {
        if (this.subscribers.delete(held)) held[Symbol.dispose]();
      }),
    };
  }

  broadcast(value: string): void {
    for (const sub of this.subscribers) {
      // Fire-and-forget: the push is sent; dispose just releases the result.
      sub.onUpdate(value)[Symbol.dispose]();
    }
  }
}

interface HubApi {
  subscribe(sink: RecordingSink): any;
  subscribeVoid(sink: RecordingSink): any;
  subscribeNested(sink: RecordingSink): any;
  broadcast(value: string): any;
}

/** Let queued microtask message deliveries (and any chained ones) fully drain. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Fresh store-backed (plaintext) Hub session + a connected client. */
async function connectHub() {
  const store = new CountingSessionStore();
  const { client, server } = createFakeWebSocketPair();
  const session = await __experimental_newHibernatableWebSocketRpcSession(
    server as unknown as WebSocket,
    new Hub(),
    { sessionStore: store },
  );
  if (!session) throw new Error("failed to create hibernatable Hub session");
  server.addEventListener("message", (e) => session.handleMessage(e.data));
  const api = newWebSocketRpcSession<HubApi>(client as unknown as WebSocket);
  return { store, client, server, session, api };
}

/**
 * Simulate a Durable Object hibernation wake: capture the live snapshot, then
 * recreate the server session from it on a FRESH socket reconnected to the SAME
 * client. The client socket never disconnects — exactly like the DO case, where
 * the WebSocket survives hibernation and only the server-side session is rebuilt.
 */
async function wake(client: FakeWebSocket, session: any, store: CountingSessionStore) {
  const sessionId: string = session.sessionId;
  // Stash the most current snapshot (with importReplays + producesExportId).
  store.snapshots.set(sessionId, JSON.parse(JSON.stringify(session.__experimental_snapshot())));

  const newServer = new FakeWebSocket();
  client.connect(newServer);
  newServer.connect(client);
  const restored = await __experimental_newHibernatableWebSocketRpcSession(
    newServer as unknown as WebSocket,
    new Hub(),
    { sessionStore: store, sessionId },
  );
  if (!restored) throw new Error("failed to restore hibernatable Hub session");
  newServer.addEventListener("message", (e) => restored.handleMessage(e.data));
  return { newServer, session: restored };
}

describe("hibernatable importReplay rebinds returned capabilities", () => {
  it("a capability-returning subscription keeps pushing after a wake", async () => {
    const { store, client, session, api } = await connectHub();
    const sink = new RecordingSink();

    const sub = await api.subscribe(sink); // hold the handle (pulls → producesExportId set)
    expect(sub).toBeDefined();
    await api.broadcast("before");
    await flush();
    expect(sink.received).toEqual(["before"]);

    await wake(client, session, store);

    await api.broadcast("after");
    await flush();
    // Pre-fix this was ["before"]: the importReplay re-established the subscription
    // and then disposed the returned Subscription, tearing it back down.
    expect(sink.received).toEqual(["before", "after"]);
  });

  it("a void-returning subscription still survives a wake (regression guard)", async () => {
    const { store, client, session, api } = await connectHub();
    const sink = new RecordingSink();

    await api.subscribeVoid(sink);
    await api.broadcast("before");
    await flush();
    expect(sink.received).toEqual(["before"]);

    await wake(client, session, store);

    await api.broadcast("after");
    await flush();
    expect(sink.received).toEqual(["before", "after"]);
  });

  it("the returned handle still unsubscribes after a wake (no double-subscription)", async () => {
    const { store, client, session, api } = await connectHub();
    const sink = new RecordingSink();

    const sub = await api.subscribe(sink);
    await wake(client, session, store);

    await api.broadcast("one");
    await flush();
    expect(sink.received).toEqual(["one"]);

    // Disposing the restored handle must tear down exactly one subscription.
    sub[Symbol.dispose]();
    await flush();
    await api.broadcast("two");
    await flush();
    expect(sink.received).toEqual(["one"]); // "two" not delivered — unsubscribed
  });
});

describe("hibernatable importReplay: nested capability returns (not yet supported — expected to fail)", () => {
  // These document a known gap: `producesExportId` is only captured for a bare
  // `["export", N]` return, not a capability nested inside an object/array. Until
  // that is implemented, the importReplay disposes the nested handle on restore
  // and tears the subscription down. They are intentionally RED.
  it("a subscription whose handle is returned nested in an object keeps pushing after a wake", async () => {
    const { store, client, session, api } = await connectHub();
    const sink = new RecordingSink();

    const result = await api.subscribeNested(sink);
    const handle = result.handle; // hold the nested handle
    expect(handle).toBeDefined();
    await api.broadcast("before");
    await flush();
    expect(sink.received).toEqual(["before"]);

    await wake(client, session, store);

    await api.broadcast("after");
    await flush();
    // EXPECTED TO FAIL until nested returns are supported: stays ["before"].
    expect(sink.received).toEqual(["before", "after"]);
  });
});
