# capnweb

## 0.12.0-hibernation-cbor.0

### CBOR experiment line

- **Merged upstream capnweb 0.12.0** (from the 0.10.0 base). Notable upstream additions now in the fork: `RpcPromise` constructible from a `Promise` (with stub elision on the result type), argument/capture leak fixes on call failure paths, ArrayBuffer / typed-array / `URL` serialization, `setImmediate` batch flushing, the new `packages/docs` documentation site, and ASCII-only dist enforcement. The root `protocol.md` is gone upstream; the fork's caller-chosen `importId` wording for `push` / `stream` / `pipe` now lives in `packages/docs/src/content/docs/reference/protocol.md`. All hibernation and CBOR functionality is preserved on top; see the upstream 0.11.0–0.12.0 entries below for details.

## 0.10.0-hibernation-cbor.1

### CBOR experiment line

- **Fix: the public typed wrappers in `index.ts` now accept the `codec` option.** `0.10.0-hibernation-cbor.0`'s hand-written public signatures for `newWebSocketRpcSession` and `newHttpBatchRpcSession` still pinned `options` to bare `RpcSessionOptions`, so passing `codec` type-errored even though the runtime accepted it. Types only — no runtime change.

## 0.10.0-hibernation-cbor.0

### CBOR experiment line

- **Merged `0.10.0-hibernation.0`** (upstream capnweb 0.10.0 + the positive-base hibernation fix — see that entry below).
- **Re-based the codec architecture onto upstream's transport encoding levels.** The codec is now a transport concern, matching upstream's direction: a codec transport wrapper implements `RpcTransportWithCustomEncoding` at `jsonCompatibleWithBytes` level (or `structuredClonable` for a codec that opts in), replacing the session-owned codec plumbing. `RpcSessionOptions.codec` is retained as sugar — the session wraps its transport in the codec transport automatically — so existing callers are unchanged. The fork's `wantsBinaryBytes` mechanism is deleted: upstream's `jsonCompatibleWithBytes` level produces the identical raw `["bytes", Uint8Array]` token natively. `RpcTransport` reverts to upstream's string-only shape; binary rides the custom-encoding interface. MessagePort sessions no longer take a codec (upstream posts structured-clonable objects directly — strictly better than encoding to bytes over a port). Stateful codec snapshot state now rides via optional `snapshotState()`/`restoreState()` hooks on the custom-encoding transport; the snapshot's v3 `codec: {id, state}` shape and id-mismatch guard are unchanged. Incoming binary frames are size-capped by the wrapper before decode (default `DEFAULT_LIMITS.maxMessageSize`), restoring the resource-exhaustion protection upstream only applies at "string" level.

## 0.8.0-hibernation-cbor.7

Merges `0.8.0-hibernation.3` into the CBOR experiment line: adds the built-in WebCrypto snapshot security helper (`__experimental_newWebCryptoSnapshotSecurity`) and the adversarial security test suite — see the `0.8.0-hibernation.3` entry below for full details. No CBOR-codec changes.

## 0.8.0-hibernation-cbor.6

Merges `0.8.0-hibernation.2` into the CBOR experiment line: the importReplay returned-capability rebind fix now covers nested and multiple returns (`producesExportIds`) — see the `0.8.0-hibernation.2` entry below for full details. No CBOR-codec changes.

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

## 0.10.0-hibernation.0

### Hibernation fork

- **Merged upstream capnweb 0.10.0** (from 0.8.x base). Notable upstream additions now in the fork: transport encoding levels (`EncodingLevel`, generic `WebSocketTransport<T>`), configurable receiver-side resource limits (`RpcSessionOptions.limits`), error-deserialization hardening, and WebSocket close-reason truncation. All hibernation functionality is preserved on top; see the upstream 0.9.0–0.10.0 entries below for details.

- **Fixed: capturing calls pipelined off a call result now survive a hibernation wake.** Previously, a replay-recorded call whose base was a *positive* (transient call-result) export — e.g. `cap.persona().avatar(writer)` without awaiting `persona()` — failed on restore with `no such entry on exports table`, closing the socket `1011 "stale session"`, because positive exports are (correctly) dropped from snapshots while the replay expression still referenced one. Snapshots now carry `positiveBases`: for each positive pipeline base a replay references (transitively, deduplicated — recorded only for capturing calls, so there is no broad capture of positive exports), the base's own originating push expression. Restore re-evaluates these in ascending id order before replays run; peer-released bases are re-created only for the duration of replay evaluation and disposed after, and bases with an in-flight pull have the pull re-triggered. The previously-red REPRO stress test in `__tests__/hibernation-persistence.test.ts` is green (and its timing-sensitive control B can no longer fail from this cause).

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

