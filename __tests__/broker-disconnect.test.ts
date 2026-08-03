// Investigative test: does a worker→DO ("upstream") break fire onRpcBroken on a
// brokered capability held idle by the downstream client?
//
// Topology mirrors the real app:
//   A = Durable Object (owns the real capability)
//   B = Worker (broker): holds a stub to A and returns it straight through
//   C = Browser: calls B, gets A's capability brokered through B, RESOLVES it,
//       registers onRpcBroken, then sits idle.
// Then we break the B↔A link only (C↔B stays open) and observe.

import { expect, it, describe } from "vitest"
import { RpcSession, RpcTarget, RpcStub } from "../src/index.js"

// Minimal paired in-memory transport with a forceReceiveError, modeled on the
// repo's own TestTransport.
class PairTransport {
  queue: string[] = []
  waiter?: () => void
  aborter?: (e: any) => void
  partner!: PairTransport
  async send(message: string): Promise<void> {
    this.partner.queue.push(message)
    if (this.partner.waiter) {
      this.partner.waiter()
      this.partner.waiter = undefined
      this.partner.aborter = undefined
    }
  }
  async receive(): Promise<string> {
    while (this.queue.length === 0) {
      await new Promise<void>((resolve, reject) => {
        this.waiter = resolve
        this.aborter = reject
      })
    }
    return this.queue.shift()!
  }
  forceReceiveError(error: any) {
    if (this.aborter) this.aborter(error)
  }
}
function pair(): [PairTransport, PairTransport] {
  const a = new PairTransport()
  const b = new PairTransport()
  a.partner = b
  b.partner = a
  return [a, b]
}

async function pump() {
  for (let i = 0; i < 64; i++) await Promise.resolve()
}

class DurableCap extends RpcTarget {
  ping(): string {
    return "alive"
  }
}
class ATarget extends RpcTarget {
  getCapability(): DurableCap {
    return new DurableCap()
  }
}
class BTarget extends RpcTarget {
  constructor(private a: RpcStub<ATarget>) {
    super()
  }
  // Straight pass-through, exactly like worker.ts `return root.getCapability()`.
  getCapability() {
    return this.a.getCapability()
  }
}

