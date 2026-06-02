// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { Encoder } from "cbor-x";
import type { Codec } from "../index.js";

/**
 * Options for {@link createCborCodec}. Reserved for future tuning; the codec is
 * stateless by default.
 */
export interface CborCodecOptions {
  // (intentionally empty for now — stateful optimizations come later and opt-in)
}

/**
 * Create a CBOR wire codec for capnweb, backed by `cbor-x`.
 *
 * This is an **optional** alternative to the default JSON codec, intended to cut
 * the number of bytes on the wire. Pass it via `RpcSessionOptions.codec`; both
 * ends of a session must use the same codec.
 *
 * **Stateless.** `useRecords: false` keeps each message fully self-contained —
 * no structure table, path cache or string interning is shared across messages.
 * Statelessness is what makes this codec safe across Durable Object hibernation
 * with no extra work: there is no accumulated codec state to lose on hibernate or
 * to fall out of sync with the peer. (Stateful, higher-compression variants are a
 * later, opt-in step that ride codec state through the session snapshot.)
 *
 * Requires the optional `cbor-x` peer dependency to be installed.
 */
export function createCborCodec(_options: CborCodecOptions = {}): Codec {
  // A single Encoder instance both encodes and decodes (Encoder extends Decoder).
  // capnweb's "devalued" messages are plain JSON-compatible structures (arrays,
  // objects, strings, numbers, booleans, null), so no special tag handling is
  // needed — CBOR encodes them directly and decodes maps back to plain objects.
  const encoder = new Encoder({
    useRecords: false,
  });

  return {
    id: "cbor",

    encode(message: unknown): Uint8Array {
      // cbor-x returns a Uint8Array (Buffer in Node, which is a Uint8Array subclass).
      return encoder.encode(message);
    },

    decode(wire: string | Uint8Array): unknown {
      if (typeof wire === "string") {
        // A text frame reaching the CBOR codec means the peer is almost certainly
        // speaking a different codec (e.g. plain JSON). Fail loudly rather than
        // mis-decoding.
        throw new TypeError(
          "CBOR codec received a text frame; the peer may be using a different wire codec.");
      }
      return encoder.decode(wire);
    },
  };
}
