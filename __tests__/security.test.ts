// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// ════════════════════════════════════════════════════════════════════════════
// Adversarial / white-hat security suite.
//
// These tests do NOT use the typed client (which would never *emit* an attack).
// Instead they drive a real server `RpcSession` with raw, hand-crafted, hostile
// wire frames — exactly what a malicious peer can put on the socket — and assert
// the SECURE outcome. A genuine hole therefore shows up as a failing test, not as
// a comment we have to trust.
//
// Two threat models:
//   A. A malicious *peer over the connection* (the realistic remote attacker).
//   B. A *tampered hibernation snapshot* (gated behind storage-write access).
//
// Wire facts (captured empirically against this build):
//   • A method call is `["push", id, ["pipeline", 0, ["method"], [args]]]` then
//     `["pull", id]`; the server's main is addressed as export `0`.
//   • Token-shaped data (e.g. `["export",-1]`) passed as data is ESCAPED on the
//     wire by wrapping each array one level deeper: `[["export",-1]]`.
//   • Secure reactions come in three flavours, all acceptable: a per-call
//     `reject` (session survives), a full session `abort` (fail-closed), or a
//     silent ignore (session survives). None may leak, pollute, or hijack.
// ════════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import {
  RpcTarget,
  RpcSession,
  __experimental_newHibernatableWebSocketRpcSession,
  type RpcTransport,
  type HibernatableSnapshotSecurity,
  type HibernatableSessionStore,
  type HibernatableStoredSnapshot,
} from "../src/index.js";

// ── harness ─────────────────────────────────────────────────────────────────

/** Let queued message deliveries (and chained microtasks) fully drain. */
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0)); };

/**
 * A transport we fully control on the attacker's side. `feed` injects raw frames
 * into a server session; `send` records the server's replies. Helpers classify
 * the response (aborted / resolved / rejected) for assertions.
 */
class Evil implements RpcTransport {
  readonly sent: string[] = [];
  abortCalled = false;
  private q: string[] = [];
  private waiter?: () => void;

  /** Queue raw frames (objects are JSON-stringified; strings sent verbatim, so
   *  we can inject deliberately malformed text too). */
  feed(...frames: unknown[]) {
    for (const f of frames) this.q.push(typeof f === "string" ? f : JSON.stringify(f));
    const w = this.waiter; this.waiter = undefined; w?.();
  }

  async send(m: string): Promise<void> { this.sent.push(m); }
  async receive(): Promise<string> {
    while (this.q.length === 0) await new Promise<void>(r => (this.waiter = r));
    return this.q.shift()!;
  }
  abort(_reason: unknown): void { this.abortCalled = true; }

  private parsed(): any[] {
    return this.sent.flatMap(s => { try { return [JSON.parse(s)]; } catch { return []; } });
  }
  aborted(): boolean { return this.abortCalled || this.parsed().some(f => Array.isArray(f) && f[0] === "abort"); }
  resolveOf(id: number): unknown { const f = this.parsed().find(f => f[0] === "resolve" && f[1] === id); return f ? f[2] : undefined; }
  rejectMsg(id: number): string | undefined {
    const f = this.parsed().find(f => f[0] === "reject" && f[1] === id);
    return f && Array.isArray(f[2]) ? String(f[2][2] ?? "") : undefined;
  }
  anyResolve(): boolean { return this.parsed().some(f => f[0] === "resolve"); }
  text(): string { return this.sent.join("\n"); }
}

/** Build a server session driven by a hostile transport. */
function server(target: RpcTarget, options?: unknown) {
  const t = new Evil();
  const sess = new RpcSession(t as unknown as RpcTransport, target, options as any);
  return { t, sess };
}

/** Frames for a method CALL on the main capability. */
const call = (id: number, path: (string | number)[], args: unknown[] = []) =>
  [["push", id, ["pipeline", 0, path, args]], ["pull", id]];
/** Frames for a property GET (pipeline with no args slot). */
const get = (id: number, path: (string | number)[]) =>
  [["push", id, ["pipeline", 0, path]], ["pull", id]];

/** Mirror the Devaluator's array-escaping so we can craft data-shaped args and
 *  predict their echoed (re-escaped) wire form. */
