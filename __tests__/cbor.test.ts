// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { expect, it, describe } from "vitest";
import { RpcSession, RpcTarget, type RpcTransport } from "../src/index.js";
import { createCborCodec } from "../src/codec/cbor/index.js";
import type { Codec } from "../src/codec/index.js";

// ---------------------------------------------------------------------------
// Codec-level round-trip: encode then decode must reproduce the devalued message.
// ---------------------------------------------------------------------------

describe("CBOR codec round-trip", () => {
  const codec = createCborCodec();

  const cases: Record<string, unknown> = {
    "rpc push message": ["push", 1, ["pipeline", 0, ["greet"], [["world"]]]],
    "primitives": [1, -2, 3.5, 0, true, false, null, "str", ""],
    "nested structures": { a: { b: [1, [2, [3]]] }, c: null, d: [] },
    "empty containers": [[], {}],
    "unicode + escapes": "héllo 🌍 \" \\ \n\t",
    "large int ids": ["release", -2147483, 7],
  };

  for (const [name, value] of Object.entries(cases)) {
    it(`round-trips ${name}`, () => {
      const wire = codec.encode(value);
      expect(wire).toBeInstanceOf(Uint8Array);
      expect(codec.decode(wire)).toEqual(value);
    });
  }

  it("produces the same logical value as JSON but different bytes", () => {
    const value = ["push", 1, ["pipeline", 0, ["greet"], [["world"]]]];
    const cbor = codec.encode(value) as Uint8Array;
    const json = new TextEncoder().encode(JSON.stringify(value));
    // Same meaning...
    expect(codec.decode(cbor)).toEqual(JSON.parse(new TextDecoder().decode(json)));
    // ...different wire bytes (proving CBOR is actually in use, not JSON).
    expect(Buffer.from(cbor).equals(Buffer.from(json))).toBe(false);
  });

  it("is stateless: independent encoders agree, and order doesn't matter", () => {
    const a = createCborCodec();
    const b = createCborCodec();
    const m1 = ["push", 1, { shape: "x" }];
    const m2 = ["push", 2, { shape: "x" }];
    // b decodes a's second message without ever having seen a's first — proving
    // no cross-message structure state is required.
    expect(b.decode(a.encode(m2))).toEqual(m2);
    expect(b.decode(a.encode(m1))).toEqual(m1);
  });

  it("rejects a text frame (codec mismatch is loud)", () => {
    expect(() => codec.decode("[\"push\",1]")).toThrow(/text frame/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a connected session pair using the CBOR codec on both ends. This
// exercises the binary transport path widened in step 2.
// ---------------------------------------------------------------------------

/** Minimal in-memory transport that carries string | Uint8Array between a pair. */
class PairTransport implements RpcTransport {
  partner!: PairTransport;
  sawBinary = false;
  private queue: (string | Uint8Array)[] = [];
  private waiter?: () => void;
  private error?: any;

  async send(message: string | Uint8Array): Promise<void> {
    if (typeof message !== "string") this.partner.sawBinary = true;
    this.partner.queue.push(message);
    this.partner.waiter?.();
    this.partner.waiter = undefined;
  }

  async receive(): Promise<string | Uint8Array> {
    while (this.queue.length === 0) {
      if (this.error) throw this.error;
      await new Promise<void>(resolve => { this.waiter = resolve; });
    }
    return this.queue.shift()!;
  }

  abort(reason: any): void {
    this.error = reason;
    this.waiter?.();
    this.waiter = undefined;
  }
}

function makePair(): [PairTransport, PairTransport] {
  const a = new PairTransport();
  const b = new PairTransport();
  a.partner = b;
  b.partner = a;
  return [a, b];
}

class TestApi extends RpcTarget {
  async add(a: number, b: number) { return a + b; }
  async greet(name: string) { return `hello ${name}`; }
  async echo(value: unknown) { return value; }
}

describe("CBOR codec over an RPC session", () => {
  it("makes calls end-to-end and actually sends binary frames", async () => {
    const codec = createCborCodec();
    const [clientTransport, serverTransport] = makePair();

    const server = new RpcSession(serverTransport, new TestApi(), { codec });
    const client = new RpcSession<TestApi>(clientTransport, undefined, { codec });
    using stub = client.getRemoteMain();

    expect(await stub.add(2, 3)).toBe(5);
    expect(await stub.greet("world")).toBe("hello world");
    expect(await stub.echo({ a: [1, 2, 3], b: "x", c: null, d: true }))
      .toEqual({ a: [1, 2, 3], b: "x", c: null, d: true });

    // Confirm the session really used binary frames (not a silent JSON fallback).
    expect(clientTransport.sawBinary).toBe(true);
    expect(serverTransport.sawBinary).toBe(true);

    void server;
  });

  it("supports promise pipelining over CBOR", async () => {
    const codec = createCborCodec();
    const [clientTransport, serverTransport] = makePair();

    class Pipelined extends RpcTarget {
      async getApi() { return new TestApi(); }
    }

    const server = new RpcSession(serverTransport, new Pipelined(), { codec });
    const client = new RpcSession<Pipelined>(clientTransport, undefined, { codec });
    using stub = client.getRemoteMain();

    // Pipeline a call on the result of a call without awaiting in between.
    using api = stub.getApi();
    expect(await api.add(40, 2)).toBe(42);

    void server;
  });
});

// ---------------------------------------------------------------------------
// Mechanism: a stateful codec's state rides the session snapshot and is restored
// on resume. This is codec-agnostic — proven here with a controlled test codec.
// ---------------------------------------------------------------------------

/** JSON passthrough plus observable, snapshottable state (count of encodes). */
class CountingCodec implements Codec {
  readonly id = "counting";
  encodeCount = 0;
  restoredWith: unknown = undefined;

  encode(message: unknown): string {
    this.encodeCount++;
    return JSON.stringify(message);
  }
  decode(wire: string | Uint8Array): unknown {
    return JSON.parse(typeof wire === "string" ? wire : new TextDecoder().decode(wire));
  }
  snapshotState() {
    return { encodeCount: this.encodeCount };
  }
  restoreState(state: unknown) {
    this.restoredWith = state;
    this.encodeCount = (state as { encodeCount: number }).encodeCount;
  }
}

describe("codec state survives the session snapshot (mechanism)", () => {
  it("captures stateful codec state at version 3 and restores it on a new session", async () => {
    const serverCodec = new CountingCodec();
    const [clientTransport, serverTransport] = makePair();
    const server = new RpcSession(serverTransport, new TestApi(), { codec: serverCodec });
    const client = new RpcSession<TestApi>(clientTransport, undefined, { codec: new CountingCodec() });
    using stub = client.getRemoteMain();

    // Drive some traffic so the server codec accumulates state.
    expect(await stub.add(2, 3)).toBe(5);
    expect(serverCodec.encodeCount).toBeGreaterThan(0);

    const snap = server.__experimental_snapshot();
    expect(snap.version).toBe(3);
    expect(snap.codec?.id).toBe("counting");
    expect((snap.codec?.state as { encodeCount: number }).encodeCount).toBe(serverCodec.encodeCount);

    // Simulate hibernation: rebuild the server from the snapshot with a fresh codec instance.
    const resumedCodec = new CountingCodec();
    const [, serverTransport2] = makePair();
    const resumed = new RpcSession(serverTransport2, new TestApi(), {
      codec: resumedCodec,
      __experimental_restoreSnapshot: snap,
    });

    // The fresh codec was rehydrated from the snapshot before the read loop ran.
    expect(resumedCodec.restoredWith).toEqual(snap.codec?.state);
    expect(resumedCodec.encodeCount).toBe(serverCodec.encodeCount);
    void resumed;
  });

  it("omits codec state (stays version 2) for a stateless codec", async () => {
    const [clientTransport, serverTransport] = makePair();
    // Default JSON codec has no snapshotState.
    const server = new RpcSession(serverTransport, new TestApi());
    const client = new RpcSession<TestApi>(clientTransport);
    using stub = client.getRemoteMain();
    expect(await stub.add(1, 1)).toBe(2);

    const snap = server.__experimental_snapshot();
    expect(snap.version).toBe(2);
    expect(snap.codec).toBeUndefined();
  });

  it("rejects restoring codec state into a session with a different codec", () => {
    const [, serverTransport] = makePair();
    const snap = {
      version: 3 as const,
      nextExportId: -1,
      exports: [],
      codec: { id: "counting", state: { encodeCount: 5 } },
    };
    // Resume with a DIFFERENT codec id -> must throw.
    expect(() => new RpcSession(serverTransport, new TestApi(), {
      codec: createCborCodec(),
      __experimental_restoreSnapshot: snap,
    })).toThrow(/codec mismatch/);
  });
});

// ---------------------------------------------------------------------------
// Stateful CBOR codec (sequential mode): cross-message structure sharing, and
// surviving hibernation by snapshotting the decoder structure table.
// ---------------------------------------------------------------------------

describe("stateful CBOR codec (sequential mode)", () => {
  it("uses distinct ids for stateless vs stateful", () => {
    expect(createCborCodec().id).toBe("cbor");
    expect(createCborCodec({ stateful: true }).id).toBe("cbor-sequential");
  });

  it("makes calls end-to-end in sequential mode (repeated shapes included)", async () => {
    const [clientTransport, serverTransport] = makePair();
    const server = new RpcSession(serverTransport, new TestApi(), { codec: createCborCodec({ stateful: true }) });
    const client = new RpcSession<TestApi>(clientTransport, undefined, { codec: createCborCodec({ stateful: true }) });
    using stub = client.getRemoteMain();

    expect(await stub.add(2, 3)).toBe(5);
    expect(await stub.greet("world")).toBe("hello world");
    // Repeated message shapes — exercises cross-message structure references.
    expect(await stub.greet("mars")).toBe("hello mars");
    expect(await stub.echo({ a: [1, 2, 3], b: "x" })).toEqual({ a: [1, 2, 3], b: "x" });
    void server;
  });

  it("shares structures across messages (later messages are smaller)", () => {
    const codec = createCborCodec({ stateful: true });
    const m1 = ["push", 1, { method: "greet", args: ["world"] }];
    const m2 = ["push", 2, { method: "greet", args: ["mars"] }];
    const w1 = codec.encode(m1) as Uint8Array;
    const w2 = codec.encode(m2) as Uint8Array;
    expect(w2.byteLength).toBeLessThan(w1.byteLength);
  });

  it("a fresh stateful decoder cannot decode a mid-stream reference (so state matters)", () => {
    const a = createCborCodec({ stateful: true });
    const b = createCborCodec({ stateful: true });
    const m1 = ["push", 1, { method: "greet", args: ["world"] }];
    const m2 = ["push", 2, { method: "greet", args: ["mars"] }];
    expect(b.decode(a.encode(m1))).toEqual(m1);
    const w2 = a.encode(m2); // references the shape defined in m1, by id

    const fresh = createCborCodec({ stateful: true });
    let matched = false;
    try { matched = JSON.stringify(fresh.decode(w2)) === JSON.stringify(m2); } catch { matched = false; }
    expect(matched).toBe(false);
  });

  it("decoder structures survive snapshot/restore, staying in sync with a non-reset peer", () => {
    const a = createCborCodec({ stateful: true }); // peer — never hibernates
    const b = createCborCodec({ stateful: true }); // hibernates

    const m1 = ["push", 1, { method: "greet", args: ["world"] }];
    const m2 = ["push", 2, { method: "greet", args: ["mars"] }];
    expect(b.decode(a.encode(m1))).toEqual(m1);
    expect(b.decode(a.encode(m2))).toEqual(m2);

    // B hibernates: snapshot its codec state, rebuild a fresh codec, restore.
    const snap = b.snapshotState!();
    const bResumed = createCborCodec({ stateful: true });
    bResumed.restoreState!(snap);

    // A (never reset) sends a definition-less reference to the shared shape.
    const m3 = ["push", 3, { method: "greet", args: ["pluto"] }];
    expect(bResumed.decode(a.encode(m3))).toEqual(m3);
  });

  it("a stateful session captures codec structures in its snapshot (4a + 4b)", async () => {
    const serverCodec = createCborCodec({ stateful: true });
    const [clientTransport, serverTransport] = makePair();
    const server = new RpcSession(serverTransport, new TestApi(), { codec: serverCodec });
    const client = new RpcSession<TestApi>(clientTransport, undefined, { codec: createCborCodec({ stateful: true }) });
    using stub = client.getRemoteMain();
    // Pass object-shaped args so cbor-x forms record structures (the protocol
    // envelope itself is array-based and produces none). The server's decoder
    // learns the {a,b} shape from these inbound call args.
    await stub.echo({ a: 1, b: 2 });
    await stub.echo({ a: 3, b: 4 });

    const snap = server.__experimental_snapshot();
    expect(snap.version).toBe(3);
    expect(snap.codec?.id).toBe("cbor-sequential");
    const structures = (snap.codec!.state as { decoderStructures: unknown[] }).decoderStructures;
    expect(Array.isArray(structures)).toBe(true);
    expect(structures.length).toBeGreaterThan(0); // learned the {a,b} object shape
  });
});

// ---------------------------------------------------------------------------
// Envelope optimization: reshape string-headed protocol arrays into tagged maps
// so cbor-x can share the tag/method keys. Must be a faithful bijection that
// NEVER lets user data be decoded as a protocol token.
// ---------------------------------------------------------------------------

describe("envelope optimization (array→object via private CBOR tag)", () => {
  const mk = () => createCborCodec({ stateful: true, optimizeEnvelope: true });

  it("uses a distinct id so the snapshot guard catches a mismatch", () => {
    expect(mk().id).toBe("cbor-sequential-proto");
    expect(createCborCodec({ optimizeEnvelope: true }).id).toBe("cbor-proto");
  });

  // --- faithful bijection across representative protocol shapes ---
  const cases: Record<string, unknown> = {
    "push w/ pipeline + bytes": ["push", 1, ["pipeline", -3, ["setPose"], [["bytes", "Kv0AAPYDfwA"]]]],
    "release": ["release", 5, 1],
    "resolve w/ object arg": ["resolve", -2, { a: 1, b: [2, 3] }],
    "numeric path element": ["pipeline", 3, [0, "x"], [[1, 2, 3]]],
    "error w/ own props": ["push", 1, ["error", "TypeError", "boom", null, { code: 5 }]],
    "undefined token": ["push", 1, ["undefined"]],
    "empty + nested arrays": ["push", 7, [[]]],
    "headers-like (string-keyed pairs)": ["resolve", -1, ["headers", [["x-a", "1"], ["x-b", "2"]]]],
  };
  for (const [name, msg] of Object.entries(cases)) {
    it(`round-trips ${name}`, () => {
      const c = mk();
      expect(c.decode(c.encode(msg))).toEqual(msg);
    });
  }

  // --- SECURITY: user data shaped like tokens must never decode as a token ---
  describe("does not let user data bleed into the protocol envelope", () => {
    it("a user object whose keys look like tags stays an object", () => {
      const c = mk();
      const msg = ["push", 1, { push: [99], pipeline: [1, 2], export: [5] }];
      const back = c.decode(c.encode(msg)) as unknown[];
      expect(back).toEqual(msg);
      expect(Array.isArray(back[2])).toBe(false); // still an object, not ["push",99,…]
      expect(back[2]).toEqual({ push: [99], pipeline: [1, 2], export: [5] });
    });

    it("deeply nested token-shaped user objects stay objects", () => {
      const c = mk();
      const msg = ["resolve", -1, { a: { pipeline: { export: [1] } }, b: [{ push: [2] }] }];
      const back = c.decode(c.encode(msg)) as unknown[];
      expect(back).toEqual(msg);
      expect(Array.isArray((back[2] as any).a)).toBe(false);
      expect(Array.isArray((back[2] as any).a.pipeline)).toBe(false);
    });

    it("an escaped user array of strings round-trips exactly (never a token)", () => {
      const c = mk();
      // [["pipeline","evil"]] is capnweb's escape of the USER array ["pipeline","evil"].
      const msg = ["push", 1, [["pipeline", "evil"]]];
      const back = c.decode(c.encode(msg)) as unknown[];
      expect(back).toEqual(msg);
      // The arg is the escaped wrapper (array of one array), not a token.
      expect(Array.isArray(back[2])).toBe(true);
      expect(back[2]).toEqual([["pipeline", "evil"]]);
    });

    it("a bare user object identical to a token shape decodes to an object", () => {
      const c = mk();
      const userObj = { export: [1, 2, 3] };
      const back = c.decode(c.encode(["resolve", -1, userObj])) as unknown[];
      expect(back[2]).toEqual(userObj);
      expect(Array.isArray(back[2])).toBe(false);
    });
  });

  // --- the actual win: shared tag keys make warm messages smaller ---
  it("after warmup, optimized messages are smaller than the plain sequential form", () => {
    const plain = createCborCodec({ stateful: true });
    const opt = createCborCodec({ stateful: true, optimizeEnvelope: true });
    let plainSize = 0;
    let optSize = 0;
    for (let i = 0; i < 6; i++) {
      const m = ["push", i, ["pipeline", -3, ["setPose"], [["bytes", "Kv0AAPYDfwA"]]]];
      plainSize = (plain.encode(m) as Uint8Array).byteLength;
      optSize = (opt.encode(m) as Uint8Array).byteLength;
    }
    expect(optSize).toBeLessThan(plainSize);
  });

  // --- end-to-end over a real session, including a token-shaped object arg ---
  it("works end-to-end over an RPC session", async () => {
    const [clientTransport, serverTransport] = makePair();
    const server = new RpcSession(serverTransport, new TestApi(), { codec: mk() });
    const client = new RpcSession<TestApi>(clientTransport, undefined, { codec: mk() });
    using stub = client.getRemoteMain();

    expect(await stub.add(2, 3)).toBe(5);
    expect(await stub.greet("world")).toBe("hello world");
    // A token-shaped object argument must survive as an object end-to-end.
    expect(await stub.echo({ push: [1], pipeline: [2] })).toEqual({ push: [1], pipeline: [2] });
    void server;
  });

  // --- composes with the hibernation snapshot mechanism ---
  it("snapshots codec state with envelope optimization (id reflects the mode)", async () => {
    const serverCodec = mk();
    const [clientTransport, serverTransport] = makePair();
    const server = new RpcSession(serverTransport, new TestApi(), { codec: serverCodec });
    const client = new RpcSession<TestApi>(clientTransport, undefined, { codec: mk() });
    using stub = client.getRemoteMain();
    await stub.echo({ a: 1, b: 2 });

    const snap = server.__experimental_snapshot();
    expect(snap.version).toBe(3);
    expect(snap.codec?.id).toBe("cbor-sequential-proto");
    void server;
  });
});
