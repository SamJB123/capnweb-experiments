# CBOR codec — reference material

This directory preserves the **evolved CBOR codec** from the old, abandoned `cbor`
branch as a *study reference* for reviving optional cbor-x wire support in this
fork. It is **not** live code and is **not** meant to be wired up verbatim.

- `codec.ts` — the 583-line codec lifted verbatim from `cbor` branch `src/codec.ts`
  (tip commit `2ef670f`). Banner added; otherwise unchanged. It does **not** compile
  in this tree (its `./message-types.js` / `./hibernation.js` imports belonged to the
  old branch).

## Why we didn't just "remove hibernation from the cbor branch"

The original ask was to strip hibernation out of the `cbor` branch to leave a clean,
cbor-only codebase. Investigating the branch showed that isn't possible, because the
branch's actual shape is different from how it was remembered:

1. **Hibernation predates cbor on that branch.** The parent of the very first cbor
   commit (`e49aa3f`, parent of `6920222 cbor`) *already* contained `src/hibernation.ts`
   and hibernation logic woven through `rpc.ts` / `websocket.ts`. cbor was built **on
   top of** hibernation. **No commit in the branch's history is hibernation-free.**

2. **The CBOR codec was never actually wired in.** Across the entire branch history
   there is no `import … from './codec'` on the message path and no `cborCodec.encode()`
   call site. `codec.ts` is orphaned scaffolding in every commit. The transports
   (`batch.ts`, `messageport.ts`, `websocket.ts`) were switched to binary framing, but
   `rpc.ts` still does `JSON.stringify` — so cbor was always WIP and never functionally
   connected.

3. **The branch tip is internally inconsistent.** Later hibernation merges reverted
   `websocket.ts` back to `string` transport while `batch.ts`/`messageport.ts` stayed
   `Uint8Array`, and the `RpcTransport` interface says `string`. It does not cohere as a
   cbor base.

So there was nothing clean to "reduce to." The genuinely-cbor work was just: this
codec, the binary-transport plumbing, a `PropertyPath` export in `core.ts`, and the
`benchmark.mjs` / `compare-sizes.mjs` sizing tools. The decision was to **start the
revival fresh on top of `main`** (the working hibernation fork) and keep this codec
only as a reference.

## The clean integration seam (in current `main`)

When re-integrating, the codec belongs at the JSON boundary in `src/rpc.ts`, sitting
**on top of** the unchanged `Devaluator`/`Evaluator` in `src/serialize.ts`:

- **Send** (`RpcSession.send()`, ~`rpc.ts:823`): `Devaluator.devaluate(...)` →
  `JSON.stringify` → `transport.send(string)`. The codec replaces only the
  `JSON.stringify` step.
- **Receive** (~`rpc.ts:1023`): `transport.receive()` → `JSON.parse` → `Evaluator`.
  The codec replaces only `JSON.parse`.

Recommended shape: a `Codec { encode(msg): string | Uint8Array; decode(wire): any }`
abstraction, default `JsonCodec` (zero behaviour change), optional `CborCodec`; cbor-x
as an optional/lazy dependency so it is never bundled unless enabled; widen
`RpcTransport` to `string | Uint8Array`. Keep hibernation snapshots as JSON regardless
of wire codec — wire codec and snapshot codec are orthogonal.

## The interesting problem: stateful codec vs. hibernation

A *stateless* codec (encode each message independently) plugs into hibernation with no
special handling. But the evolved codec in `codec.ts` is **stateful** for bigger wins:
it accumulates, across messages in a session, cbor-x sequential-mode structure
definitions, a `PropertyPath` reference registry, and a string-interning table. That
state is shared implicitly with the peer (the decoder learns it as it reads). On a
hibernating Durable Object, that in-memory state is **destroyed** on hibernate while
the peer keeps its half → encoder/decoder desync → stream corruption on resume. This is
why the old branch's codec carries a non-functional `__experimental_reset()` annotated
*"incomplete attempt at Hibernatable WebSocket support… does not yet work."*

**The opportunity** (the reason this codec is worth keeping as reference): the old
codec already gestured at the fix with `__experimental_snapshotState()` /
`__experimental_restoreState()` and an old `RpcSessionSnapshot["codec"]` field shaped
like:

```ts
codec: {
  encodePaths: PropertyPath[];
  decodePaths: PropertyPath[];
  encodeStrings: string[];
  decodeStrings: string[];
  decoderStructures?: string[][]; // cbor-x sequential-mode object shapes
}
```

That is exactly the idea worth pursuing — **but** the old hibernation it was bolted to
never worked. Current `main` has a *working* snapshot/restore mechanism that already
lets capnweb capabilities survive hibernation:

- `RpcSession.__experimental_snapshot()` — `src/rpc.ts:742`
- `RpcSession.restoreFromSnapshot()` — `src/rpc.ts:1309`
- snapshot types / encrypted envelope — `src/hibernation.ts`

If the codec's accumulated state were snapshotted/restored **through main's working
mechanism** (e.g. add a `codec` field to main's `RpcSessionSnapshot`, captured in
`__experimental_snapshot()` and replayed in `restoreFromSnapshot()`), a stateful CBOR
codec could survive hibernation without desync — turning the dilemma into a solved
problem rather than a blocker. That is the thing to design next.

## Provenance / source commits

- Old branch: `cbor` (tip `2ef670f`). Pure-cbor commits: `6920222` (cbor), `b15cc6c`
  (updates from practical testing), `f2ee9a1` (property path caching). Codec grew from
  41 → 171 → 583 lines; the 583-line features (sequential mode, interning, encoding
  modes) arrived in the later hibernation-era commits (`6f89caf`, `dc49c48`).
- This branch (`cbor-experiment`) is based on `main` @ `0.8.0-hibernation.0`.
