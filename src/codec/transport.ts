// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import type { Codec } from "./index.js";
import type { RpcTransportWithCustomEncoding } from "../rpc.js";
import type { RpcSessionCodecState } from "../hibernation.js";
import { DEFAULT_LIMITS } from "../serialize.js";

/**
 * The byte/text-carrying transport a {@link CodecTransport} wraps. Any of the built-in transports
 * satisfies this at runtime: `WebSocketTransport` (its message listener accepts binary frames
 * regardless of the compile-time `T`), the hibernatable WebSocket transport, and the HTTP batch
 * transports (which frame binary bodies with length prefixes).
 */
export interface CodecTransportInner {
  send(message: string | Uint8Array): void | Promise<void>;
  receive(): Promise<string | Uint8Array | ArrayBuffer>;
  abort?(reason: any): void;
}

export interface CodecTransportOptions {
  /**
   * Maximum incoming wire-message size (bytes for binary frames, UTF-16 code units for text)
   * enforced BEFORE the codec decodes. Guards against resource-exhaustion from an untrusted
   * peer - the core session only applies its `maxMessageSize` limit at the "string" encoding
   * level, so the codec transport polices its own frames. Defaults to
   * `DEFAULT_LIMITS.maxMessageSize`. An over-limit frame rejects `receive()`, aborting the
   * session (matching the "string"-level semantics).
   */
  maxMessageSize?: number;
}

/**
 * Adapts a wire {@link Codec} onto upstream's custom-encoding transport seam: the session hands
 * this transport already-devalued message trees (at the codec's declared encoding level), the
 * codec turns them into bytes/text for the inner transport, and vice versa on receive.
 *
 * Most callers never construct this directly - passing `RpcSessionOptions.codec` wraps the
 * session's transport in a `CodecTransport` automatically.
 */
export class CodecTransport implements RpcTransportWithCustomEncoding {
  readonly encodingLevel: "jsonCompatible" | "jsonCompatibleWithBytes" | "structuredClonable";
  #inner: CodecTransportInner;
  #codec: Codec;
  #maxMessageSize: number;
  // First async send failure. The custom-encoding contract reports send errors via `receive()`
  // rejecting, so a rejected inner send must interrupt the (possibly already pending) receive.
  #sendFailure = Promise.withResolvers<never>();
  #sendFailed = false;

  constructor(inner: CodecTransportInner, codec: Codec, options?: CodecTransportOptions) {
    this.#inner = inner;
    this.#codec = codec;
    this.#maxMessageSize = options?.maxMessageSize ?? DEFAULT_LIMITS.maxMessageSize;
    this.encodingLevel =
        codec.encodingLevel ?? (codec.binary ? "jsonCompatibleWithBytes" : "jsonCompatible");
    // The failure promise may never be awaited (sessions that end cleanly); don't let its
    // rejection surface as unhandled.
    this.#sendFailure.promise.catch(() => {});
  }

  send(message: unknown): number | void {
    let wire = this.#codec.encode(message);
    let size = typeof wire === "string" ? wire.length : wire.byteLength;
    let result = this.#inner.send(wire);
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(err => {
        if (!this.#sendFailed) {
          this.#sendFailed = true;
          this.#sendFailure.reject(err);
        }
      });
    }
    return size;
  }

  async receive(): Promise<unknown> {
    let wire = await Promise.race([this.#inner.receive(), this.#sendFailure.promise]);
    let normalized: string | Uint8Array =
        wire instanceof ArrayBuffer ? new Uint8Array(wire) : wire;
    let size = typeof normalized === "string" ? normalized.length : normalized.byteLength;
    if (size > this.#maxMessageSize) {
      throw new TypeError(
          `Incoming message exceeds maximum size of ${this.#maxMessageSize}.`);
    }
    return this.#codec.decode(normalized);
  }

  abort(reason: any): void {
    this.#inner.abort?.(reason);
  }

  /** Stateful-codec snapshot support; see `RpcTransportWithCustomEncoding.snapshotState`. */
  snapshotState(): RpcSessionCodecState | undefined {
    if (!this.#codec.snapshotState) return undefined;
    return { id: this.#codec.id, state: this.#codec.snapshotState() };
  }

  restoreState(state: RpcSessionCodecState): void {
    if (state.id !== this.#codec.id) {
      throw new Error(
          `Snapshot codec mismatch: snapshot was made with codec "${state.id}" ` +
          `but this session uses codec "${this.#codec.id}".`);
    }
    this.#codec.restoreState?.(state.state);
  }
}
