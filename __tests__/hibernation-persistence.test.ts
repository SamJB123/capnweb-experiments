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
