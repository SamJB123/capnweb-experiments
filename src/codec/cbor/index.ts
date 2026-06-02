// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

// Use cbor-x's no-eval build: its eval build JIT-compiles record decoders with
// `new Function(...)`, which throws "Code generation from strings disallowed" in
// runtimes that ban dynamic code (Cloudflare Workers / workerd, strict CSP). The
// no-eval build reads records with a generic loop instead — identical wire format
// and features (useRecords/sequential/structures), only a slower decode path.
import { Encoder, Decoder } from "cbor-x/index-no-eval";
import type { Codec } from "../index.js";
import { ensureProtocolTokenExtension, toProtocolTokens, fromProtocolTokens } from "./protocol-transform.js";

/** Options for {@link createCborCodec}. */
export interface CborCodecOptions {
  /**
   * Enable cross-message structure sharing (cbor-x "sequential" mode). When an
   * object shape repeats across messages, its key set is defined once and then
   * referenced by id, making subsequent messages substantially smaller.
   *
   * This makes the codec **stateful**: it accumulates structure definitions over
   * the life of the connection. That state is snapshotted and restored across
   * hibernation automatically (via `snapshotState`/`restoreState`), so it stays
   * in sync with a peer that did not hibernate.
   *
   * Default `false` — stateless, each message fully self-contained.
   */
  stateful?: boolean;

  /**
   * Reshape capnweb's tagged-array protocol envelope into objects so cbor-x can
   * structure-share the repeated tag/method strings (`"push"`, `"pipeline"`,
   * `"setPose"`, …) — see {@link toProtocolTokens}. The reshape is a provably
   * injective bijection carried under a private CBOR tag, so user data can never
   * be confused for a protocol token.
   *
   * Only worthwhile together with `stateful: true` (the sharing it enables lives
   * in the sequential structure table). With a stateless codec it just adds tag
   * overhead. Default `false`.
   */
  optimizeEnvelope?: boolean;
}

function decodeGuard(wire: string | Uint8Array): Uint8Array {
  if (typeof wire === "string") {
    throw new TypeError(
      "CBOR codec received a text frame; the peer may be using a different wire codec.");
  }
  return wire;
}

/**
 * Create a CBOR wire codec for capnweb, backed by `cbor-x`.
 *
 * An **optional** alternative to the default JSON codec, to cut bytes on the
 * wire. Pass it via `RpcSessionOptions.codec`; both ends of a session must use
 * the same codec (and the same `stateful` setting).
 *
 * Requires the optional `cbor-x` peer dependency to be installed.
 *
 * ## Stateless (default)
 *
 * `useRecords: false` — each message is fully self-contained. Hibernation-safe
 * with no extra work, since there is no accumulated state to lose.
 *
 * ## Stateful (`{ stateful: true }`)
 *
 * cbor-x "sequential" mode shares structure definitions across messages for
 * smaller payloads. The codec keeps two independent structure tables (one per
 * direction), mirroring the export/import asymmetry of the RPC session itself:
 *
 * - The **decoder** table (shapes the peer defined, that we learned) MUST survive
 *   hibernation — the peer keeps sending definition-less references to those ids.
 *   `snapshotState()` captures it; `restoreState()` re-seeds a fresh decoder.
 * - The **encoder** table needs nothing: a structure definition is self-describing
 *   on the wire, so a fresh encoder simply re-emits definitions on resume (a few
 *   larger messages until it re-warms). This is the one place the codec is even
 *   simpler than capability hibernation, which needs provenance to rebuild live
 *   objects. (cbor-x also doesn't expose the encoder's table, so restarting it
 *   fresh is the only option — but as below, it's also the *correct* one.)
 *
 * ### Why restarting the encoder fresh is correct (not just convenient)
 *
 * cbor-x structure ids are **absolute** — baked into the CBOR record tag, not
 * positional. So when a fresh encoder re-defines a shape, the peer's decoder
 * **overwrites** the slot at that id rather than appending. And a fresh encoder
 * always emits a definition (overwriting the peer's slot) **before** it ever
 * references that id. Therefore every definition-less reference it later sends
 * points at a slot it just redefined and the peer just overwrote — they cannot
 * disagree, even if the fresh encoder assigns ids in a different order than
 * before hibernation. Re-defining is self-correcting; this is why we never need
 * to preserve encoder state.
 *
 * ### Glossary size is bounded by a high-water mark
 *
 * Because ids reset to 0 each connection-life and definitions overwrite, a
 * receiver's decoder table (what it persists in its DO WebSocket attachment)
 * does NOT accumulate across the peer's repeated hibernations. Its length equals
 * the most distinct object shapes the peer defined in any *single* life — not the
 * sum across lives. Slots above the current life's shape count may hold harmless
 * stale leftovers (never referenced, since the fresh encoder only references ids
 * it redefined this life); there is no active GC, but the overwrite behavior caps
 * total size at that high-water mark. (A peer that resets to id 0 each life thus
 * keeps the table *smaller* than a never-hibernating sequential sender, whose ids
 * grow with lifetime-total distinct shapes.) Note structures only form for object
 * shapes, not capnweb's array-based protocol envelope, so this is driven by
 * object-heavy user payloads.
 */