## 0.12.0

### Minor Changes

- [#253](https://github.com/cloudflare/capnweb/pull/253) [`46de5a7`](https://github.com/cloudflare/capnweb/commit/46de5a7503e09242755c1bc59e67bdac37a5e8ab) Thanks [@ndisidore](https://github.com/ndisidore)! - Fixed methods declared to return `Promise<RpcStub<T>>` producing broken stub-of-stub result types; they now type the same as `Promise<T>`. If you annotated such a result as `RpcPromise<RpcStub<T>>`, write `RpcPromise<T>` instead.

- [#242](https://github.com/cloudflare/capnweb/pull/242) [`9751a4e`](https://github.com/cloudflare/capnweb/commit/9751a4eb7422712c92b8a5c2100bc3a562e0a433) Thanks [@ndisidore](https://github.com/ndisidore)! - `RpcPromise` can now be constructed from a `Promise`: pipelined calls queue in order until it settles, so you can publish a capability that doesn't exist yet.

### Patch Changes

- [#241](https://github.com/cloudflare/capnweb/pull/241) [`2de5871`](https://github.com/cloudflare/capnweb/commit/2de5871421d852c8d5a3db241ce6f5648db3104a) Thanks [@ndisidore](https://github.com/ndisidore)! - Fix RPC argument and capture leaks on failure paths: call arguments are now reliably disposed when a call is rejected, delivered to a broken or disposed stub, or fails to serialize.

- [#251](https://github.com/cloudflare/capnweb/pull/251) [`7a6e5da`](https://github.com/cloudflare/capnweb/commit/7a6e5da8cf9d14f766e35dd9b07aab5637803e11) Thanks [@ndisidore](https://github.com/ndisidore)! - The `RpcPromise` constructor now applies the same stub elision as method result types: wrapping a `Promise<RpcStub<T>>` produces the same `RpcPromise<T>` a method declared to return that stub would, plain-interface stub payloads keep their stub type, and promises resolving to inline object literals with methods now infer correctly.

- [#243](https://github.com/cloudflare/capnweb/pull/243) [`7e864a8`](https://github.com/cloudflare/capnweb/commit/7e864a872bab9f810f24f43c478af64c6c773b00) Thanks [@ndisidore](https://github.com/ndisidore)! - Fix WritableStream stubs leaking call arguments when the stub was already disposed or the call path was invalid. All failure paths in `WritableStreamStubHook.call()` now dispose the copied arguments, matching ReadableStream behavior.

## 0.11.1

### Patch Changes

- [#239](https://github.com/cloudflare/capnweb/pull/239) [`667958e`](https://github.com/cloudflare/capnweb/commit/667958e65517990afce7916e7fafa72cca67c525) Thanks [@Maximo-Guk](https://github.com/Maximo-Guk)! - Keep the published runtime bundles ASCII-only. A doc comment introduced in 0.11.0 carried a U+2212 into every dist bundle, which breaks consumers that inline the bundle through Latin-1-only APIs like `btoa()`. The comment is fixed and the build now fails if any non-ASCII byte reaches a runtime bundle in `dist/`.

## 0.11.0

### Minor Changes

- [#212](https://github.com/cloudflare/capnweb/pull/212) [`1cca1a2`](https://github.com/cloudflare/capnweb/commit/1cca1a212da1e8bc4f807725d96702f0b78207e1) Thanks [@codehz](https://github.com/codehz)! - Support RpcTargets (and other RPC stubs) as ReadableStream/WritableStream chunks without disposing their capabilities when `write()` returns. Stream chunk payloads now keep lifecycle tied to the chunk (via `Symbol.dispose` when needed) so methods on streamed stubs remain usable after the write resolves.

- [#201](https://github.com/cloudflare/capnweb/pull/201) [`7325f9d`](https://github.com/cloudflare/capnweb/commit/7325f9d5c80dd57fea896bb4696d22a102cf10a8) Thanks [@ttmx](https://github.com/ttmx)! - Support exact ArrayBuffer, DataView, and typed array serialization over RPC.

- [#224](https://github.com/cloudflare/capnweb/pull/224) [`064b0f3`](https://github.com/cloudflare/capnweb/commit/064b0f352a5928caa91fe8a1fbc1c717c4b1ee09) Thanks [@dimitropoulos](https://github.com/dimitropoulos)! - Support serializing `URL` objects over RPC.

### Patch Changes

- [#220](https://github.com/cloudflare/capnweb/pull/220) [`43aa384`](https://github.com/cloudflare/capnweb/commit/43aa384b211f180c6b91ec7d2aa9acf4b57b3fcd) Thanks [@ndisidore](https://github.com/ndisidore)! - Remove the ~1ms per-batch latency floor in the HTTP batch client on Node and Bun by flushing via `setImmediate` instead of the clamped `setTimeout(0)`.

- [#214](https://github.com/cloudflare/capnweb/pull/214) [`2a02db9`](https://github.com/cloudflare/capnweb/commit/2a02db961460c222b0643a92483255613c7f78d5) Thanks [@ndisidore](https://github.com/ndisidore)! - The RPC `ReadableStream` type accepts any RPC-compatible chunk type, matching `WritableStream`.

- [#238](https://github.com/cloudflare/capnweb/pull/238) [`1a1f0d4`](https://github.com/cloudflare/capnweb/commit/1a1f0d419b13de0cf78d611cf9b1c99bc650dc7c) Thanks [@Maximo-Guk](https://github.com/Maximo-Guk)! - Share one `RpcPromise` alias between `Result` and the public export. Deeply-nested RPC interfaces no longer blow the checker's depth budget: this fixes all "excessively deep" / "excessive stack depth" (TS2589/TS2321) errors under TypeScript 7 (tsgo) and reduces TypeScript 5.9 type instantiations by ~13%. `RpcPromise<T>` for primitive `T` now also carries the pipelining `Provider<T>` surface, matching what stub calls already returned.

## 0.10.0

### Minor Changes

- [#185](https://github.com/cloudflare/capnweb/pull/185) [`0b20ec6`](https://github.com/cloudflare/capnweb/commit/0b20ec655bc244072f78382b22ef295228b1d259) Thanks [@ndisidore](https://github.com/ndisidore)! - Add configurable receiver-side resource limits (`RpcSessionOptions.limits`) that cap bigint length, message nesting depth, and incoming message size to guard against untrusted-peer resource exhaustion (#184).

### Patch Changes

- [#190](https://github.com/cloudflare/capnweb/pull/190) [`6e5c562`](https://github.com/cloudflare/capnweb/commit/6e5c5622a326540e14602304da84fccf00b2d62d) Thanks [@taylorodell](https://github.com/taylorodell)! - Several correctness and robustness fixes:

  - Error deserialization no longer resolves an attacker-supplied error type name to an inherited `Object.prototype` member. `ERROR_TYPES` now has a null prototype, so a wire value such as `["error","constructor",...]` no longer resolves to `Object` (which produced a `String` wrapper instead of an `Error`, bypassing `instanceof Error` checks), and a name like `"toString"` no longer resolves to a non-constructor and throws. Unknown names correctly fall back to `Error`.
  - Error deserialization now filters inherited `Object.prototype` keys (and `toJSON`) out of an error's own-property bag, matching the behavior already applied when deserializing plain objects. Keys such as `__proto__`, `toString`, and `valueOf` are no longer copied onto deserialized errors.
  - Resolving an import that has already been resolved now disposes the redundant resolution instead of overwriting (and leaking) the previous one.
  - The `abort` message handler now hands error handlers the unwrapped abort reason rather than the internal payload wrapper, matching the `reject` handler.
  - WebSocket close reasons longer than the 123-byte limit are now truncated on a UTF-8 character boundary, so aborting a session with a long reason no longer throws from `WebSocket.close()`.

## 0.9.1

### Patch Changes

- [#195](https://github.com/cloudflare/capnweb/pull/195) [`78744ca`](https://github.com/cloudflare/capnweb/commit/78744ca99df8c93443556351b5849329765a930c) Thanks [@aleister1102](https://github.com/aleister1102)! - Fix nodeHttpBatchRpcResponse leaving the connection open and crashing with
  ERR_HTTP_HEADERS_SENT on non-POST requests. It now returns 405 immediately.

## 0.9.0

### Minor Changes

- [#186](https://github.com/cloudflare/capnweb/pull/186) [`c70bbb7`](https://github.com/cloudflare/capnweb/commit/c70bbb77ee5b25672f77d7befef7e711f4a98836) Thanks [@ashkalor](https://github.com/ashkalor)! - Add transport encoding levels so custom RPC transports can work with `jsonCompatible` values, `jsonCompatibleWithBytes` values, or `structuredClonable` messages instead of always receiving JSON strings.

  Note: `MessagePort` sessions now post structured-clonable objects over the port instead of JSON strings. This changes the wire format between the two ends of the port, so both ends of a `MessagePort` session must upgrade to this version together.

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
