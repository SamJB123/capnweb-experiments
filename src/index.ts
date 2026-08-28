// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import {
  RpcTarget as RpcTargetImpl,
  RpcStub as RpcStubImpl,
  RpcPromise as RpcPromiseImpl,
  __experimental_debugRpcReference as __experimental_debugRpcReferenceImpl,
  __experimental_streamCall as __experimental_streamCallImpl,
  __experimental_releaseCall as __experimental_releaseCallImpl,
  __experimental_onewayCall as __experimental_onewayCallImpl,
} from "./core.js";
import { serialize, deserialize, EncodingLevel } from "./serialize.js";
import { RpcTransport, RpcTransportWithCustomEncoding, AnyRpcTransport, RpcSession as RpcSessionImpl, RpcSessionOptions } from "./rpc.js";
import { RpcLimits, DEFAULT_LIMITS, DEFAULT_MAX_DEPTH } from "./serialize.js";
import type { RpcSessionDebugState } from "./rpc.js";
import type { HibernatableSessionStore, RpcSessionSnapshot } from "./hibernation.js";
import { RpcTargetBranded, RpcCompatible, Stub, ElideStub, PayloadOrStub,
         type RpcPromise as RpcPromiseType, __RPC_TARGET_BRAND } from "./types.js";
import { newWebSocketRpcSession as newWebSocketRpcSessionImpl,
         newWorkersWebSocketRpcResponse, WebSocketTransport,
         __experimental_newHibernatableWebSocketRpcSession as __experimental_newHibernatableWebSocketRpcSessionImpl,
         __experimental_resumeHibernatableWebSocketRpcSession as __experimental_resumeHibernatableWebSocketRpcSessionImpl,
         __experimental_cleanupOrphanedSessions as __experimental_cleanupOrphanedSessionsImpl,
         __experimental_hibernatableWebSocketSessionId as __experimental_hibernatableWebSocketSessionIdImpl,
         type HibernatableWebSocketOptions } from "./websocket.js";
import { newHttpBatchRpcSession as newHttpBatchRpcSessionImpl,
         newHttpBatchRpcResponse, nodeHttpBatchRpcResponse,
         type HttpBatchSessionOptions } from "./batch.js";
import type { Codec } from "./codec/index.js";
import { newMessagePortRpcSession as newMessagePortRpcSessionImpl } from "./messageport.js";
import { forceInitMap } from "./map.js";
import { forceInitStreams } from "./streams.js";

forceInitMap();
forceInitStreams();

// Re-export public API types.
export { serialize, deserialize, newWorkersWebSocketRpcResponse, newHttpBatchRpcResponse,
         nodeHttpBatchRpcResponse, WebSocketTransport, DEFAULT_LIMITS, DEFAULT_MAX_DEPTH };
export { jsonCodec } from "./codec/index.js";
export type { Codec } from "./codec/index.js";
export { CodecTransport } from "./codec/transport.js";
export type { CodecTransportInner, CodecTransportOptions } from "./codec/transport.js";
export type { HttpBatchSessionOptions } from "./batch.js";
export { __experimental_newDurableObjectSessionStore } from "./hibernation.js";
export { __experimental_newWebCryptoSnapshotSecurity } from "./snapshot-security.js";
export type { WebCryptoSnapshotSecurityOptions } from "./snapshot-security.js";
export type { RpcTransport, RpcTransportWithCustomEncoding, AnyRpcTransport,
         RpcSessionOptions, RpcCompatible, EncodingLevel, RpcLimits };
export type {
  HibernatableEncryptedSnapshotEnvelope,
  HibernatableSnapshotSecurity,
  HibernatableSnapshotSecurityInput,
  HibernatableSnapshotSecurityOpenInput,
  HibernatableSnapshotStorageMode,
  HibernatableSessionStore,
  HibernatableStoredSnapshot,
  HibernatableWebSocketAttachment,
  RpcSessionSnapshot,
  RpcSessionSnapshotImport,
  RpcSessionSnapshotExport,
} from "./hibernation.js";
export type { HibernatableWebSocketOptions };