describe("brokered capability disconnect", () => {
  it("SANITY: breaking C↔B fires onRpcBroken on the brokered cap", async () => {
    const [tB2, tA] = pair()
    new RpcSession(tA, new ATarget())
    const bClient = new RpcSession<ATarget>(tB2)
    const aStub = bClient.getRemoteMain()

    const [tC, tB1] = pair()
    new RpcSession(tB1, new BTarget(aStub))
    const cClient = new RpcSession<BTarget>(tC)
    const bStub = cClient.getRemoteMain()

    const cap = await bStub.getCapability()
    expect(await cap.ping()).toBe("alive")

    const fired: string[] = []
    cap.onRpcBroken(() => fired.push("cap"))

    // Break the DOWNSTREAM (C↔B) link.
    tC.forceReceiveError(new Error("C-B socket died"))
    await pump()

    console.log("[SANITY] C↔B break → fired:", JSON.stringify(fired))
    expect(fired).toContain("cap") // we expect this to work
  })

  it("THE QUESTION: breaking B↔A (worker→DO) while C is idle — does onRpcBroken fire?", async () => {
    // B↔A
    const [tB2, tA] = pair()
    new RpcSession(tA, new ATarget())
    const bClient = new RpcSession<ATarget>(tB2)
    const aStub = bClient.getRemoteMain()

    // C↔B
    const [tC, tB1] = pair()
    new RpcSession(tB1, new BTarget(aStub))
    const cClient = new RpcSession<BTarget>(tC)
    const bStub = cClient.getRemoteMain()

    // C resolves the brokered cap and confirms it routes C→B→A.
    const cap = await bStub.getCapability()
    expect(await cap.ping()).toBe("alive")

    const fired: string[] = []
    // Register AFTER resolution (matches real sync-client: `const cap = await ...; cap.onRpcBroken`)
    cap.onRpcBroken((e) => fired.push("cap:" + (e?.message ?? String(e))))
    bStub.onRpcBroken((e) => fired.push("cMain:" + (e?.message ?? String(e))))

    // Break ONLY the B↔A (worker→DO) link. C↔B stays open; C makes no calls.
    tB2.forceReceiveError(new Error("worker→DO tunnel died"))
    await pump()

    console.log("[QUESTION] B↔A break, C idle → onRpcBroken fired:", JSON.stringify(fired))

    // Is the C↔B session still alive (i.e. did only the upstream die)?
    let downstreamAlive = false
    try {
      const cap2 = await bStub.getCapability()
      // This call reaches A through B, which is dead → expect it to reject.
      await cap2.ping()
      downstreamAlive = true
    } catch (e: any) {
      console.log("[QUESTION] post-break call rejected with:", e?.message ?? String(e))
    }
    console.log("[QUESTION] downstream C↔B still usable for fresh calls:", downstreamAlive)

    // Did a call on the ALREADY-HELD cap reject after the break?
    let heldCapCall = ""
    try {
      heldCapCall = await cap.ping()
    } catch (e: any) {
      heldCapCall = "REJECTED: " + (e?.message ?? String(e))
    }
    console.log("[QUESTION] held cap.ping() after break:", heldCapCall)

    // No assertion on `fired` — this test exists to REPORT the truth via logs.
    expect(true).toBe(true)
  })

  it("BIDIRECTIONAL SIGNAL: client exposes a local main; worker pushes to it on upstream death — no C call, no A wake", async () => {
    // Count any contact with A, to prove the signal never reaches/wakes the DO.
    let aContacted = 0
    class CountingDurableCap extends RpcTarget {
      ping(): string {
        aContacted++
        return "alive"
      }
    }
    class CountingATarget extends RpcTarget {
      getCapability() {
        aContacted++
        return new CountingDurableCap()
      }
    }

    // ╔═ CLIENT half — maps to capnweb.ts ═══════════════════════════════════════╗
    // The browser exposes a callable LOCAL MAIN on the browser↔worker session.
    // capnweb is bidirectional, so the worker can call this back.
    let lostFired = 0
    class Peer extends RpcTarget {                                 // [capnweb.ts L1]
      onPeerLost() { lostFired++ /* real client: recover() */ }    // [capnweb.ts L2]
    }
    // ...the 3rd client line is passing `new Peer()` to the session ctor, below.
    // ╚══════════════════════════════════════════════════════════════════════════╝

    // ╔═ WORKER half — maps to worker.ts ════════════════════════════════════════╗
    // The worker already detects its upstream (worker→DO) death — its evict /
    // doWs-close handler. Here that's `this.a.onRpcBroken`. In that EXISTING
    // handler, it calls the browser's local main. `this.browser()` is the browser
    // remote main the worker already gets from `newWebSocketRpcSession(server,…)`.
    class Broker extends RpcTarget {
      constructor(
        private a: RpcStub<CountingATarget>,
        private browser: () => RpcStub<any>,
      ) {
        super()
        this.a.onRpcBroken(() => this.browser().onPeerLost())      // [worker.ts L1]
      }
      getCapability() {
        return this.a.getCapability()
      }
    }
    // ╚══════════════════════════════════════════════════════════════════════════╝

    // B↔A
    const [tB2, tA] = pair()
    new RpcSession(tA, new CountingATarget())
    const bClient = new RpcSession<CountingATarget>(tB2)
    const aStub = bClient.getRemoteMain()

    // C↔B. The worker captures the browser's local main via the session it ALREADY
    // creates — `getRemoteMain()` on the browser↔worker session.   [worker.ts L2]
    const [tC, tB1] = pair()
    let bSession!: RpcSession<any>
    const broker = new Broker(aStub, () => bSession.getRemoteMain())
    bSession = new RpcSession(tB1, broker)
    const cSession = new RpcSession<Broker>(tC, new Peer())         // [capnweb.ts L3]
    const bStub = cSession.getRemoteMain()

    // C resolves the brokered cap and goes idle — no further calls.
    const cap = await bStub.getCapability()
    expect(await cap.ping()).toBe("alive")
    await pump()
    const before = aContacted

    // Break ONLY the B↔A (worker→DO) link. C makes no calls.
    tB2.forceReceiveError(new Error("worker→DO tunnel died"))
    await pump()

    console.log("[BIDI] onPeerLost fired on C:", lostFired)
    console.log("[BIDI] A contacted by the signal path:", aContacted - before)

    // Auditable production cost: capnweb.ts L1–L3 (3) + worker.ts L1–L2 (2) = 5 lines.
    expect(lostFired).toBe(1) // C learned of the break with ZERO outbound calls
    expect(aContacted).toBe(before) // the signal never touched A (no DO wake)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Shared-socket recovery internals (room-service capnweb.ts "Option B").
//
// Shared mode: a SharedCapnwebSocket OWNER holds one logical connection but, on a
// socket death, tears the RpcSession down and builds a NEW one (a new root stub)
// on reconnect. The design question for driving recover() off the ROOT's
// onRpcBroken is: (1) does it fire for a PUSH-ONLY client that never calls?
// (2) can a single registration survive a reconnect, or must it be re-registered
// per root? (3) do repeat registrations dedup? These tests answer empirically.
// ─────────────────────────────────────────────────────────────────────────────
describe("shared-socket root recovery (onRpcBroken on the root)", () => {
  // One "generation" = one owner socket lifetime: a fresh transport pair + a
  // fresh RpcSession + its root. Reconnect = a brand-new generation.
  function makeGeneration() {
    const [tClient, tServer] = pair()
    new RpcSession(tServer, new ATarget())
    const client = new RpcSession<ATarget>(tClient)
    return { tClient, root: client.getRemoteMain() }
  }

  it("root.onRpcBroken fires on socket death with ZERO outbound calls (push-only)", async () => {
    const { tClient, root } = makeGeneration()
    const fired: string[] = []
    // Never call anything on `root` — pure push-only, like a relay/sync observer.
    root.onRpcBroken((e) => fired.push(e?.message ?? String(e)))

    tClient.forceReceiveError(new Error("socket died"))
    await pump()

    expect(fired).toEqual(["socket died"])
  })

  it("a registration does NOT bubble across a reconnect — per-root re-registration is REQUIRED", async () => {
    // GEN 0 — register, then kill it.
    const g0 = makeGeneration()
    const fired: string[] = []
    g0.root.onRpcBroken((e) => fired.push("g0cb:" + (e?.message ?? String(e))))
    g0.tClient.forceReceiveError(new Error("gen0 died"))
    await pump()
    expect(fired).toEqual(["g0cb:gen0 died"]) // fired once, for its OWN session

    // GEN 1 — the owner reconnects: a brand-new RpcSession + new root. We do NOT
    // register on it, to test whether g0's callback carries over.
    const g1 = makeGeneration()
    g1.tClient.forceReceiveError(new Error("gen1 died"))
    await pump()

    // g0's callback was bound to gen0's (now-dead) RpcSession. There is no global
    // registry, so it does NOT fire for gen1. Hence the root-onRpcBroken approach
    // MUST re-register on each new root — a single registration cannot span
    // reconnects.
    expect(fired).toEqual(["g0cb:gen0 died"]) // unchanged — no bubble

    // Confirm the correct pattern: registering on gen1's own root DOES fire.
    const g1b = makeGeneration()
    const fired1: string[] = []
    g1b.root.onRpcBroken((e) => fired1.push(e?.message ?? String(e)))
    g1b.tClient.forceReceiveError(new Error("gen1b died"))
    await pump()
    expect(fired1).toEqual(["gen1b died"])
  })

  it("repeat registrations on one root each fire (no dedup) — so per-acquire registration MULTIPLIES recover() calls", async () => {
    const { tClient, root } = makeGeneration()
    const fired: string[] = []
    root.onRpcBroken(() => fired.push("1"))
    root.onRpcBroken(() => fired.push("2"))
    root.onRpcBroken(() => fired.push("3"))

    tClient.forceReceiveError(new Error("x"))
    await pump()

    expect(fired).toEqual(["1", "2", "3"]) // N registrations → N callbacks
  })

  it("OWNER fan-out (no per-managed-session accumulation): owner registers per root, subscriber registers ONCE", async () => {
    // Models the proposed no-accumulation path: the OWNER is the only place that
    // knows about roots, so per-root onRpcBroken registration lives there and
    // fans out to a STABLE subscriber set. A managed session subscribes once and
    // never touches a root or re-registers across reconnects.
    const brokenSubs = new Set<() => void>()
    let recoveries = 0
    brokenSubs.add(() => recoveries++) // the managed session: ONE subscription, forever

    // The owner's connect/reconnect routine — the sole owner of per-root wiring.
    function ownerConnect() {
      const g = makeGeneration()
      g.root.onRpcBroken(() => brokenSubs.forEach((cb) => cb()))
      return g
    }

    const g0 = ownerConnect()
    g0.tClient.forceReceiveError(new Error("g0"))
    await pump()

    const g1 = ownerConnect() // reconnect: owner re-wires; subscriber untouched
    g1.tClient.forceReceiveError(new Error("g1"))
    await pump()

    // Both generations recovered, with the managed session having registered
    // exactly once — the accumulation lives (and dies) with each root in the owner.
    expect(recoveries).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Shape-agnostic disposal: `new RpcStub(value)[Symbol.dispose]()`.
//
// room-service's managed session wants to dispose whatever a consumer's `acquire`
// returns — an arbitrary-shaped object holding capability stubs — WITHOUT the
// consumer writing a disposer and WITHOUT constraining the shape. These tests pin
// the capnweb primitive that design relies on: wrapping an arbitrary value in an
// RpcStub and disposing it releases every stub inside it (the ORIGINALS, not
// dups), exactly once, recursively, and safely on already-dead stubs.
// ─────────────────────────────────────────────────────────────────────────────

class DisposChild extends RpcTarget {
  constructor(private tag: string, private sink: string[]) {
    super()
  }
  ping() {
    return "ok"
  }
  [Symbol.dispose]() {
    this.sink.push(this.tag)
  }
}
class DisposServer extends RpcTarget {
  disposed: string[] = []
  makeChild(tag: string) {
    return new DisposChild(tag, this.disposed)
  }
}
describe("shape-agnostic disposal via new RpcStub(value)[Symbol.dispose]()", () => {
  // Proper client/server pair that exposes the server's disposal log.
  function setup() {
    const [tC, tS] = pair()
    const server = new DisposServer()
    new RpcSession(tS, server)
    const client = new RpcSession<DisposServer>(tC)
    return { tC, server, main: client.getRemoteMain() }
  }

  it("recurses arbitrary shapes and ignores primitives (local stubs)", () => {
    class D extends RpcTarget {
      constructor(
        private tag: string,
        private sink: string[],
      ) {
        super()
      }
      [Symbol.dispose]() {
        this.sink.push(this.tag)
      }
    }
    const log: string[] = []
    const s = (tag: string) => new RpcStub(new D(tag, log) as any)
    const session = {
      a: s("a"),
      nested: { b: s("b") },
      list: [s("c"), s("d")],
      id: 42,
      name: "x",
      nothing: null,
    }
    new RpcStub(session as any)[Symbol.dispose]()
    expect(log.sort()).toStrictEqual(["a", "b", "c", "d"]) // all nested disposed; primitives ignored
  })

  it("releases ALL nested REMOTE stubs on the peer, whatever the shape", async () => {
    const { server, main } = setup()
    const cap1 = await main.makeChild("a")
    const cap2 = await main.makeChild("b")
    const cap3 = await main.makeChild("c")
    await pump()
    expect(server.disposed).toStrictEqual([]) // nothing released while held

    const session = { cap1, meta: { cap2 }, list: [cap3], n: 42, s: "x", z: null }
    new RpcStub(session as any)[Symbol.dispose]()
    await pump()
    expect(server.disposed.sort()).toStrictEqual(["a", "b", "c"]) // originals released, not dups
  })

  it("disposing a session whose stubs are already dead (broken session) does not throw", async () => {
    const { tC, main } = setup()
    const cap = await main.makeChild("x")
    await pump()
    tC.forceReceiveError(new Error("socket died")) // client session aborts → cap is dead
    await pump()
    expect(() => new RpcStub({ cap } as any)[Symbol.dispose]()).not.toThrow()
  })

  it("an aliased remote stub is released exactly once", async () => {
    const { server, main } = setup()
    const cap = await main.makeChild("z")
    await pump()
    new RpcStub({ x: cap, y: cap, list: [cap] } as any)[Symbol.dispose]()
    await pump()
    expect(server.disposed.filter((t) => t === "z").length).toBe(1)
  })

  it("disposing the wrapper twice is idempotent (no throw, no double release)", async () => {
    const { server, main } = setup()
    const cap = await main.makeChild("z")
    await pump()
    const w = new RpcStub({ cap } as any)
    w[Symbol.dispose]()
    await pump()
    expect(() => w[Symbol.dispose]()).not.toThrow()
    await pump()
    expect(server.disposed.filter((t) => t === "z").length).toBe(1)
  })
})
