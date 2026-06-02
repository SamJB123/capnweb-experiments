# Wiring optional CBOR into capnweb — integration plan

Design for reviving cbor-x wire encoding in this fork, hitting three goals:

1. **Entirely optional** — an alternative to the JSON wire format, never overwriting it.
2. **Modular** — CBOR lives in its own files; core files barely change.
3. **Hibernation-compatible** — reusing the mature hibernation snapshot mechanism so the
   codec survives hibernation.

All file:line references are against `main` @ `0.8.0-hibernation.0` (which this
`cbor-experiment` branch mirrors). Companion: `cbor-reference/codec.ts` (the old evolved
codec, reference only) and `cbor-reference/README.md` (why we started fresh).

---

## The one seam that matters

All wire (de)serialization funnels through a single thin layer in `rpc.ts`, sitting **on
top of** the `Devaluator`/`Evaluator` in `serialize.ts`:

| Direction   | Location                          | Today                                                     |
|-------------|-----------------------------------|-----------------------------------------------------------|
| Send        | `RpcSession.send()` `rpc.ts:831`  | `JSON.stringify(msg)` → `transport.send(string)`          |
| Send (abort)| `rpc.ts:967`                      | `transport.send(JSON.stringify(["abort", …]))` (bypasses `send()`) |
| Receive     | `readLoop()` `rpc.ts:1032`        | `transport.receive()` → `JSON.parse(msgText)`             |

`msg` is **already devalued** — plain arrays/objects/primitives (cap'n web's array-token
form). A codec swaps only the `JSON.stringify`/`JSON.parse` step; `Devaluator`/`Evaluator`
are never touched.

> Note: `cloneRpcExpr` (`rpc.ts:421`) also JSON round-trips, but that's *internal cloning of
> devalued structures*, not wire. It stays JSON and is unaffected by the codec.

---

## Goal 1 — entirely optional (JSON stays the default)

A small `Codec` interface with JSON as the built-in default:

```ts
// src/codec/index.ts
export interface Codec {
  readonly id: string;                              // "json" | "cbor" — used for the hibernation guard
  encode(message: unknown): string | Uint8Array;
  decode(wire: string | Uint8Array): unknown;
  // Optional — only stateful codecs implement these (see Goal 3):
  snapshotState?(): unknown;                        // must be JSON-serializable
  restoreState?(state: unknown): void;
  reset?(): void;
}

// src/codec/json.ts
export const jsonCodec: Codec = {
  id: "json",
  encode: (m) => JSON.stringify(m),
  decode: (w) => JSON.parse(typeof w === "string" ? w : new TextDecoder().decode(w)),
};
```

`RpcSessionOptions` (`rpc.ts:364`) gains one field: `codec?: Codec`. In the constructor:
`this.codec = options.codec ?? jsonCodec`. **No codec option → byte-identical to today**,
no new dependency, JSON wire untouched. CBOR is purely additive and opt-in per session.

---

## Goal 2 — modular files, minimal core touch

The **entire core footprint is ~6 small edits** in `rpc.ts` plus a one-field type change:

1. `RpcSessionOptions` += `codec?: Codec`
2. constructor: `this.codec = options.codec ?? jsonCodec`
3. `send()`: `JSON.stringify(msg)` → `this.codec.encode(msg)`; byteLength → `wire.length ?? wire.byteLength`
4. `rpc.ts:967` abort: route through `this.codec.encode(...)` too (consistency when CBOR is on)
5. `readLoop()`: `JSON.parse(msgText)` → `this.codec.decode(wire)`
6. `RpcTransport` interface (`rpc.ts:30`) widens to `send(message: string | Uint8Array)` /
   `receive(): Promise<string | Uint8Array>`

All CBOR logic lives in its own tree; nothing CBOR-specific leaks into core files:

```
src/codec/
  index.ts          Codec interface + jsonCodec (default)
  json.ts           JsonCodec
  cbor/
    index.ts        createCborCodec(opts?) — the only file that imports cbor-x
    encode.ts       cbor-x Encoder/Decoder wiring (adapted from cbor-reference/codec.ts)
    state.ts        snapshotState()/restoreState() for hibernation
```

### Transports carry `string | Uint8Array`

Each branches on type, so the JSON path is unchanged and the binary path is added alongside:

- **`WebSocketTransport`** (`websocket.ts:437`): `WebSocket.send` already accepts both; set
  `binaryType = "arraybuffer"` and accept binary frames where it currently rejects non-string
  (`websocket.ts:467`).
- **`HibernatableWebSocketTransport`** (`websocket.ts:536`): same; `pushIncoming`
  (`websocket.ts:622`) stops rejecting non-string (`websocket.ts:635`) and accepts
  ArrayBuffer/Uint8Array.
