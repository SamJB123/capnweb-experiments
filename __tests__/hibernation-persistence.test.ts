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
