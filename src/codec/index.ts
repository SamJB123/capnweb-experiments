// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

/**
 * A wire codec encodes/decodes already-"devalued" RPC messages (plain arrays,
 * objects and primitives — cap'n web's array-token form) to and from the bytes
 * or text that travel over a transport.
 *
 * The codec sits *on top of* `Devaluator`/`Evaluator`: by the time `encode` is
 * called the value is already a JSON-compatible structure, and `decode` must
 * return that same structure for the session's read loop to evaluate.
 *
 * The default codec is {@link jsonCodec}, which reproduces capnweb's standard
 * JSON wire format exactly. Alternative codecs (e.g. CBOR) are entirely
 * optional and opt-in per session via `RpcSessionOptions.codec`.
 */
export interface Codec {
  /**
   * Stable identifier for this codec (e.g. "json", "cbor"). Used as a guard
   * when restoring a hibernation snapshot, to detect a codec mismatch between
   * the snapshot and the session being resumed.
   */
  readonly id: string;

  /** Encode a devalued message for the wire. */
  encode(message: unknown): string | Uint8Array;

  /** Decode a wire message back into its devalued form. */
  decode(wire: string | Uint8Array): unknown;

  /**
   * OPTIONAL. Stateful codecs (those that accumulate per-session state such as
   * structure definitions, path caches or string interning) implement these so
   * their state can ride inside the session's hibernation snapshot and survive
   * hibernation in sync with the peer. The returned state MUST be
   * JSON-serializable. Stateless codecs omit these entirely.
   */
  snapshotState?(): unknown;
  restoreState?(state: unknown): void;

  /** OPTIONAL. Reset all accumulated state to that of a fresh codec. */
  reset?(): void;
}

export { jsonCodec } from "./json.js";
