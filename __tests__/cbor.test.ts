// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { expect, it, describe } from "vitest";
import { RpcSession, RpcTarget, type RpcTransport } from "../src/index.js";
import { createCborCodec } from "../src/codec/cbor/index.js";

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
