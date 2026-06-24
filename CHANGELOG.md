# capnweb

## 0.8.0-hibernation-cbor.5

Merges `0.8.0-hibernation.1` into the CBOR experiment line: the importReplay returned-capability rebind fix (`producesExportId`) — see the `0.8.0-hibernation.1` entry below for full details. No CBOR-codec changes.

## 0.8.0-hibernation-cbor.2

Experimental prerelease (npm `experimental` dist-tag). Iterates on the CBOR codec from `0.8.0-hibernation-cbor.1`.

### Added

- **Native bytes for binary codecs.** A `Uint8Array` is no longer base64-encoded before reaching the codec when the codec carries binary natively — CBOR now stores a compact byte string instead of inflated base64 text (~33% smaller for binary payloads; the win scales with payload size). The `["bytes", …]` token shape is unchanged; only the payload representation differs, and only on a binary codec.
  - Implemented as a minimal, codec-agnostic core hook: `Exporter` gains an optional `wantsBinaryBytes()`; the `Devaluator` emits raw bytes when it returns true (else the existing base64 path, unchanged) and the `Evaluator` additionally accepts a raw `Uint8Array`. The default JSON codec leaves `Codec.binary` unset, so the JSON/text wire is byte-identical and can never accidentally emit raw bytes.

### Notes

- Still experimental, not yet validated in a live runtime. Both ends of a session must use the same codec (and matching `optimizeEnvelope`).

## 0.8.0-hibernation-cbor.1

Experimental prerelease (npm `experimental` dist-tag). Iterates on the optional CBOR codec from `0.8.0-hibernation-cbor.0`.

### Added

- **Envelope optimization** (`createCborCodec({ optimizeEnvelope: true })`). capnweb's protocol envelope is tagged *arrays* (`["push", …]`, `["pipeline", …]`, `["setPose"]`), which cbor-x's structure-sharing cannot compress. This reshapes every string-headed protocol array into a one-key map `{ <tag>: [args] }` carried under a private CBOR tag, so the repeated tag/method strings become a shared structure id after first use. Most effective with `stateful: true`. Measured on a high-frequency pose update (push + release): JSON 79B → stateless/stateful CBOR 58B → stateful + envelope **47B** (~41% under JSON). This is what makes the stateful structure table actually pay off for the array-based protocol.
  - The reshape is a **provably injective bijection** carried under a disjoint CBOR-tag namespace, so user data can never be decoded as a protocol token: a user object `{push:[…]}` stays an untagged map. Forged tags from a hostile peer (wrapping non-objects, empty/multi-key maps, etc.) are rejected. Backed by an adversarial test suite (28 cases) plus a `__proto__`/prototype-pollution guard.

### Notes

- Still experimental and not yet validated in a live runtime (real WebSocket / Durable Object hibernate-wake). Both ends of a session must use the same codec **and** the same `optimizeEnvelope` setting.

## 0.8.0-hibernation-cbor.0

Experimental prerelease published under the npm `experimental` dist-tag (not `latest`, which stays at `0.8.0-hibernation.0`). Adds an **optional CBOR wire codec** as an alternative to the default JSON wire format, to reduce bytes on the wire. Built on top of `0.8.0-hibernation.0`.

### Added

- **Pluggable wire codec.** `RpcSessionOptions` gains an optional `codec`. When omitted, the wire format is byte-identical to before (JSON). Both ends of a session must use the same codec.
- **Optional CBOR codec** at the `capnweb/codec/cbor` subpath: `createCborCodec()`. `cbor-x` is an *optional* peer dependency — it is never bundled into the core and is only loaded if you import this subpath. Install it yourself to use CBOR.
  - **Stateless (default):** each message is fully self-contained; hibernation-safe with no extra work.
  - **Stateful (`{ stateful: true }`):** cbor-x "sequential" mode shares object-shape definitions across messages for smaller payloads. Its accumulated decoder state is carried through the hibernation snapshot, so it survives hibernation in sync with a non-hibernating peer (reusing the same mechanism that already keeps capabilities alive across hibernation).
- `RpcSessionSnapshot` is now version 3 with an optional `codec` field; `__experimental_snapshot()` is surfaced on the public `RpcSession` interface. Stateless codecs continue to emit version-2 snapshots with no codec field.

### Notes