- **`batch.ts`**: framing must branch. JSON keeps the existing `\n`-join
  (`batch.ts:75`/`batch.ts:146`) so existing capnweb peers stay compatible; binary uses
  length-prefix framing + `application/octet-stream`. Contained entirely in `batch.ts`.
- **`messageport.ts`** (`messageport.ts:32/56/63`): accept binary alongside string.

### Dependency isolation (truly optional)

- package.json `exports`: add a `"./codec/cbor"` subpath.
- `cbor-x` as an **optional peer dependency** (`peerDependenciesMeta.cbor-x.optional: true`),
  or `optionalDependencies`.
- Core `capnweb` never references cbor-x; only users who
  `import { createCborCodec } from "capnweb/codec/cbor"` pull it in. `createCborCodec` can
  `await import("cbor-x")` lazily so bundlers tree-shake it out otherwise.

### Negotiation — v1 recommendation: explicit, same codec both ends

Simplest, no protocol change, fully meets "optional." Document that client and server must
construct with the same codec. Layerable later:
- HTTP batch: auto-detect via `Content-Type: application/cbor` / `Accept`.
- WebSocket: a subprotocol (`Sec-WebSocket-Protocol: capnweb.cbor`) or sniff the first frame's
  type (string → json, binary → cbor).

---

## Goal 3 — hibernation compatibility, via the *mature* mechanism

Two cleanly separable concerns.

### (A) Snapshot serialization is already orthogonal to the wire codec

The session snapshot (`RpcSessionSnapshot`, `hibernation.ts:37`) is persisted as JSON
(`websocket.ts:211`) and optionally encrypted (`seal({plaintext: string})`,
`hibernation.ts:80`), then stored in the WebSocket attachment or session store. Both
JSON-wire and CBOR-wire encode the *same devalued structures*, so **CBOR on the wire + JSON
snapshots coexist with zero changes.** Nothing to do here.

### (B) The stateful-codec dilemma — solved by piggybacking on the working snapshot

A stateful CBOR codec (path cache, string interning, cbor-x learned structures) keeps that
state only in memory. On hibernate it's destroyed while the peer keeps its half → desync on
resume. This is what killed the old branch. The fix reuses main's *working* snapshot/restore:

1. Codec gains optional `snapshotState()` / `restoreState()` (see Goal 1 interface).
2. `RpcSessionSnapshot` (`hibernation.ts:37`) gains an optional field and bumps to version 3:
   ```ts
   codec?: { id: string; state: unknown };   // state is JSON-serializable
   ```
3. `__experimental_snapshot()` (`rpc.ts:742`): if `this.codec.snapshotState`, capture
   `{ id: this.codec.id, state: this.codec.snapshotState() }`.
4. `restoreFromSnapshot()` (`rpc.ts:1309`): if `snapshot.codec` present, assert
   `snapshot.codec.id === this.codec.id` (fail-safe against config drift), then
   `this.codec.restoreState(snapshot.codec.state)`.

Because the codec state now rides inside the *same atomic snapshot* that already survives
hibernation (serializeAttachment / sessionStore / encryption), the codec rehydrates to its
exact pre-hibernation state and stays in sync with the client. The dilemma becomes a solved
problem.

> The old reference codec sketched exactly this (`__experimental_snapshotState/restoreState`
> and an old `RpcSessionSnapshot["codec"]` field) — but bolted to a hibernation layer that
> didn't work. Here it attaches to one that does.

### Graceful degradation

A *stateless* CBOR codec implements none of the optional hooks and needs zero hibernation
work — it just rides along. So ship stateless-first (lowest risk, immediately
hibernation-safe), then add stateful `snapshotState`/`restoreState` later for extra wire
savings, with no further core changes.

### Caveats to validate during implementation

- Codec state must be JSON-serializable (the reference codec's `string[][]` structures and
  path/string arrays qualify) — and we must confirm **cbor-x can export and re-seed its
  sequential-mode structure tables** deterministically. If it can't fully, fall back to
  stateless (still a win over JSON).
- The wire-codec *choice* must be stable across a session; the `codec.id` guard on restore
  catches accidental drift.

---

## Suggested build order

1. `Codec` interface + `jsonCodec`, wired at the `rpc.ts` seam. **No behavior change** — a pure
   refactor verifiable against the existing test suite.
2. Widen transports to `string | Uint8Array` (JSON path unchanged).
3. **Stateless** `createCborCodec` in `src/codec/cbor/` + the `capnweb/codec/cbor` export +
   optional dep. → working, hibernation-safe CBOR.
4. Add the `codec` field to `RpcSessionSnapshot` (v3) + `snapshotState`/`restoreState`. →
   **stateful** CBOR that survives hibernation.

Steps 1–3 deliver optional, modular, hibernation-compatible CBOR. Step 4 adds stateful wire
savings on the same foundation.