// Hack the type system to make RpcStub's types work nicely!
/**
 * Represents a reference to a remote object, on which methods may be remotely invoked via RPC.
 *
 * `RpcStub` can represent any interface (when using TypeScript, you pass the specific interface
 * type as `T`, but this isn't known at runtime). The way this works is, `RpcStub` is actually a
 * `Proxy`. It makes itself appear as if every possible method / property name is defined. You can
 * invoke any method name, and the invocation will be sent to the server. If it turns out that no
 * such method exists on the remote object, an exception is thrown back. But the client does not
 * actually know, until that point, what methods exist.
 */
export type RpcStub<T extends RpcCompatible<T>> = Stub<T>;
export const RpcStub: {
  new <T extends RpcCompatible<T>>(value: T): RpcStub<T>;
} = <any>RpcStubImpl;

/**
 * Represents the result of an RPC call.
 *
 * Also used to represent properties. That is, `stub.foo` evaluates to an `RpcPromise` for the
 * value of `foo`.
 *
 * This isn't actually a JavaScript `Promise`. It does, however, have `then()`, `catch()`, and
 * `finally()` methods, like `Promise` does, and because it has a `then()` method, JavaScript will
 * allow you to treat it like a promise, e.g. you can `await` it.
 *
 * An `RpcPromise` is also a proxy, just like `RpcStub`, where calling methods or awaiting
 * properties will make a pipelined network request.
 *
 * Note that and `RpcPromise` is "lazy": the actual final result is not requested from the server
 * until you actually `await` the promise (or call `then()`, etc. on it). This is an optimization:
 * if you only intend to use the promise for pipelining and you never await it, then there's no
 * need to transmit the resolution!
 *
 * You may also construct an `RpcPromise` yourself from a regular `Promise`, using
 * `new RpcPromise(promise)`, allowing you to perform promise pipelining on a local promise. This
 * is semantically identical to creating a local-loopback RPC that returns the promise, and then
 * invoking it: pipelined calls wait until the promise resolves, then are delivered, in order, to
 * the resolution. This is useful when you plan to obtain some stub in the future, but want to
 * allow code to start queuing calls on it immediately. Note that the `RpcPromise` takes
 * ownership of the resolution: disposing it disposes the resolution, so resolve the promise
 * with a `dup()` if you also intend to keep the stub.
 */
export type RpcPromise<T extends RpcCompatible<T>> = RpcPromiseType<T>;
export const RpcPromise: {
  // The return type applies `ElideStub` — the same transformation `Result` applies to a
  // declared stub return — so constructing from a promised stub produces exactly the type a
  // method returning that stub would. See `PayloadOrStub` for what the promise may resolve to.
  //
  // Two overloads, for inference reasons. A context-sensitive argument — e.g.
  // `Promise.resolve({f() { ... }})`, where the method's return type must be inferred — is
  // contextually typed against the first overload only, and a contextual type containing a
  // `Stub` arm collapses such an argument's inference. The first overload therefore keeps its
  // parameter a plain `Promise<T>`. Since `PayloadOrStub`'s stub arm is `NoInfer` anyway, both
  // overloads infer identically; the second one matters only when `T` is explicitly annotated
  // and the payload is a stub, e.g. `new RpcPromise<Counter>(promiseOfStub)`.
  new <T extends RpcCompatible<T>>(value: Promise<T>): RpcPromiseType<ElideStub<T>>;
  new <T extends RpcCompatible<T>>(value: Promise<PayloadOrStub<T>>): RpcPromiseType<ElideStub<T>>;
} = <any>RpcPromiseImpl;

/**
 * Use to construct an `RpcSession` on top of a custom `RpcTransport`.
 *
 * Most people won't use this. You only need it if you've implemented your own `RpcTransport`.
 */
export interface RpcSession<T extends RpcCompatible<T> = undefined> {
  getRemoteMain(): RpcStub<T>;
  getStats(): {imports: number, exports: number};