- The built-in transports (WebSocket, hibernatable WebSocket, MessagePort, Bun, HTTP batch) now carry `string | Uint8Array`; the JSON path is unchanged.
- This build is unit/integration-tested but not yet exercised in a live runtime (real WebSocket / Durable Object hibernate-wake cycle). Treat as experimental.

## 0.8.0-hibernation.1

### Hibernation fork

- **importReplay now rebinds a returned capability instead of disposing it.** A hibernatable call that *both* captured a client capability (so it was recorded in `importReplays`) *and* returned a capability the peer holds — e.g. a `subscribe(callback)` that returns a destructive-dispose `Subscription` handle — was previously broken across hibernation. On restore, `restoreFromSnapshot` re-evaluated the call (correctly re-establishing the side effect) and then `payload.dispose()`'d the result, running the returned capability's disposer and tearing down the very side effect it had just re-established — so the peer stopped receiving pushes after a wake. (A `subscribe(callback)` returning `void` was unaffected — disposing a void result is a no-op. A capability-returning call that captured nothing — e.g. `claimDriver()` — was also unaffected: it isn't recorded in `importReplays` and is restored lazily via export provenance.)

  The fix threads capnweb's own export id end to end, with no expression deep-comparison. When a replay-recorded call's result resolves to a **bare** `["export", N]` return, that capability's export id is recorded on the replay record as `producesExportId` (a field on the new `RpcSessionImportReplay` snapshot type). On restore the replay re-runs the call and **binds** its result in as that export's hook instead of disposing it; the lazy `getOrRestoreExportHook` then finds the hook already present and skips re-running — so the call is reconstructed exactly once, with no destructive disposal and no double reconstruction. The link is anchored on the positive call-result export slot (`ExportTableEntry.replayRecord`, transient), so it stays exact even for repeated identical calls.

  Known limitation: `producesExportId` is captured only for a bare `["export", N]` return. A capability returned *nested* inside an object or array is not yet rebound and is still disposed on restore. This is covered by an intentionally-failing test in `__tests__/hibernation-persistence.test.ts` ("nested capability returns (not yet supported)").

## 0.8.0-hibernation.0

Rebased the `capnweb-experimental-hibernation` fork onto upstream `capnweb` 0.8.0.

### Picked up from upstream

- **0.8.0** ([#155](https://github.com/cloudflare/capnweb/pull/155)) — Added `Blob` as a serializable type over RPC. `Blob` objects can now be passed as call arguments and return values. The MIME type (`blob.type`) is preserved across the wire.
- **0.8.0** ([#166](https://github.com/cloudflare/capnweb/pull/166)) — Errors' own properties (via `Object.keys()`) are now preserved across the wire. Attach fields like `code` or `details` to an `Error` and they propagate to the other side. `cause` and `AggregateError.errors` are also preserved.
- **0.8.0** ([#168](https://github.com/cloudflare/capnweb/pull/168)) — Fixed a memory leak that kept all messages received in a session pinned in memory until the session ended, due to surprising implementation details of JavaScript Promises.
- **0.8.0** ([#152](https://github.com/cloudflare/capnweb/pull/152)) — Fixed serialization for Invalid/NaN `Date` values.
- **0.7.0** ([#159](https://github.com/cloudflare/capnweb/pull/159)) — Added support for Bun's alternative WebSocket server API.

### Hibernation fork carry-overs (previously released as 0.6.5)

- `HibernatableWebSocketSession<T>` is now generic and `getRemoteMain()` returns `RpcStub<T>`. Both `__experimental_newHibernatableWebSocketRpcSession<T>` and `__experimental_resumeHibernatableWebSocketRpcSession<T>` now thread `T` through to the returned session, eliminating the need for `as unknown as RpcStub<T>` at every call site that needs the worker-side capability.
- Fixed an import-table leak in `sendCall`, `sendStream`, and `sendMap` when the args payload fails to serialize (e.g. non-serializable argument). The import-table entry is now allocated *after* `Devaluator.devaluate` succeeds, mirroring the upstream first-party shape and avoiding the orphan slot left behind on throw.
- Fixed an export leak / spurious `toJSON` RPC call triggered by snapshot capture in the `push` and `stream` receive handlers. `cloneRpcExpr(msg[2])` is now called once *before* `evaluateWithCurrentProvenance` mutates the expression in place; reusing the pre-mutation clone for both `importReplays` and `sourceExpr` prevents `JSON.stringify` from probing live `RpcStub` proxies created during evaluation.

## 0.8.0

### Minor Changes

- [#155](https://github.com/cloudflare/capnweb/pull/155) [`48f4d49`](https://github.com/cloudflare/capnweb/commit/48f4d495ef66e947612e80f36f4f9570b439e407) Thanks [@G4brym](https://github.com/G4brym)! - Add `Blob` as a serializable type over RPC. `Blob` objects can now be passed as call arguments and return values. The MIME type (`blob.type`) is preserved across the wire.

### Patch Changes

- [#166](https://github.com/cloudflare/capnweb/pull/166) [`7413e43`](https://github.com/cloudflare/capnweb/commit/7413e43b251a0db79e9c59e67d37f01c725818fe) Thanks [@aron-cf](https://github.com/aron-cf)! - Errors properties, using `Object.keys()`, are now preserved across the wire. Attach fields like `code` or `details` to an `Error` and they propagate to the other side. The `cause` and `errors` (for `AggregateError`) properties will also be preserved.

- [#168](https://github.com/cloudflare/capnweb/pull/168) [`25baebf`](https://github.com/cloudflare/capnweb/commit/25baebf7facfcdafb8cd46ea20b982cbc05557a4) Thanks [@kentonv](https://github.com/kentonv)! - Fix memory leak that kept all messages received in a session pinned in memory until the session ended, due to surprising implementation details of JavaScript Promises.

- [#152](https://github.com/cloudflare/capnweb/pull/152) [`9e499e2`](https://github.com/cloudflare/capnweb/commit/9e499e2ac38dd4b57403d7e3d3294412bfbace14) Thanks [@VastBlast](https://github.com/VastBlast)! - Fix serialization for Invalid/NaN dates

## 0.7.0

### Minor Changes

- [#159](https://github.com/cloudflare/capnweb/pull/159) [`7cb9132`](https://github.com/cloudflare/capnweb/commit/7cb91326387bea52a4dab889ed01a46f30ce4af0) Thanks [@aron-cf](https://github.com/aron-cf)! - Added support for Bun's alternative WebSocket server API.

## 0.6.5

### Patch Changes

- `HibernatableWebSocketSession<T>` is now generic and `getRemoteMain()` returns `RpcStub<T>`. Both `__experimental_newHibernatableWebSocketRpcSession<T>` and `__experimental_resumeHibernatableWebSocketRpcSession<T>` now thread `T` through to the returned session, eliminating the need for `as unknown as RpcStub<T>` at every call site that needs the worker-side capability.
- Fixed an import-table leak in `sendCall`, `sendStream`, and `sendMap` when the args payload fails to serialize (e.g. non-serializable argument). The import-table entry is now allocated *after* `Devaluator.devaluate` succeeds, mirroring the upstream first-party shape and avoiding the orphan slot left behind on throw.
- Fixed an export leak / spurious `toJSON` RPC call triggered by snapshot capture in the `push` and `stream` receive handlers. `cloneRpcExpr(msg[2])` is now called once *before* `evaluateWithCurrentProvenance` mutates the expression in place; reusing the pre-mutation clone for both `importReplays` and `sourceExpr` prevents `JSON.stringify` from probing live `RpcStub` proxies created during evaluation.

## 0.6.1

### Patch Changes

- [#148](https://github.com/cloudflare/capnweb/pull/148) [`189fa79`](https://github.com/cloudflare/capnweb/commit/189fa799f6ef26d0704b355c1e11a9ed9a362247) Thanks [@kentonv](https://github.com/kentonv)! - Fixed type overrides for Uint8Array's toBase64 and fromBase64 leaking into capnweb's public interface.

## 0.6.0

### Minor Changes

- [#145](https://github.com/cloudflare/capnweb/pull/145) [`5667226`](https://github.com/cloudflare/capnweb/commit/5667226688fad4e28508f7779d49c1c89e53f102) Thanks [@kentonv](https://github.com/kentonv)! - When Node's `Buffer` is available, Cap'n Web will now serialize it the same as `Uint8Array`, and will deserialize all byte arrays as `Buffer` by default. `Buffer` is a subclass of `Uint8Array`, so this should be compatible while being convenient in Node apps.

- [#142](https://github.com/cloudflare/capnweb/pull/142) [`60be60d`](https://github.com/cloudflare/capnweb/commit/60be60d504f6d6984e88a6ef558b91dee5afb97b) Thanks [@VastBlast](https://github.com/VastBlast)! - Major improvements to type definitions, fixing bugs and making them more accurate.

### Patch Changes

- [#145](https://github.com/cloudflare/capnweb/pull/145) [`5667226`](https://github.com/cloudflare/capnweb/commit/5667226688fad4e28508f7779d49c1c89e53f102) Thanks [@kentonv](https://github.com/kentonv)! - Fixed base64 encoding of very large byte arrays on platforms that don't support Uint8Array.toBase64().

## 0.5.0

### Minor Changes

- [#132](https://github.com/cloudflare/capnweb/pull/132) [`c2bb17b`](https://github.com/cloudflare/capnweb/commit/c2bb17b940b23eb8ab89be1e85538493cb4552ad) Thanks [@kentonv](https://github.com/kentonv)! - Added support for sending ReadableStream and WritableStream over RPC, with automatic flow control.

### Patch Changes

- [#129](https://github.com/cloudflare/capnweb/pull/129) [`10abaf3`](https://github.com/cloudflare/capnweb/commit/10abaf35dbf4de32ad1d91d4c3482dcba72f3e30) Thanks [@dmmulroy](https://github.com/dmmulroy)! - Fix RpcCompatible type to filter out symbol keys instead of mapping them to never

## 0.4.0

### Minor Changes

- [#121](https://github.com/cloudflare/capnweb/pull/121) [`32e362f`](https://github.com/cloudflare/capnweb/commit/32e362fd1ee465d3adfe810ba135bbea224ce32b) Thanks [@kentonv](https://github.com/kentonv)! - Improved compatibility with Cloudflare Workers' built-in RPC, particularly when proxying from one to the other.

## 0.3.0

### Minor Changes

- [#78](https://github.com/cloudflare/capnweb/pull/78) [`8a47045`](https://github.com/cloudflare/capnweb/commit/8a470458dd152a66d473be638626f668f8be47d9) Thanks [@itaylor](https://github.com/itaylor)! - The package now exports the type `RpcCompatible<T>` (previously called `Serializable<T>`, but not exported), which is needed when writing generic functions on `RpcStub` / `RpcPromise`.

### Patch Changes

- [#120](https://github.com/cloudflare/capnweb/pull/120) [`1c87560`](https://github.com/cloudflare/capnweb/commit/1c87560efe1b042f133e978f7a60ecd52f69a549) Thanks [@kentonv](https://github.com/kentonv)! - Fixed serialization of async functions.

- [#117](https://github.com/cloudflare/capnweb/pull/117) [`d21e4ca`](https://github.com/cloudflare/capnweb/commit/d21e4cacfa1305e271e89657f8167bc688ade438) Thanks [@codehz](https://github.com/codehz)! - Enhance Stubify and Unstubify for tuple types

## 0.2.0

### Minor Changes

- [#105](https://github.com/cloudflare/capnweb/pull/105) [`f4275f5`](https://github.com/cloudflare/capnweb/commit/f4275f5531472003fa8264e6434929c03eb54448) Thanks [@kentonv](https://github.com/kentonv)! - Fixed incompatibility with bundlers that don't support top-level await. The top-level await was used for a conditional import; it has been replaced with an approach based on "exports" in package.json instead.

- [#105](https://github.com/cloudflare/capnweb/pull/105) [`f4275f5`](https://github.com/cloudflare/capnweb/commit/f4275f5531472003fa8264e6434929c03eb54448) Thanks [@kentonv](https://github.com/kentonv)! - Support serializing Infinity, -Infinity, and NaN.

### Patch Changes

- [#105](https://github.com/cloudflare/capnweb/pull/105) [`f4275f5`](https://github.com/cloudflare/capnweb/commit/f4275f5531472003fa8264e6434929c03eb54448) Thanks [@kentonv](https://github.com/kentonv)! - Attempting to remotely access an instance property of an RpcTarget will now throw an exception rather than returning `undefined`, in order to help people understand what went wrong.

- [#107](https://github.com/cloudflare/capnweb/pull/107) [`aa4fe30`](https://github.com/cloudflare/capnweb/commit/aa4fe305f8037219bce822f9e9095303ff374c4f) Thanks [@threepointone](https://github.com/threepointone)! - chore: generate commonjs build

- [#105](https://github.com/cloudflare/capnweb/pull/105) [`f4275f5`](https://github.com/cloudflare/capnweb/commit/f4275f5531472003fa8264e6434929c03eb54448) Thanks [@kentonv](https://github.com/kentonv)! - Polyfilled Promise.withResolvers() to improve compatibility with old Safari versions and Hermes (React Native).