function escapeData(v: unknown): unknown {
  if (Array.isArray(v)) return [v.map(escapeData)];
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) o[k] = escapeData((v as any)[k]);
    return o;
  }
  return v;
}

/** A pair of real sessions, for end-to-end "data decodes as data, not a stub". */
class PairT implements RpcTransport {
  partner!: PairT;
  private q: string[] = [];
  private waiter?: () => void;
  async send(m: string): Promise<void> { this.partner.q.push(m); const w = this.partner.waiter; this.partner.waiter = undefined; w?.(); }
  async receive(): Promise<string> { while (this.q.length === 0) await new Promise<void>(r => (this.waiter = r)); return this.q.shift()!; }
}
function realPair<T extends RpcTarget>(target: T) {
  const a = new PairT(); const b = new PairT(); a.partner = b; b.partner = a;
  const server = new RpcSession(b, target);
  const client = new RpcSession<T>(a);
  return { client, server, stub: client.getRemoteMain() as any };
}

// ── targets ─────────────────────────────────────────────────────────────────

class Cap extends RpcTarget { ping() { return "pong"; } }

class Echo extends RpcTarget { echo(v: unknown) { return v; } greet() { return "hi"; } }

const SECRET = "TOP-SECRET-42";
const INSTANCE_LEAK = "do-not-leak-instance";
class Vault extends RpcTarget {
  #secret = SECRET;
  ownProp: { internal: string };
  constructor() { super(); this.ownProp = { internal: INSTANCE_LEAK }; }
  greet() { return "hi"; }
  reveal() { return this.#secret.length; } // legit method may use the secret; path access must not reach it
  makeCap() { return new Cap(); }
  items() { return [1, 2, 3]; }
  get boom(): string { throw new Error("getter blew up"); }
}

let pwnFlag = false;
class SideEffect extends RpcTarget {
  pwn() { pwnFlag = true; return "owned"; }
  greet() { return "hi"; }
}

// ════════════════════════════════════════════════════════════════════════════
// A1. Data is never confused with capabilities (the "echo arbitrary string" worry)
// ════════════════════════════════════════════════════════════════════════════

describe("data is never reinterpreted as a capability (escaping)", () => {
  it("a token-shaped array echoed back decodes as plain data, not a stub", async () => {
    const { stub } = realPair(new Echo());
    const result = await stub.echo(["export", -1]);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(["export", -1]); // a hijacked capability would arrive as a stub, not this array
  });

  it("deeply nested token-shaped data (objects + arrays) round-trips byte-for-byte", async () => {
    const { stub } = realPair(new Echo());
    const hostile = {
      rooms: [{ id: ["export", -1] }, { id: ["import", 7] }],
      meta: { kind: "pipeline", path: ["__proto__", "x"] },
      list: [["release", 1, 1], ["abort", "boom"]],
    };
    expect(await stub.echo(hostile)).toEqual(hostile);
  });

  it("a string equal to a protocol tag name stays a primitive string", async () => {
    const { stub } = realPair(new Echo());
    expect(await stub.echo("export")).toBe("export");
    expect(await stub.echo("pipeline")).toBe("pipeline");
  });

  it("an object whose keys look like tags stays a plain object", async () => {
    const { stub } = realPair(new Echo());
    const obj = { export: [0], import: [1], pipeline: [3, ["m"], []] };
    expect(await stub.echo(obj)).toEqual(obj);
  });

  it("token-shaped data passed as an argument is re-emitted in ESCAPED (data) form, never as a bare capability token", async () => {
    const { t } = server(new Echo());
    t.feed(...call(1, ["echo"], [escapeData(["export", -1])]));
    await flush();
    // Re-escaped data, NOT a bare ["export",-1] capability reference.
    expect(t.resolveOf(1)).toEqual([["export", -1]]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A2. Forged capability references
// ════════════════════════════════════════════════════════════════════════════

describe("forged capability references are rejected, never honoured", () => {
  it("pipelining on an export id the session never allocated fails closed (abort)", async () => {
    const t = (await attack(new Echo(), [["push", 1, ["pipeline", 999, ["x"], []]], ["pull", 1]]));
    expect(t.aborted()).toBe(true);
    expect(t.anyResolve()).toBe(false);
  });

  it("referencing an unallocated import id inside an argument fails closed (abort)", async () => {
    const t = await attack(new Echo(), [["push", 1, ["pipeline", 0, ["echo"], [["import", 999]]]], ["pull", 1]]);
    expect(t.aborted()).toBe(true);
    expect(t.anyResolve()).toBe(false);
  });

  it("referencing a fabricated negative export id (a server capability never handed out) fails closed", async () => {
    const t = await attack(new Echo(), [["push", 1, ["pipeline", -42, ["ping"], []]], ["pull", 1]]);
    expect(t.aborted()).toBe(true);
    expect(t.anyResolve()).toBe(false);
  });

  it("reusing an existing import id as a fresh promise yields no usable alias/hijack", async () => {
    // Introduce import #5 (a client export), then try to redeclare #5 as a promise.
    const t = await attack(new Echo(), [
      ["push", 1, ["pipeline", 0, ["echo"], [["export", 5]]]],
      ["push", 2, ["promise", 5]], // redeclare the live import id as a promise
      ["pull", 2],
    ]);
    // SECURE OUTCOME: the attacker must not obtain a usable capability aliased to
    // the existing slot. A successful hijack would surface as call #2 resolving to
    // a capability token (["export",N] / ["import",N]); that must never happen.
    const resolved = t.resolveOf(2);
    const isCapToken = Array.isArray(resolved) && (resolved[0] === "export" || resolved[0] === "import");
    expect(isCapToken).toBe(false);
    // The library refuses the reuse internally (the promise id is turned into an
    // error stub and import #5 is released) rather than emitting a wire error, so
    // we assert the security property itself: no aliased capability is handed back,
    // and the session is handled gracefully and stays usable.
    expect(t.aborted()).toBe(false);
    t.feed(...call(3, ["echo"], ["alive"]));
    await flush();
    expect(t.resolveOf(3)).toBe("alive");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A3. Prototype pollution
// ════════════════════════════════════════════════════════════════════════════

describe("prototype pollution is impossible", () => {
  it("a property path through __proto__ cannot pollute Object.prototype", async () => {
    const t = await attack(new Vault(), get(1, ["__proto__", "polluted_a"]));
    expect(({} as any).polluted_a).toBeUndefined();
    expect("polluted_a" in Object.prototype).toBe(false);
    expect(t.anyResolve()).toBe(false); // navigation dead-ends; never returns a usable value
  });

  it("accessing/calling `constructor` over RPC is blocked", async () => {
    const t = await attack(new Vault(), call(1, ["constructor"], []));
    expect(t.rejectMsg(1) ?? t.text()).toMatch(/not a function|undefined/i);
    expect(({} as any).constructor).toBe(Object); // unchanged
  });

  it("an argument object carrying __proto__ is sanitised (key dropped, no pollution)", async () => {
    const { t } = server(new Echo());
    t.feed(...call(1, ["echo"], [{ __proto__: { polluted_b: "X" }, keep: 1 }]));
    await flush();
    expect(({} as any).polluted_b).toBeUndefined();
    expect("polluted_b" in Object.prototype).toBe(false);
    expect(t.resolveOf(1)).toEqual({ keep: 1 }); // dangerous key stripped, benign key kept
  });

  it("argument objects with constructor / prototype / toJSON keys cannot pollute", async () => {
    const { t } = server(new Echo());
    t.feed(...call(1, ["echo"], [{ constructor: "c", prototype: "p", toJSON: "j", ok: 2 }]));
    await flush();
    const result = t.resolveOf(1) as any;
    // SECURE OUTCOME: the actual pollution vectors are neutralised and nothing on
    // any prototype chain is touched.
    expect(Object.hasOwn(result, "constructor")).toBe(false); // own key stripped (it is on Object.prototype)
    expect(Object.hasOwn(result, "toJSON")).toBe(false);      // own key stripped (special-cased)
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as any).c).toBeUndefined();
    expect(result.ok).toBe(2);                          // benign data preserved
    // `prototype` is NOT a prototype-pollution vector on a plain object — it is an
    // ordinary own data key with no effect on any prototype chain, so it correctly
    // rides through as inert data rather than being stripped.
    expect(result.prototype).toBe("p");
  });

  it("a deeply nested __proto__ inside an argument cannot pollute", async () => {
    const { t } = server(new Echo());
    t.feed(...call(1, ["echo"], [{ a: { b: { __proto__: { polluted_c: 9 }, c: 1 } } }]));
    await flush();
    expect(({} as any).polluted_c).toBeUndefined();
    expect("polluted_c" in Object.prototype).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A4. Property & method access control
// ════════════════════════════════════════════════════════════════════════════

describe("internal/private state cannot be reached over RPC", () => {
  it("a private #field is unreachable and its value never appears on the wire", async () => {
    const t = await attack(new Vault(), call(1, ["#secret"], []));
    expect(t.rejectMsg(1) ?? "").toMatch(/not a function/i);
    expect(t.text()).not.toContain(SECRET);
  });

  it("inherited Object.prototype members are not invocable", async () => {
    for (const m of ["toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "constructor"]) {
      const t = await attack(new Vault(), call(1, [m], []));
      expect(t.anyResolve(), `${m} must not resolve`).toBe(false);
    }
  });

  it("an own (instance) property on an RpcTarget is blocked and never leaks", async () => {
    const t = await attack(new Vault(), get(1, ["ownProp", "internal"]));
    expect(t.anyResolve()).toBe(false);
    expect(t.text()).not.toContain(INSTANCE_LEAK);
  });

  it("calling a non-existent method is a graceful per-call reject; the session survives", async () => {
    const { t } = server(new Vault());
    t.feed(...call(1, ["doesNotExist"], []));
    await flush();
    expect(t.rejectMsg(1) ?? "").toMatch(/not a function/i);
    expect(t.aborted()).toBe(false);
    // A subsequent legitimate call still works → the attack didn't kill the session.
    t.feed(...call(2, ["greet"], []));
    await flush();
    expect(t.resolveOf(2)).toBe("hi");
  });

  it("a method/getter that throws is contained (reject, not crash); the session survives", async () => {
    const { t } = server(new Vault());
    t.feed(...get(1, ["boom"]));
    await flush();
    expect(t.aborted()).toBe(false);
    t.feed(...call(2, ["greet"], []));
    await flush();
    expect(t.resolveOf(2)).toBe("hi");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A5. Refcount / lifetime abuse
// ════════════════════════════════════════════════════════════════════════════

describe("refcount and lifetime manipulation cannot free or hijack capabilities", () => {
  it("over-releasing (count > refcount) fails closed instead of underflowing", async () => {
    const { t } = server(new Vault());
    t.feed(...call(1, ["makeCap"], []));
    await flush(); // export -1 (the Cap) now exists with refcount 1
    t.feed(["release", -1, 99]);
    await flush();
    expect(t.aborted()).toBe(true); // "refcount would go negative"
  });

  it("double-releasing is idempotent and safe (no use-after-free, no abort)", async () => {
    const { t } = server(new Vault());
    t.feed(...call(1, ["makeCap"], []));
    await flush();
    t.feed(["release", -1, 1]);
    await flush();
    t.feed(["release", -1, 1]); // second release of an already-freed export
    await flush();
    expect(t.aborted()).toBe(false);
  });

  it("a negative-count release cannot free or hijack an export — it stays usable", async () => {
    const { t } = server(new Vault());
    t.feed(...call(1, ["makeCap"], []));
    await flush();
    t.feed(["release", -1, -5]); // inflates refcount at worst; must not free/hijack
    await flush();
    t.feed(["push", 2, ["pipeline", -1, ["ping"], []]], ["pull", 2]);
    await flush();
    expect(t.resolveOf(2)).toBe("pong"); // the capability is intact and still ours
  });

  it("releasing an export id that doesn't exist is silently ignored; the session survives", async () => {
    const { t } = server(new Vault());
    t.feed(["release", -999, 1]);
    await flush();
    expect(t.aborted()).toBe(false);
    t.feed(...call(1, ["greet"], []));
    await flush();
    expect(t.resolveOf(1)).toBe("hi");
  });

  it("resolving/rejecting an unknown import id is ignored; the session survives", async () => {
    const { t } = server(new Vault());
    t.feed(["resolve", 4242, 5], ["reject", 4243, ["error", "Error", "x"]]);
    await flush();
    expect(t.aborted()).toBe(false);
    t.feed(...call(1, ["greet"], []));
    await flush();
    expect(t.resolveOf(1)).toBe("hi");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A6. Malformed / abusive protocol frames
// ════════════════════════════════════════════════════════════════════════════

describe("malformed and abusive frames fail closed and never produce a usable result", () => {
  it("invalid JSON aborts the session", async () => {
    const { t } = server(new Echo());
    t.feed("{ this is not json ]");
    await flush();
    expect(t.aborted()).toBe(true);
    expect(t.anyResolve()).toBe(false);
  });

  it("a non-array message aborts the session", async () => {
    const t = await attack(new Echo(), [{ hello: "world" }]);
    expect(t.aborted()).toBe(true);
  });

  it("an unknown message type aborts the session", async () => {
    const t = await attack(new Echo(), [["frobnicate", 1, 2, 3]]);
    expect(t.aborted()).toBe(true);
  });

  it("structurally invalid frames (bad arity / wrong field types) never yield a resolve", async () => {
    for (const frame of [["push", 1], ["pull"], ["release", -1], ["release", -1, "lots"], ["push", "x", ["pipeline", 0, ["greet"], []]]]) {
      const t = await attack(new Echo(), [frame]);
      expect(t.anyResolve(), `${JSON.stringify(frame)} must not resolve`).toBe(false);
    }
  });

  it("a deeply nested payload is contained — no pollution, no compromise, the server stays healthy", async () => {
    // Deep nesting is not itself a risk; the only security question is whether it
    // can COMPROMISE anything (leak / pollute / hijack) or cause an UNCONTAINED
    // crash. Here we assert the secure outcome we can prove safely: a deep payload
    // pollutes nothing and the session remains healthy afterwards (contained).
    // (Open question, tracked separately: whether an *extreme*-depth, non-echoing
    // payload is contained or overflows uncontained — the inbound Evaluator lacks
    // the explicit depth cap the outbound Devaluator has.)
    let bomb: unknown = 0;
    for (let i = 0; i < 500; i++) bomb = [bomb];
    const { t } = server(new Echo());
    t.feed(["push", 1, ["pipeline", 0, ["echo"], [bomb]]], ["pull", 1]);
    await flush();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype); // no pollution
    // Contained: a subsequent legitimate call still succeeds (no crash/hang).
    t.feed(...call(2, ["greet"], []));
    await flush();
    expect(t.resolveOf(2)).toBe("hi");
  });

  it("an abort message from the peer closes the session cleanly (no further service)", async () => {
    const { t } = server(new Echo());
    t.feed(["abort", ["error", "Error", "goodbye"]]);
    await flush();
    t.feed(...call(1, ["greet"], []));
    await flush();
    expect(t.resolveOf(1)).toBeUndefined(); // session is gone; no resolve served
  });
});

// ════════════════════════════════════════════════════════════════════════════
// A7. Map programs are sandboxed
// ════════════════════════════════════════════════════════════════════════════

describe("hostile .map() programs are sandboxed", () => {
  it("an empty mapper is rejected", async () => {
    const t = await attack(new Vault(), [
      ["push", 1, ["pipeline", 0, ["items"], []]],
      ["push", 2, ["remap", 1, [], [], []]],
      ["pull", 2],
    ]);
    expect(t.rejectMsg(2) ?? "").toMatch(/empty mapper/i);
  });

  it("a mapper that tries to introduce a new export is rejected", async () => {
    const t = await attack(new Vault(), [
      ["push", 1, ["pipeline", 0, ["items"], []]],
      ["push", 2, ["remap", 1, [], [], [["export", -99]]]],
      ["pull", 2],
    ]);
    expect(t.rejectMsg(2) ?? "").toMatch(/cannot refer to exports/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B. Hibernation snapshot trust boundary
//
// A restored snapshot is a FULLY TRUSTED input: its `importReplays[].expr` are
// re-executed on wake. These tests pin (1) that trust empirically, and (2) that
// the snapshot-sealing layer closes it when storage might be attacker-writable.
// ════════════════════════════════════════════════════════════════════════════

class Store implements HibernatableSessionStore {
  snapshots = new Map<string, HibernatableStoredSnapshot>();
  async load(id: string) { return this.snapshots.get(id); }
  async save(id: string, s: HibernatableStoredSnapshot) { this.snapshots.set(id, structuredClone(s)); }
  async delete(id: string) { this.snapshots.delete(id); }
}

/** Authenticated-encryption stand-in: open() rejects any ciphertext it didn't
 *  seal AND any associated-data mismatch (i.e. real AEAD semantics). */
function makeSec(secret: string): HibernatableSnapshotSecurity {
  const sealed = new Map<string, { plaintext: string; associatedData: string }>();
  let n = 0;
  return {
    required: true,
    fingerprint({ plaintext, associatedData }) {
      const input = `${secret}\n${associatedData}\n${plaintext}`;
      let h = 0; for (let i = 0; i < input.length; i++) h = Math.imul(h ^ input.charCodeAt(i), 16777619);
      return `fp:${h >>> 0}`;
    },
    seal({ plaintext, associatedData }) {
      const ciphertext = `ct:${++n}`;
      sealed.set(ciphertext, { plaintext, associatedData });
      return { kind: "encrypted", alg: "test", nonce: `no:${n}`, ciphertext, fingerprint: this.fingerprint({ plaintext, associatedData }) } as const;
    },
    open({ envelope, associatedData }) {
      const e = sealed.get(envelope.ciphertext);
      if (!e || e.associatedData !== associatedData) throw new Error("invalid encrypted snapshot");
      return e.plaintext;
    },
  };
}

class FakeWS {
  sent: string[] = [];
  closeCount = 0; closeReason = "";
  readyState = 1;
  private attachment: unknown;
  private listeners = new Map<string, ((e: any) => void)[]>();
  addEventListener(type: string, l: (e: any) => void) { const a = this.listeners.get(type) ?? []; a.push(l); this.listeners.set(type, a); }
  send(m: string) { this.sent.push(m); }
  close(code = 1000, reason = "") { this.closeCount++; this.closeReason = reason; this.readyState = 3; }
  serializeAttachment(v: unknown) { this.attachment = structuredClone(v); }
  deserializeAttachment() { return this.attachment; }
}

const forgedReplaySnapshot = () => ({
  version: 2, nextExportId: -1, exports: [], importReplays: [{ expr: ["pipeline", 0, ["pwn"], []] }],
});

describe("hibernation snapshot is a trusted input — and sealing is what enforces that trust", () => {
  // SECURE OUTCOME: a forged/attacker-supplied importReplay must NOT execute on
  // restore. The two tests below assert exactly that and CURRENTLY FAIL (red) —
  // the failure is the finding, not a thing to hide: the bare RpcSession layer
  // and the websocket layer WITHOUT sealing both replay a forged snapshot
  // verbatim. The `snapshotSecurity.required` test further down is the control
  // that makes this secure outcome actually hold; these reds document precisely
  // what you are trusting when that control is absent.
  it("[expected red — documents the gap] a forged importReplay in a restored snapshot must NOT execute (core RpcSession layer)", async () => {
    pwnFlag = false;
    const t = new Evil();
    new RpcSession(t as unknown as RpcTransport, new SideEffect(), { __experimental_restoreSnapshot: forgedReplaySnapshot() } as any);
    await flush();
    expect(pwnFlag).toBe(false); // FAILS: the core layer trusts its snapshot input entirely — no authentication here.
  });

  it("[expected red — documents the gap] without snapshotSecurity, a forged store snapshot must NOT be replayed on wake", async () => {
    pwnFlag = false;
    const store = new Store(); const sid = "victim";
    store.snapshots.set(sid, forgedReplaySnapshot() as any);
    const ws = new FakeWS();
    await __experimental_newHibernatableWebSocketRpcSession(ws as any, new SideEffect(), { sessionStore: store, sessionId: sid });
    await flush();
    expect(pwnFlag).toBe(false); // FAILS: with no sealing configured, a forged store snapshot is replayed verbatim.
  });

  it("with snapshotSecurity.required, a forged plaintext store snapshot is REJECTED and never replayed (the mitigation)", async () => {
    pwnFlag = false;
    const store = new Store(); const sid = "victim";
    store.snapshots.set(sid, forgedReplaySnapshot() as any);
    const ws = new FakeWS();
    const sess = await __experimental_newHibernatableWebSocketRpcSession(
      ws as any, new SideEffect(),
      { sessionStore: store, sessionId: sid, snapshotSecurity: makeSec("k"), snapshotSecurityAssociatedData: { userId: sid } });
    await flush();
    expect(sess).toBeUndefined();
    expect(pwnFlag).toBe(false);
    expect(ws.closeCount).toBe(1);
    expect(store.snapshots.has(sid)).toBe(false); // tainted entry purged
  });

  it("a tampered sealed snapshot (modified ciphertext) is rejected on restore", async () => {
    const store = new Store(); const sec = makeSec("k"); const sid = "u1";
    const ok = await __experimental_newHibernatableWebSocketRpcSession(
      new FakeWS() as any, new Echo(), { sessionStore: store, sessionId: sid, snapshotSecurity: sec, snapshotSecurityAssociatedData: { userId: sid } });
    expect(ok).toBeDefined();
    const env: any = store.snapshots.get(sid);
    expect(env.kind).toBe("encrypted");
    env.ciphertext = env.ciphertext + ":tampered"; // flip the bytes
    store.snapshots.set(sid, env);
    const ws2 = new FakeWS();
    const bad = await __experimental_newHibernatableWebSocketRpcSession(
      ws2 as any, new Echo(), { sessionStore: store, sessionId: sid, snapshotSecurity: sec, snapshotSecurityAssociatedData: { userId: sid } });
    expect(bad).toBeUndefined();
    expect(ws2.closeCount).toBe(1);
  });

  it("an encrypted snapshot presented without snapshotSecurity is rejected (no plaintext fallback)", async () => {
    const store = new Store(); const sec = makeSec("k"); const sid = "u2";
    await __experimental_newHibernatableWebSocketRpcSession(
      new FakeWS() as any, new Echo(), { sessionStore: store, sessionId: sid, snapshotSecurity: sec, snapshotSecurityAssociatedData: { userId: sid } });
    const bad = await __experimental_newHibernatableWebSocketRpcSession(
      new FakeWS() as any, new Echo(), { sessionStore: store, sessionId: sid }); // open() not provided
    expect(bad).toBeUndefined();
  });

  it("a sealed snapshot cannot be replayed under a different session context (associatedData binding)", async () => {
    const store = new Store(); const sec = makeSec("k");
    await __experimental_newHibernatableWebSocketRpcSession(
      new FakeWS() as any, new Echo(), { sessionStore: store, sessionId: "alice", snapshotSecurity: sec, snapshotSecurityAssociatedData: { userId: "alice" } });
    store.snapshots.set("bob", store.snapshots.get("alice")!); // steal alice's sealed blob
    const bad = await __experimental_newHibernatableWebSocketRpcSession(
      new FakeWS() as any, new Echo(), { sessionStore: store, sessionId: "bob", snapshotSecurity: sec, snapshotSecurityAssociatedData: { userId: "bob" } });
    expect(bad).toBeUndefined();
  });

  it("a snapshot with an unsupported version is rejected (fail closed)", () => {
    const t = new Evil();
    expect(() => new RpcSession(
      t as unknown as RpcTransport, new Echo(),
      { __experimental_restoreSnapshot: { version: 99, nextExportId: -1, exports: [] } } as any)).toThrow(/version/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Sentinel: after every attack above, the global prototype must be pristine.
// ════════════════════════════════════════════════════════════════════════════

describe("global integrity sentinel", () => {
  it("Object.prototype carries none of the keys any attack above tried to inject", () => {
    for (const k of ["polluted_a", "polluted_b", "polluted_c", "polluted", "pwned"]) {
      expect(k in Object.prototype, `Object.prototype.${k} leaked`).toBe(false);
    }
    expect(({} as any).__proto__).toBe(Object.prototype);
  });
});

// Convenience: build + feed + flush in one call.
async function attack(target: RpcTarget, frames: unknown[]): Promise<Evil> {
  const { t } = server(target);
  t.feed(...frames);
  await flush();
  return t;
}