  // Waits until the peer is not waiting on any more promise resolutions from us. This is useful
  // in particular to decide when a batch is complete.
  drain(): Promise<void>;

  /**
   * EXPERIMENTAL: Capture a snapshot of this session's state (export/import tables, and any
   * stateful wire-codec state) so the session can be restored after hibernation. Pair with
   * `RpcSessionOptions.__experimental_restoreSnapshot`.
   */
  __experimental_snapshot(): RpcSessionSnapshot;
}
export const RpcSession: {
  new <T extends RpcCompatible<T> = undefined>(
      transport: AnyRpcTransport, localMain?: any, options?: RpcSessionOptions): RpcSession<T>;
} = <any>RpcSessionImpl;

// RpcTarget needs some hackage too to brand it properly and account for the implementation
// conditionally being imported from "cloudflare:workers".
/**
 * Classes which are intended to be passed by reference and called over RPC must extend
 * `RpcTarget`. A class which does not extend `RpcTarget` (and which doesn't have built-in support
 * from the RPC system) cannot be passed in an RPC message at all; an exception will be thrown.
 *
 * Note that on Cloudflare Workers, this `RpcTarget` is an alias for the one exported from the
 * "cloudflare:workers" module, so they can be used interchangably.
 */
export interface RpcTarget extends RpcTargetBranded {};
export const RpcTarget: {
  new(): RpcTarget;
} = RpcTargetImpl;

/**
 * Empty interface used as default type parameter for sessions where the other side doesn't
 * necessarily export a main interface.
 */
interface Empty {}

/**
 * RPC session restored on top of a hibernating WebSocket. `T` is the interface
 * the peer exposes — `getRemoteMain()` returns a typed stub for it. Mirrors
 * the typing relationship between `RpcSession<T>` and `getRemoteMain(): RpcStub<T>`.
 */
export interface HibernatableWebSocketSession<T extends RpcCompatible<T> = Empty> {
  sessionId: string;
  getRemoteMain(): RpcStub<T>;
  getStats(): {imports: number, exports: number};
  __experimental_snapshot(): RpcSessionSnapshot;
  __experimental_debugState(): RpcSessionDebugState;
  handleMessage(message: string | ArrayBuffer): void;
  handleClose(code?: number, reason?: string, wasClean?: boolean): void;
  handleError(error: any): void;
}

/**
 * Start a WebSocket session given either an already-open WebSocket or a URL.
 *
 * @param webSocket Either the `wss://` URL to connect to, or an already-open WebSocket object to
 * use.
 * @param localMain The main RPC interface to expose to the peer. Returns a stub for the main
 * interface exposed from the peer.
 */
export let newWebSocketRpcSession:<T extends RpcCompatible<T> = Empty>
    (webSocket: WebSocket | string, localMain?: any,
     options?: RpcSessionOptions & { codec?: Codec }) => RpcStub<T> =
    <any>newWebSocketRpcSessionImpl;

/**
 * Initiate an HTTP batch session from the client side.
 *
 * The parameters to this method have exactly the same signature as `fetch()`, but the return
 * value is an RpcStub. You can customize anything about the request except for the method
 * (it will always be set to POST) and the body (which the RPC system will fill in).
 */
export let newHttpBatchRpcSession:<T extends RpcCompatible<T>>
    (urlOrRequest: string | Request, options?: HttpBatchSessionOptions) => RpcStub<T> =
    <any>newHttpBatchRpcSessionImpl;

/**
 * Initiate an RPC session over a MessagePort, which is particularly useful for communicating
 * between an iframe and its parent frame in a browser context. Each side should call this function
 * on its own end of the MessageChannel.
 */
export let newMessagePortRpcSession:<T extends RpcCompatible<T> = Empty>
    (port: MessagePort, localMain?: any, options?: RpcSessionOptions) => RpcStub<T> =
    <any>newMessagePortRpcSessionImpl;