export function createCborCodec(options: CborCodecOptions = {}): Codec {
  // Envelope optimization: reshape string-headed protocol arrays into tagged maps
  // on encode so cbor-x can share the tag/method keys. Decode needs no companion
  // step — the tag extension reconstructs the arrays inline. `prep` is identity
  // when disabled, keeping the JSON-equivalent shape.
  const optimize = !!options.optimizeEnvelope;
  if (optimize) ensureProtocolTokenExtension();
  const prep = optimize ? toProtocolTokens : (m: unknown) => m;
  const post = optimize ? fromProtocolTokens : (m: unknown) => m;
  const protoSuffix = optimize ? "-proto" : "";

  if (!options.stateful) {
    // Stateless: a single Encoder instance both encodes and decodes; no shared
    // structure table, so each message stands alone. tagUint8Array:false → byte
    // arrays encode as bare CBOR byte strings (no extra tag).
    const encoder = new Encoder({ useRecords: false, tagUint8Array: false });
    return {
      id: "cbor" + protoSuffix,
      binary: true,
      encode(message: unknown): Uint8Array {
        return encoder.encode(prep(message));
      },
      decode(wire: string | Uint8Array): unknown {
        return post(encoder.decode(decodeGuard(wire)));
      },
    };
  }

  // Stateful: separate encoder/decoder instances so the two directions keep
  // independent structure tables. Only the decoder is given a structures array
  // (which cbor-x populates as it learns); that array is what we snapshot.
  const SEQ = { useRecords: true, sequential: true, tagUint8Array: false } as const;
  let decoderStructures: object[] = [];
  let encoder = new Encoder({ ...SEQ });
  let decoder = new Decoder({ ...SEQ, structures: decoderStructures });

  return {
    id: "cbor-sequential" + protoSuffix,
    binary: true,

    encode(message: unknown): Uint8Array {
      return encoder.encode(prep(message));
    },

    decode(wire: string | Uint8Array): unknown {
      return post(decoder.decode(decodeGuard(wire)));
    },

    snapshotState() {
      // The structures are arrays of key-name strings — already JSON-safe. Clone
      // so the snapshot is decoupled from the live (still-mutating) table.
      return { decoderStructures: JSON.parse(JSON.stringify(decoderStructures)) };
    },

    restoreState(state: unknown) {
      const restored = (state as { decoderStructures?: object[] })?.decoderStructures ?? [];
      decoderStructures = restored;
      // Re-seed the decoder with the learned structures; start the encoder fresh
      // (it self-heals by re-emitting self-describing definitions).
      decoder = new Decoder({ ...SEQ, structures: decoderStructures });
      encoder = new Encoder({ ...SEQ });
    },

    reset() {
      decoderStructures = [];
      decoder = new Decoder({ ...SEQ, structures: decoderStructures });
      encoder = new Encoder({ ...SEQ });
    },
  };
}
