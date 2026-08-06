// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { describe, expect, it } from "vitest";
import {
  RpcTarget,
  newWebSocketRpcSession,
  __experimental_newHibernatableWebSocketRpcSession,
  __experimental_newWebCryptoSnapshotSecurity,
  type HibernatableSnapshotSecurity,
  type HibernatableWebSocketOptions,
  type HibernatableSessionStore,
  type HibernatableStoredSnapshot,
} from "../src/index.js";
import { createCborCodec } from "../src/codec/cbor/index.js";

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
  readonly sent: unknown[] = [];
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

  send(message: unknown): void {
    this.sent.push(message);
    const delivered = message instanceof Uint8Array
      ? message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength)
      : message;
    queueMicrotask(() => {
      this.peer?.emit("message", { data: delivered });
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
// records the export id of EVERY returned capability (`producesExportIds`) at
// resolve time — bare, or nested arbitrarily deep in objects/arrays, and however
// many — then on restore re-runs the call ONCE and rebinds each of those exports
// from the single result instead of disposing it.
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

/** A non-capturing returned capability (claim-like). Its in-memory state resets
 *  on a lazy provenance restore. */
class Counter extends RpcTarget {
  #n = 0;
  bump(): number {
    return ++this.#n;
  }
}

/** Server capability. Captures client callbacks (imported caps) and pushes to
 *  them. The `subscribers` set is in-memory: on a wake it starts empty and is
 *  re-populated purely by the importReplay re-running `subscribe`. */
class Hub extends RpcTarget {
  readonly subscribers = new Set<any>();
  /** Named channels, used by the multi / nested / role-based tests. Like
   *  `subscribers`, these are in-memory: empty on a wake, repopulated solely by
   *  importReplays re-running the issuing calls. */
  readonly topics = new Map<string, Set<any>>();

  /** Subscribe `sink` to a named topic and hand back a destructive-dispose
   *  handle (holding it = subscribed to that topic). Private, so it is not part
   *  of the RPC surface. */
  #subscribeTopic(topic: string, sink: any): Subscription {
    const held = sink.dup();
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(held);
    return new Subscription(() => {
      if (set!.delete(held)) held[Symbol.dispose]();
    });
  }

  /** Push to one topic's subscribers, tagging the value with the topic so the
   *  sink can tell channels apart. */
  broadcastTopic(topic: string, value: string): void {
    for (const sub of this.topics.get(topic) ?? []) {
      sub.onUpdate(`${topic}:${value}`)[Symbol.dispose]();
    }
  }

  /** Returns SEVERAL capabilities from ONE capturing call: two topic
   *  subscriptions plus a non-capturing counter, in a flat object. */
  issueAll(sink: any): { alerts: Subscription; news: Subscription; counter: Counter } {
    return {
      alerts: this.#subscribeTopic("alerts", sink),
      news: this.#subscribeTopic("news", sink),
      counter: new Counter(),
    };
  }

  /** Returns capabilities buried several levels deep, inside both objects AND
   *  arrays — the worst case for navigating provenance on restore. */
  issueNested(sink: any): {
    rooms: { feed: Subscription }[];
    admin: { panel: { audit: Subscription } };
  } {
    return {
      rooms: [
        { feed: this.#subscribeTopic("room-0", sink) },
        { feed: this.#subscribeTopic("room-1", sink) },
      ],
      admin: { panel: { audit: this.#subscribeTopic("audit", sink) } },
    };
  }

  /** Issues DIFFERENT capability sets depending on the role — the
   *  security-sensitive case. guest → {read}; moderator → {read, kick};
   *  admin → {read, kick, shutdown}. On restore EXACTLY the issued caps must
   *  rebind: no MORE (that would grant authority the user never had) and no
   *  FEWER (that would silently drop a granted capability). The role is a literal
   *  argument, so it is baked into the replayed call expression. */
  login(role: "guest" | "moderator" | "admin", sink: any): Record<string, Subscription> {
    const caps: Record<string, Subscription> = {
      read: this.#subscribeTopic("read", sink),
    };
    if (role === "moderator" || role === "admin") {
      caps.kick = this.#subscribeTopic("kick", sink);
    }
    if (role === "admin") {
      caps.shutdown = this.#subscribeTopic("shutdown", sink);
    }
    return caps;
  }

  /** Captures NOTHING and returns a capability NESTED in an object. Not recorded
   *  in importReplays — restored lazily via export provenance (which records the
   *  path to the nested cap). Probes whether the lazy path navigates nesting. */
  claimNested(): { handle: Counter } {
    return { handle: new Counter() };
  }

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
   *  The returned export id is captured at resolve time wherever it sits, so the
   *  importReplay rebinds it (and any siblings) on restore. */
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
  claimNested(): any;
  broadcast(value: string): any;
  broadcastTopic(topic: string, value: string): any;
  issueAll(sink: RecordingSink): any;
  issueNested(sink: RecordingSink): any;
  login(role: "guest" | "moderator" | "admin", sink: RecordingSink): any;
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
  // Stash the most current snapshot (with importReplays + producesExportIds).
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

  it("PROBE: a non-capturing NESTED capability return is reconstructed lazily after a wake", async () => {
    const { store, client, session, api } = await connectHub();
    const result = await api.claimNested(); // not captured → lazy provenance restore
    const handle = result.handle; // a nested cap (provenance records the path to it)
    expect(await handle.bump()).toBe(1);

    await wake(client, session, store);

    // If the lazy getOrRestoreExportHook navigates provenance paths, using the
    // nested handle re-runs claimNested and reaches `.handle` → fresh Counter.
    expect(await handle.bump()).toBe(1);
  });
});

describe("hibernatable importReplay: nested / multiple / conditional capability returns", () => {
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
    expect(sink.received).toEqual(["before", "after"]);
  });

  it("multiple capabilities returned from one call all survive a wake", async () => {
    const { store, client, session, api } = await connectHub();
    const sink = new RecordingSink();

    const bundle = await api.issueAll(sink); // { alerts, news, counter } — hold it
    expect(await bundle.counter.bump()).toBe(1);
    await api.broadcastTopic("alerts", "a1");
    await api.broadcastTopic("news", "n1");
    await flush();
    expect(sink.received).toEqual(["alerts:a1", "news:n1"]);

    await wake(client, session, store);

    await api.broadcastTopic("alerts", "a2");
    await api.broadcastTopic("news", "n2");
    await flush();
    // Every returned capability rebound from the single re-run result.
    expect(sink.received).toEqual(["alerts:a1", "news:n1", "alerts:a2", "news:n2"]);
    // The non-capturing counter rebinds too — a fresh instance on the restored
    // Hub (a broken/disposed stub would throw here instead of returning 1).
    expect(await bundle.counter.bump()).toBe(1);
  });

  it("capabilities nested deep in objects AND arrays all survive a wake", async () => {
    const { store, client, session, api } = await connectHub();
    const sink = new RecordingSink();

    const tree = await api.issueNested(sink); // rooms[0..1].feed + admin.panel.audit
    expect(tree.rooms.length).toBe(2);
    for (const t of ["room-0", "room-1", "audit"]) await api.broadcastTopic(t, "x");
    await flush();
    expect(sink.received).toEqual(["room-0:x", "room-1:x", "audit:x"]);

    await wake(client, session, store);

    for (const t of ["room-0", "room-1", "audit"]) await api.broadcastTopic(t, "y");
    await flush();
    expect(sink.received).toEqual([
      "room-0:x", "room-1:x", "audit:x",
      "room-0:y", "room-1:y", "audit:y",
    ]);
  });

  it("disposing one of several restored capabilities leaves the others subscribed", async () => {
    const { store, client, session, api } = await connectHub();
    const sink = new RecordingSink();

    const tree = await api.issueNested(sink);
    await wake(client, session, store);

    // Each bound export must be independent: revoking room-0's feed must not
    // touch room-1 or audit (they are not aliases of one shared, disposed base).
    tree.rooms[0].feed[Symbol.dispose]();
    await flush();

    for (const t of ["room-0", "room-1", "audit"]) await api.broadcastTopic(t, "z");
    await flush();
    expect(sink.received).toEqual(["room-1:z", "audit:z"]); // room-0 silent
  });
});

describe("hibernatable importReplay: conditional / role-based capability issuance", () => {
  const ALL_TOPICS = ["read", "kick", "shutdown"] as const;

  /** Log in with a role, wake, then probe which capabilities are still live by
   *  broadcasting on every topic and seeing which reach the sink. `caps` stays
   *  referenced for the whole critical section, so the issued handles are held. */
  async function grantedAfterWake(role: "guest" | "moderator" | "admin") {
    const { store, client, session, api } = await connectHub();
    const sink = new RecordingSink();

    const caps = await api.login(role, sink);
    await wake(client, session, store);

    for (const t of ALL_TOPICS) await api.broadcastTopic(t, "ping");
    await flush();
    const granted = ALL_TOPICS.filter((t) => sink.received.includes(`${t}:ping`));
    return { granted, caps, store, client, session, api, sink };
  }

  it("a guest keeps ONLY its read capability after a wake (no privilege escalation)", async () => {
    const { granted } = await grantedAfterWake("guest");
    expect(granted).toEqual(["read"]);
  });

  it("a moderator keeps read + kick after a wake", async () => {
    const { granted } = await grantedAfterWake("moderator");
    expect(granted).toEqual(["read", "kick"]);
  });

  it("an admin keeps read + kick + shutdown after a wake", async () => {
    const { granted } = await grantedAfterWake("admin");
    expect(granted).toEqual(["read", "kick", "shutdown"]);
  });

  it("revoking one role capability after a wake leaves the others intact", async () => {
    const { store, client, session, api } = await connectHub();
    const sink = new RecordingSink();

    const caps = await api.login("admin", sink);
    await wake(client, session, store);

    caps.kick[Symbol.dispose](); // revoke kick only
    await flush();

    for (const t of ALL_TOPICS) await api.broadcastTopic(t, "ping");
    await flush();
    const granted = ALL_TOPICS.filter((t) => sink.received.includes(`${t}:ping`));
    expect(granted).toEqual(["read", "shutdown"]); // kick gone, others intact
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The built-in WebCrypto snapshot-security helper (lifted into the fork so
// consumers don't hand-roll AES-GCM). Sealing keyed from outside the snapshot
// store is the only thing that makes a forged/tampered snapshot unforgeable to
// a store-writer, so this is core to the fork.
// ───────────────────────────────────────────────────────────────────────────
describe("__experimental_newWebCryptoSnapshotSecurity", () => {
  const sec = __experimental_newWebCryptoSnapshotSecurity("a-high-entropy-secret");

  it("round-trips a sealed snapshot, and the plaintext is not on the wire", async () => {
    const env = await sec.seal({ plaintext: '{"secret":"hunter2"}', associatedData: "ctx" });
    expect(env.kind).toBe("encrypted");
    expect(env.alg).toBe("AES-GCM");
    expect(JSON.stringify(env)).not.toContain("hunter2"); // confidentiality
    expect(await sec.open({ envelope: env, associatedData: "ctx" })).toBe('{"secret":"hunter2"}');
  });

  it("rejects a tampered ciphertext (integrity)", async () => {
    const env = await sec.seal({ plaintext: "hello", associatedData: "ctx" });
    const flipped = (env.ciphertext[0] === "A" ? "B" : "A") + env.ciphertext.slice(1);
    await expect(sec.open({ envelope: { ...env, ciphertext: flipped }, associatedData: "ctx" }))
      .rejects.toThrow();
  });

  it("rejects an associatedData mismatch (context binding stops cross-session replay)", async () => {
    const env = await sec.seal({ plaintext: "hello", associatedData: "ctxA" });
    await expect(sec.open({ envelope: env, associatedData: "ctxB" })).rejects.toThrow();
  });

  it("defaults to required:true, and refuses an empty secret", () => {
    expect(sec.required).toBe(true);
    expect(__experimental_newWebCryptoSnapshotSecurity("x", { required: false }).required).toBe(false);
    expect(() => __experimental_newWebCryptoSnapshotSecurity("")).toThrow(/secret/i);
  });

  it("end-to-end: a session sealed with it survives a wake, and a tampered store entry is refused", async () => {
    const store = new CountingSessionStore();
    const { client, server } = createFakeWebSocketPair();
    const security = __experimental_newWebCryptoSnapshotSecurity("e2e-secret");
    const session = await __experimental_newHibernatableWebSocketRpcSession(
      server as unknown as WebSocket, new EchoTarget(),
      { sessionStore: store, snapshotSecurity: security, snapshotSecurityAssociatedData: { u: "1" } });
    if (!session) throw new Error("failed to create session");
    server.addEventListener("message", (e) => session.handleMessage(e.data));
    const api = newWebSocketRpcSession<EchoApi>(client as unknown as WebSocket);
    expect(await api.echo("hi")).toBe("hi");

    // The stored snapshot is an encrypted envelope, not plaintext.
    const stored = store.snapshots.get(session.sessionId) as any;
    expect(stored.kind).toBe("encrypted");

    // Tamper it; a fresh session restoring from the store must refuse it.
    stored.ciphertext = (stored.ciphertext[0] === "A" ? "B" : "A") + stored.ciphertext.slice(1);
    store.snapshots.set(session.sessionId, stored);
    const { server: server2 } = createFakeWebSocketPair();
    const restored = await __experimental_newHibernatableWebSocketRpcSession(
      server2 as unknown as WebSocket, new EchoTarget(),
      { sessionStore: store, sessionId: session.sessionId, snapshotSecurity: security, snapshotSecurityAssociatedData: { u: "1" } });
    expect(restored).toBeUndefined(); // tampered snapshot rejected, fail-closed
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Lazy provenance through a returned child capability.
//
// These tests distinguish capability depth from structured-result traversal.
// The first, shallower matrix is deliberately all green. The second adds the
// wire-level wrapper used by brokered systems such as Room Service and contains
// the red sibling-restoration requirement discovered in the real application
// topology.
// ───────────────────────────────────────────────────────────────────────────

class LayeredParticipant extends RpcTarget {
  readonly messages: string[] = [];
  onMessage(message: string): void {
    this.messages.push(message);
  }
}

class LayeredMetrics {
  trackedBundleCalls = 0;
  disposedGrandchildren: string[] = [];
}

class LayeredGrandchild extends RpcTarget {
  constructor(
      private readonly name: string,
      private readonly participant?: any,
      private readonly onDispose?: (name: string) => void) {
    super();
  }

  identify(): string {
    return this.name;
  }

  async notify(message: string): Promise<void> {
    await this.participant?.onMessage(message);
  }

  [Symbol.dispose](): void {
    this.onDispose?.(this.name);
  }
}

class LayeredChild extends RpcTarget {
  constructor(private readonly metrics = new LayeredMetrics()) {
    super();
  }

  direct(name: string): LayeredGrandchild {
    return new LayeredGrandchild(name);
  }

  record(name: string): { grandchild: LayeredGrandchild } {
    return { grandchild: new LayeredGrandchild(name) };
  }

  bundle(name: string): {
    first: LayeredGrandchild;
    second: LayeredGrandchild;
  } {
    return {
      first: new LayeredGrandchild(`${name}:first`),
      second: new LayeredGrandchild(`${name}:second`),
    };
  }

  bilateralBundle(name: string, participant: any): {
    first: LayeredGrandchild;
    second: LayeredGrandchild;
  } {
    const held = participant.dup();
    return {
      first: new LayeredGrandchild(`${name}:first`, held),
      second: new LayeredGrandchild(`${name}:second`),
    };
  }

  trackedBundle(name: string): {
    first: LayeredGrandchild;
    second: LayeredGrandchild;
  } {
    const occurrence = ++this.metrics.trackedBundleCalls;
    const trackDisposal = (disposedName: string) => {
      this.metrics.disposedGrandchildren.push(disposedName);
    };
    return {
      first: new LayeredGrandchild(
        `${name}#${occurrence}:first`, undefined, trackDisposal),
      second: new LayeredGrandchild(
        `${name}#${occurrence}:second`, undefined, trackDisposal),
    };
  }
}

class LayeredSurface extends RpcTarget {
  constructor(protected readonly metrics = new LayeredMetrics()) {
    super();
  }

  child(): LayeredChild {
    return new LayeredChild(this.metrics);
  }

  bundle(name: string): {
    first: LayeredGrandchild;
    second: LayeredGrandchild;
  } {
    return {
      first: new LayeredGrandchild(`${name}:first`),
      second: new LayeredGrandchild(`${name}:second`),
    };
  }
}

class LayeredApplication extends LayeredSurface {}

class LayeredRoot extends LayeredSurface {
  application(): LayeredApplication {
    return new LayeredApplication(this.metrics);
  }
}

async function connectLayered() {
  const store = new CountingSessionStore();
  const metrics = new LayeredMetrics();
  const { client, server } = createFakeWebSocketPair();
  const session = await __experimental_newHibernatableWebSocketRpcSession(
    server as unknown as WebSocket,
    new LayeredRoot(metrics),
    {
      sessionStore: store,
      codec: createCborCodec({
        stateful: true,
        optimizeEnvelope: true,
        structuredClone: true,
      }),
    },
  );
  if (!session) throw new Error("failed to create layered session");
  server.addEventListener("message", (event) => session.handleMessage(event.data));
  const api = newWebSocketRpcSession<LayeredRoot>(
    client as unknown as WebSocket,
    undefined,
    {
      codec: createCborCodec({
        stateful: true,
        optimizeEnvelope: true,
        structuredClone: true,
      }),
    },
  );
  return { api, client, metrics, session, store };
}

async function wakeLayered(
    client: FakeWebSocket,
    session: any,
    store: CountingSessionStore,
    metrics = new LayeredMetrics()) {
  const sessionId: string = session.sessionId;
  store.snapshots.set(sessionId, structuredClone(session.__experimental_snapshot()));

  const server = new FakeWebSocket();
  client.connect(server);
  server.connect(client);
  const restored = await __experimental_newHibernatableWebSocketRpcSession(
    server as unknown as WebSocket,
    new LayeredRoot(metrics),
    {
      sessionStore: store,
      sessionId,
      codec: createCborCodec({
        stateful: true,
        optimizeEnvelope: true,
        structuredClone: true,
      }),
    },
  );
  if (!restored) throw new Error("failed to restore layered session");
  server.addEventListener("message", (event) => restored.handleMessage(event.data));
  return restored;
}

describe("lazy restoration of grandchildren returned by a child capability", () => {
  it("restores a grandchild returned directly by a child", async () => {
    const { api, client, session, store } = await connectLayered();
    const child = await api.child();
    const grandchild = await child.direct("direct");
    expect(await grandchild.identify()).toBe("direct");

    await wakeLayered(client, session, store);

    expect(await grandchild.identify()).toBe("direct");
  });

  it("restores bundled children returned directly by the root", async () => {
    const { api, client, session, store } = await connectLayered();
    const bundle = await api.bundle("root");

    await wakeLayered(client, session, store);

    expect(await bundle.first.identify()).toBe("root:first");
    expect(await bundle.second.identify()).toBe("root:second");
  });

  it("restores one record-wrapped grandchild returned by a child", async () => {
    const { api, client, session, store } = await connectLayered();
    const child = await api.child();
    const result = await child.record("record");
    expect(await result.grandchild.identify()).toBe("record");

    await wakeLayered(client, session, store);

    // RED: lazy restoration maps into an asynchronously reconstructed child
    // result after the temporary base payload has already been disposed.
    expect(await result.grandchild.identify()).toBe("record");
  });

  it("restores every bundled grandchild returned by a child", async () => {
    const { api, client, session, store } = await connectLayered();
    const child = await api.child();
    const bundle = await child.bundle("child");

    await wakeLayered(client, session, store);

    // RED: multiplicity is not required to trigger the defect, but both saved
    // field paths must ultimately be rebound independently.
    expect(await bundle.first.identify()).toBe("child:first");
    expect(await bundle.second.identify()).toBe("child:second");
  });

  it("restores bundled grandchildren when the child call is bilateral", async () => {
    const { api, client, session, store } = await connectLayered();
    const child = await api.child();
    const participant = new LayeredParticipant();
    const bundle = await child.bilateralBundle("bilateral", participant);
    await bundle.first.notify("before");
    expect(participant.messages).toEqual(["before"]);

    await wakeLayered(client, session, store);

    expect(await bundle.first.identify()).toBe("bilateral:first");
    expect(await bundle.second.identify()).toBe("bilateral:second");
    await bundle.first.notify("after");
    expect(participant.messages).toEqual(["before", "after"]);
  });
});

describe("lazy restoration through a returned application root and child", () => {
  it("restores a capability returned directly by the application child", async () => {
    const { api, client, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const grandchild = await child.direct("deep-direct");

    await wakeLayered(client, session, store);

    expect(await grandchild.identify()).toBe("deep-direct");
  });

  it("restores bundled capabilities returned by the application root", async () => {
    const { api, client, session, store } = await connectLayered();
    const application = await api.application();
    const bundle = await application.bundle("application");

    await wakeLayered(client, session, store);

    expect(await bundle.first.identify()).toBe("application:first");
    expect(await bundle.second.identify()).toBe("application:second");
  });

  it("restores one record-wrapped capability returned by the application child", async () => {
    const { api, client, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const result = await child.record("deep-record");
    expect(await result.grandchild.identify()).toBe("deep-record");

    await wakeLayered(client, session, store);

    // A single mapped field at this depth remains a passing control.
    expect(await result.grandchild.identify()).toBe("deep-record");
  });

  it("restores the first deep bundled capability when used independently", async () => {
    const { api, client, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const bundle = await child.bundle("deep-first-only");

    await wakeLayered(client, session, store);

    expect(await bundle.first.identify()).toBe("deep-first-only:first");
  });

  it("restores the second deep bundled capability when used independently", async () => {
    const { api, client, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const bundle = await child.bundle("deep-second-only");

    await wakeLayered(client, session, store);

    expect(await bundle.second.identify()).toBe("deep-second-only:second");
  });

  it("restores every bundled capability returned by the application child", async () => {
    const { api, client, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const bundle = await child.bundle("deep-bundle");

    await wakeLayered(client, session, store);

    // RED: each field restores independently, but using the first sibling
    // disposes shared temporary state that the second sibling still needs.
    expect(await bundle.first.identify()).toBe("deep-bundle:first");
    expect(await bundle.second.identify()).toBe("deep-bundle:second");
  });

  it("restores the deep bundle when its child request is bilateral", async () => {
    const { api, client, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const participant = new LayeredParticipant();
    const bundle = await child.bilateralBundle("deep-bilateral", participant);
    await bundle.first.notify("before");
    expect(participant.messages).toEqual(["before"]);

    await wakeLayered(client, session, store);

    expect(await bundle.first.identify()).toBe("deep-bilateral:first");
    expect(await bundle.second.identify()).toBe("deep-bilateral:second");
    await bundle.first.notify("after");
    expect(participant.messages).toEqual(["before", "after"]);
  });
});

describe("lazy restoration retains only live export families", () => {
  it("omits a sibling released before hibernation and restores only the retained sibling", async () => {
    const { api, client, metrics, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const bundle = await child.trackedBundle("released-before");
    expect(metrics.trackedBundleCalls).toBe(1);

    const exportsBeforeRelease = session.__experimental_snapshot().exports.length;
    bundle.second[Symbol.dispose]();
    await flush();
    const exportsAfterRelease = session.__experimental_snapshot().exports.length;
    expect(exportsAfterRelease).toBe(exportsBeforeRelease - 1);

    const restored = await wakeLayered(client, session, store, metrics);

    expect(await bundle.first.identify()).toBe("released-before#2:first");
    expect(metrics.trackedBundleCalls).toBe(2);
    expect(restored.__experimental_snapshot().exports.length).toBe(exportsAfterRelease);
  });

  it("does not replay an entirely released family", async () => {
    const { api, client, metrics, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const bundle = await child.trackedBundle("fully-released");
    expect(metrics.trackedBundleCalls).toBe(1);

    const exportsBeforeRelease = session.__experimental_snapshot().exports.length;
    bundle.first[Symbol.dispose]();
    bundle.second[Symbol.dispose]();
    await flush();
    expect(session.__experimental_snapshot().exports.length).toBe(exportsBeforeRelease - 2);

    await wakeLayered(client, session, store, metrics);
    await flush();

    // No retained export requested the originating call, so waking alone must
    // not recreate the family or increment its method-call count.
    expect(metrics.trackedBundleCalls).toBe(1);
  });

  it("honors a sibling released after wake but before the family's first use", async () => {
    const { api, client, metrics, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const bundle = await child.trackedBundle("released-after-wake");

    const restored = await wakeLayered(client, session, store, metrics);
    const exportsBeforeRelease = restored.__experimental_snapshot().exports.length;
    bundle.second[Symbol.dispose]();
    await flush();
    expect(restored.__experimental_snapshot().exports.length).toBe(exportsBeforeRelease - 1);

    expect(await bundle.first.identify()).toBe("released-after-wake#2:first");
    expect(metrics.trackedBundleCalls).toBe(2);
  });

  it("keeps identical-looking call occurrences as distinct restoration families", async () => {
    const { api, client, metrics, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const firstCall = await child.trackedBundle("same-input");
    const secondCall = await child.trackedBundle("same-input");
    expect(metrics.trackedBundleCalls).toBe(2);

    await wakeLayered(client, session, store, metrics);

    expect(await firstCall.first.identify()).toBe("same-input#3:first");
    expect(metrics.trackedBundleCalls).toBe(3);
    expect(await secondCall.first.identify()).toBe("same-input#4:first");
    expect(metrics.trackedBundleCalls).toBe(4);
  });

  it("re-evaluates one retained family once rather than once per sibling", async () => {
    const { api, client, metrics, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const bundle = await child.trackedBundle("one-family");
    expect(metrics.trackedBundleCalls).toBe(1);

    await wakeLayered(client, session, store, metrics);

    expect(await bundle.first.identify()).toBe("one-family#2:first");
    expect(await bundle.second.identify()).toBe("one-family#2:second");
    expect(metrics.trackedBundleCalls).toBe(2);
  });

  it("keeps restored siblings alive until release, then disposes each exactly once", async () => {
    const { api, client, metrics, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const bundle = await child.trackedBundle("dispose-retained");

    await wakeLayered(client, session, store, metrics);
    expect(await bundle.first.identify()).toBe("dispose-retained#2:first");
    expect(await bundle.second.identify()).toBe("dispose-retained#2:second");
    await flush();

    const restoredDisposals = () => metrics.disposedGrandchildren.filter(
      name => name.startsWith("dispose-retained#2:"));
    expect(restoredDisposals()).toEqual([]);

    bundle.first[Symbol.dispose]();
    await flush();
    expect(restoredDisposals()).toEqual(["dispose-retained#2:first"]);

    bundle.second[Symbol.dispose]();
    await flush();
    expect(restoredDisposals()).toEqual([
      "dispose-retained#2:first",
      "dispose-retained#2:second",
    ]);
  });

  it("disposes an unretained replay sibling when the temporary result settles", async () => {
    const { api, client, metrics, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const bundle = await child.trackedBundle("dispose-unretained");
    bundle.second[Symbol.dispose]();
    await flush();

    await wakeLayered(client, session, store, metrics);
    expect(await bundle.first.identify()).toBe("dispose-unretained#2:first");
    await flush();

    const restoredDisposals = () => metrics.disposedGrandchildren.filter(
      name => name.startsWith("dispose-unretained#2:"));
    expect(restoredDisposals()).toEqual(["dispose-unretained#2:second"]);

    bundle.first[Symbol.dispose]();
    await flush();
    expect(restoredDisposals()).toEqual([
      "dispose-unretained#2:second",
      "dispose-unretained#2:first",
    ]);
  });

  it("preserves released-sibling selectivity across repeated hibernations", async () => {
    const { api, client, metrics, session, store } = await connectLayered();
    const application = await api.application();
    const child = await application.child();
    const bundle = await child.trackedBundle("repeated-wake");
    bundle.second[Symbol.dispose]();
    await flush();

    const firstRestore = await wakeLayered(client, session, store, metrics);
    expect(await bundle.first.identify()).toBe("repeated-wake#2:first");
    const selectedExportCount = firstRestore.__experimental_snapshot().exports.length;

    const secondRestore = await wakeLayered(client, firstRestore, store, metrics);
    expect(await bundle.first.identify()).toBe("repeated-wake#3:first");
    expect(secondRestore.__experimental_snapshot().exports.length).toBe(selectedExportCount);
    expect(metrics.trackedBundleCalls).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG — FIXED via snapshot `positiveBases` (see below). Diagnosis kept for history.
// ═══════════════════════════════════════════════════════════════════════════
//
// SYMPTOM (production): the user-hub Durable Object closes the WebSocket with
// `1011 "stale session"` on a hibernation WAKE — e.g. saving an avatar wakes the
// hibernated DO, the wake restore fails, the socket closes.
//
// SHAPE that triggers it: a CAPTURING call made on a NESTED, PIPELINED
// capability. Concretely `cap.persona().avatar(writer)`:
//   1. `persona()` is a call RESULT → a transient POSITIVE export on the server.
//   2. `avatar(writer)` captures a client export (the writer) → capnweb records
//      an `importReplay` whose call BASE is `["pipeline", <positive persona
//      export>, ["avatar"], [writer]]`.
//   3. The snapshot serializer (`rpc.ts` `__experimental_snapshot`, the
//      `if (id >= 0) continue` guard) serializes ONLY NEGATIVE exports. Positive
//      call-result exports are dropped — they're meant to be transient.
//   4. On wake, `restoreFromSnapshot` evaluates each importReplay's expr. The
//      avatar replay's base references that dropped positive export →
//      `getExport(N)` returns undefined → serialize.ts throws "no such entry on
//      exports table: N" → caught in hibernation.ts → close `1011 stale session`.
//
// WHY THE EXISTING NESTED TESTS PASS (the suite above): every one of them makes
// the capturing call directly on the MAIN cap — `api.subscribe(sink)`,
// `api.subscribeNested(sink)`, `api.issueAll(sink)`, etc. Their base is import 0
// / export 0 (the bootstrap), which is ALWAYS present after restore. "Nested" in
// those tests means the RETURNED capability is nested in objects/arrays — NOT
// that the CALL is made on a nested (call-result) capability. None of them
// exercise a capturing call whose base is a pipelined positive export, which is
// exactly the gap.
//
// CONTROLS BELOW pinned the cause (pre-fix outcomes shown; all are green now):
//   REPRO (nested persona().avatar(writer), capturing)  → FAILED (positive base dropped)
//   A (hold persona+files only, no stream)               → OK     (no importReplay at all)
//   B (nested stream, NO dup)                             → FAILED (dup is NOT the cause —
//                                                                   the writer is still an arg, so the
//                                                                   importReplay + positive base still exist;
//                                                                   dup only shifts timing)
//   C (capturing stream FLAT on main, with dup)          → OK     (base = export 0)
//   D (nested, but AWAIT persona() first)                → OK     (base RESOLVES to a durable NEGATIVE
//                                                                   export, which IS snapshotted with provenance)
//
// TIMING CAVEAT: REPRO/B are timing-sensitive — they race `persona()` resolution
// against when the snapshot is captured (and leaked sessions from earlier tests
// perturb that timing in this file). The DETERMINISTIC signals are C and D
// (always green) plus the code path itself. When implementing the fix, make
// REPRO deterministically green and consider isolating/closing sessions between
// tests to remove the race.
//
// THE FIX (implemented — the "resolve at snapshot time" variant): when a replay
// is recorded, every positive pipeline base its expression references is noted
// in `replayBaseExprs` (id → the base's own originating push expression,
// transitively, deduplicated). The snapshot serializes these as
// `positiveBases`; restore re-evaluates them in ascending id order BEFORE the
// replays run, re-creating the transient entries the replays pipeline off.
// Bases the peer had already released (refcount 0) exist only for the duration
// of replay evaluation and are disposed immediately after; bases with an
// in-flight pull get the pull re-triggered. This covers both the
// resolved-before-snapshot and never-resolved cases, with no path bookkeeping.
// REPRO and control B below are green as a result; the rewrite-at-resolve-time
// alternative was not needed.
//
// APP-SIDE UNBLOCK already shipped: user-hub `await`s `cap.persona()` / `cap.files()`
// so the stream base is a negative export from the start (control D). That keeps
// production working; this capnweb fix removes the foot-gun so a *pipelined* base
// survives too.
// ═══════════════════════════════════════════════════════════════════════════
describe("held nested applet capabilities + avatar stream survive a wake", () => {
  class WriterTarget extends RpcTarget {
    readonly writes: string[] = [];
    begin() {}
    write(v: string) {
      this.writes.push(v);
    }
    commit() {}
  }
  class Subscription extends RpcTarget {
    constructor(private readonly teardown: () => void) {
      super();
    }
    [Symbol.dispose]() {
      this.teardown();
    }
  }
  class PersonaTarget extends RpcTarget {
    // collection-sync stream(): dup the client writer (params are disposed on
    // return), hold the dup in the Subscription's teardown.
    avatar(writer: any): Subscription {
      const duped = writer.dup();
      return new Subscription(() => {
        duped[Symbol.dispose]();
      });
    }
  }
  class FilesTarget extends RpcTarget {
    ping(): string {
      return "files";
    }
  }
  class MainTarget extends RpcTarget {
    #persona?: PersonaTarget;
    #files?: FilesTarget;
    persona(): PersonaTarget {
      return (this.#persona ??= new PersonaTarget());
    }
    files(): FilesTarget {
      return (this.#files ??= new FilesTarget());
    }
  }
  // Variant where avatar does NOT dup the writer (isolates whether dup is the cause).
  class PersonaNoDupTarget extends RpcTarget {
    avatar(_writer: any): Subscription {
      return new Subscription(() => {});
    }
  }
  class MainNoDupTarget extends RpcTarget {
    #persona?: PersonaNoDupTarget;
    #files?: FilesTarget;
    persona() {
      return (this.#persona ??= new PersonaNoDupTarget());
    }
    files() {
      return (this.#files ??= new FilesTarget());
    }
  }
  // Variant where avatar is on the MAIN cap directly (isolates whether the
  // persona NESTING is the cause).
  class MainFlatTarget extends RpcTarget {
    #files?: FilesTarget;
    avatar(writer: any): Subscription {
      const duped = writer.dup();
      return new Subscription(() => duped[Symbol.dispose]());
    }
    files() {
      return (this.#files ??= new FilesTarget());
    }
  }

  // Connect, run `exercise` (which retains stubs in `held`), snapshot, then WAKE
  // from the snapshot in a fresh server session. Returns the wake outcome.
  async function runWake(
    makeMain: () => RpcTarget,
    exercise: (api: any, held: unknown[]) => Promise<void>,
  ): Promise<{ ok: boolean; reason: string }> {
    const store = new CountingSessionStore();
    const security = __experimental_newWebCryptoSnapshotSecurity("held-caps-secret");
    const assoc = { userId: "u1" };
    const { client, server } = createFakeWebSocketPair();
    const session = await __experimental_newHibernatableWebSocketRpcSession(
      server as unknown as WebSocket,
      makeMain(),
      { sessionStore: store, snapshotSecurity: security, snapshotSecurityAssociatedData: assoc },
    );
    if (!session) throw new Error("failed to create session");
    server.addEventListener("message", (e) => session.handleMessage(e.data));
    const api = newWebSocketRpcSession<any>(client as unknown as WebSocket);
    const held: unknown[] = [];
    await exercise(api, held);
    await new Promise((r) => setTimeout(r, 0));
    expect(store.snapshots.has(session.sessionId)).toBe(true);
    const { server: server2 } = createFakeWebSocketPair();
    const restored = await __experimental_newHibernatableWebSocketRpcSession(
      server2 as unknown as WebSocket,
      makeMain(),
      {
        sessionStore: store,
        sessionId: session.sessionId,
        snapshotSecurity: security,
        snapshotSecurityAssociatedData: assoc,
      },
    );
    void held; // keep stubs referenced through the wake
    return { ok: !!restored, reason: server2.closeReason };
  }

  it("REPRO — nested persona().avatar(writer) with dup, persona+files+sub held", async () => {
    const r = await runWake(() => new MainTarget(), async (api, held) => {
      const persona = api.persona();
      const files = api.files();
      held.push(persona, files, await persona.avatar(new WriterTarget()));
    });
    console.log("[REPRO]", r.ok ? "OK" : `CLOSED "${r.reason}"`);
    expect(r.reason).not.toBe("stale session");
    expect(r.ok).toBe(true);
  });

  it("control A — hold persona + files only, NO avatar stream", async () => {
    const r = await runWake(() => new MainTarget(), async (api, held) => {
      held.push(api.persona(), api.files());
    });
    console.log("[A no-stream]", r.ok ? "OK" : `CLOSED "${r.reason}"`);
  });

  it("control B — nested avatar stream WITHOUT writer.dup()", async () => {
    const r = await runWake(() => new MainNoDupTarget(), async (api, held) => {
      const persona = api.persona();
      held.push(persona, api.files(), await persona.avatar(new WriterTarget()));
    });
    console.log("[B no-dup]", r.ok ? "OK" : `CLOSED "${r.reason}"`);
  });

  it("control C — avatar stream WITH dup but NO persona nesting (flat on main)", async () => {
    const r = await runWake(() => new MainFlatTarget(), async (api, held) => {
      held.push(api.files(), await api.avatar(new WriterTarget()));
    });
    console.log("[C flat-dup]", r.ok ? "OK" : `CLOSED "${r.reason}"`);
  });

  it("control D — nested+dup but AWAIT persona() first (base resolves to a NEGATIVE export)", async () => {
    const r = await runWake(() => new MainTarget(), async (api, held) => {
      const persona = await api.persona(); // AWAIT → persona settles to a negative export
      held.push(persona, api.files(), await persona.avatar(new WriterTarget()));
    });
    console.log("[D await-persona]", r.ok ? "OK" : `CLOSED "${r.reason}"`);
  });
});
