# capnweb

## 0.8.0-hibernation.3

### Hibernation fork

- **Built-in WebCrypto snapshot security: `__experimental_newWebCryptoSnapshotSecurity`.** A ready-made `HibernatableSnapshotSecurity` so consumers no longer hand-roll the AES-GCM envelope. Pass the result as `snapshotSecurity` when creating a hibernatable session:

  ```ts
  const security = __experimental_newWebCryptoSnapshotSecurity(env.MY_SNAPSHOT_SECRET);
  // … { snapshotSecurity: security, snapshotSecurityAssociatedData: { userId } }
  ```

  It derives two subkeys from one high-entropy `secret` (SHA-256 with distinct domain-separation labels) — AES-GCM for `seal`/`open` (confidentiality + integrity) and HMAC-SHA-256 for the `fingerprint` write-elision marker — and binds the library-provided `associatedData` (which already folds in `sessionId` and the storage mode) as AES-GCM additional data, so a snapshot sealed for one session/user cannot be opened in another. `required` defaults to `true` (plaintext snapshots are refused on restore); an empty secret throws.

  The point of sealing, restated: a hibernation snapshot carries `importReplays` that are re-executed on wake, and it is persisted in DO storage / the WebSocket attachment. If an attacker can *write* that store, the only thing that stops a forged snapshot from being restored and replayed is a verification key they cannot reach — and the library's own storage *is* the thing under attack. So the `secret` must come from **outside** the snapshot store (a Worker secret binding, a KMS), never from DO storage or client input. The library supplies the enforcement (seal/open, reject-on-failure, `required`, context binding); you supply the key.

  The wire format (key-derivation labels, `AES-GCM` algorithm tag, base64url envelope fields) is fixed and matches the implementation previously carried in `@aicolab/room-service`, so snapshots sealed by that code remain openable after switching to this export — no session loss.

- **Adversarial security test suite (`__tests__/security.test.ts`).** Drives a real server `RpcSession` with raw, attacker-controlled protocol frames — not the typed client, which would never emit an attack — and asserts the **secure** outcome as each test's pass condition, so a genuine gap shows up as a failure rather than being assumed away. Coverage: data/capability confusion (escaping), forged capability references, prototype pollution, property/method access control, refcount/lifetime abuse, malformed frames, map-program sandboxing, and the hibernation snapshot trust boundary. Two snapshot tests are intentionally **red**: they assert a forged `importReplay` must NOT execute, which only holds once the snapshot is sealed with a key from outside the store — they document that dependency empirically instead of hiding it behind a green check.

## 0.8.0-hibernation.2

### Hibernation fork

- **importReplay now rebinds *every* returned capability, including nested and multiple returns.** This generalizes the `0.8.0-hibernation.1` fix and closes its known limitation: a replay-recorded call's result is no longer required to be a *bare* `["export", N]` return. Capabilities returned **nested arbitrarily deep** inside objects/arrays, and **any number of them** from a single call, now survive a hibernation wake instead of being disposed.

  `RpcSessionImportReplay.producesExportId?: number` becomes `producesExportIds?: number[]`. Capture no longer inspects the result's shape: a transient `currentResolveReplay` pointer (sibling to `currentNegativeExportProvenanceExpr`) is set around the resolve-time `Devaluator.devaluate`, and `exportStub`/`exportPromise` append **each** newly-created negative export id onto the active record. So every returned capability is registered wherever it sits in the value, with no structural special-casing. On restore, the replay re-evaluates the call **once** and binds each produced export from that single result via its own export provenance (a new non-consuming `deriveExportHookFromBase` helper, shared with the lazy `getOrRestoreExportHook` path), then disposes the shared base a single time. Each bound export holds an independent (deep-copied / pipelined) hook, so the capabilities survive on their own refcounts and disposing one never affects its siblings.

  Because the navigation is driven entirely by each export's own provenance, **conditional / role-based issuance is exact across a wake**: a call that returns a different set of capabilities depending on a (literal-argument) role rebinds precisely the capabilities that were issued — no more (no privilege escalation) and no fewer (nothing silently dropped). Covered by new stress tests in `__tests__/hibernation-persistence.test.ts` (multiple, deeply-nested object/array, independent disposal, and guest/moderator/admin role-based issuance), whose effectiveness is verified by a reverting mutation that turns every one of them red when the rebinding is neutralized.

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