export let __experimental_newHibernatableWebSocketRpcSession:<T extends RpcCompatible<T> = Empty>
    (webSocket: WebSocket, localMain: any, options: HibernatableWebSocketOptions) => Promise<HibernatableWebSocketSession<T> | undefined> =
    <any>__experimental_newHibernatableWebSocketRpcSessionImpl;

export let __experimental_resumeHibernatableWebSocketRpcSession:<T extends RpcCompatible<T> = Empty>
    (webSocket: WebSocket, localMain: any, options: HibernatableWebSocketOptions) => Promise<HibernatableWebSocketSession<T> | undefined> =
    <any>__experimental_resumeHibernatableWebSocketRpcSessionImpl;

export let __experimental_cleanupOrphanedSessions:
    (webSockets: WebSocket[], sessionStore: HibernatableSessionStore) => Promise<number> =
    __experimental_cleanupOrphanedSessionsImpl;

export let __experimental_hibernatableWebSocketSessionId:
    (webSocket: WebSocket) => string | undefined =
    __experimental_hibernatableWebSocketSessionIdImpl;

export const __experimental_debugRpcReference:
    (value: unknown) => Record<string, unknown> =
    <any>__experimental_debugRpcReferenceImpl;

/**
 * Fire-and-forget call on a stub via the self-cleaning `["stream"]` path (auto-pulled and
 * auto-released on both sessions). `args` is the argument list. The returned promise resolves
 * once the receiver has processed the call - usable for backpressure, safe to ignore.
 *
 * Background: an ordinary un-awaited stub call leaves an unresolved import/export pair on both
 * sessions (nothing pulls it, so nothing releases it). For hot, result-less calls use one of
 * these three helpers instead; they differ only in what crosses the wire.
 */
export const __experimental_streamCall:
    (stub: unknown, path: string | string[], args: unknown[]) => Promise<void> =
    __experimental_streamCallImpl;

/**
 * Fire-and-forget via an ordinary push followed by an immediate release of the result. Unlike
 * `__experimental_streamCall` the receiver sends nothing back; the only extra frame is the
 * caller's outbound release. Both sessions still clean up fully.
 */
export const __experimental_releaseCall:
    (stub: unknown, path: string | string[], args: unknown[]) => void =
    __experimental_releaseCallImpl;

/**
 * True single-message fire-and-forget via the `["oneway"]` wire message: one outbound frame, no
 * reply, no table entries on either side. Data calls only - the result is dropped and a failure
 * is never reported back. Both peers must understand `["oneway"]` (this fork, 0.12.0-hibernation-cbor.1
 * or later); through a resolved or local hook it degrades to call + dispose.
 */
export const __experimental_onewayCall:
    (stub: unknown, path: string | string[], args: unknown[]) => void =
    __experimental_onewayCallImpl;

/**
 * Implements unified handling of HTTP-batch and WebSocket responses for the Cloudflare Workers
 * Runtime.
 *
 * SECURITY WARNING: This function accepts cross-origin requests. If you do not want this, you
 * should validate the `Origin` header before calling this, or use `newHttpBatchRpcSession()` and
 * `newWebSocketRpcSession()` directly with appropriate security measures for each type of request.
 * But if your API uses in-band authorization (i.e. it has an RPC method that takes the user's
 * credentials as parameters and returns the authorized API), then cross-origin requests should
 * be safe.
 */
export async function newWorkersRpcResponse(
    request: Request, localMain: any, options?: RpcSessionOptions) {
  if (request.method === "POST") {
    let response = await newHttpBatchRpcResponse(request, localMain, options);
    // Since we're exposing the same API over WebSocket, too, and WebSocket always allows
    // cross-origin requests, the API necessarily must be safe for cross-origin use (e.g. because
    // it uses in-band authorization, as recommended in the readme). So, we might as well allow
    // batch requests to be made cross-origin as well.
    response.headers.set("Access-Control-Allow-Origin", "*");
    return response;
  } else if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return newWorkersWebSocketRpcResponse(request, localMain, options);
  } else {
    return new Response("This endpoint only accepts POST or WebSocket requests.", { status: 400 });
  }
}
