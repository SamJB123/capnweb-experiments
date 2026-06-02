// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { Encoder, Decoder } from "cbor-x";
import type { Codec } from "../index.js";

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
 *   objects.
 */
export function createCborCodec(options: CborCodecOptions = {}): Codec {
  if (!options.stateful) {
    // Stateless: a single Encoder instance both encodes and decodes; no shared
    // structure table, so each message stands alone.
    const encoder = new Encoder({ useRecords: false });
    return {
      id: "cbor",
      encode(message: unknown): Uint8Array {
        return encoder.encode(message);
      },
      decode(wire: string | Uint8Array): unknown {
        return encoder.decode(decodeGuard(wire));
      },
    };
  }

  // Stateful: separate encoder/decoder instances so the two directions keep
  // independent structure tables. Only the decoder is given a structures array
  // (which cbor-x populates as it learns); that array is what we snapshot.
  const SEQ = { useRecords: true, sequential: true } as const;
  let decoderStructures: object[] = [];
  let encoder = new Encoder({ ...SEQ });
  let decoder = new Decoder({ ...SEQ, structures: decoderStructures });

  return {
    id: "cbor-sequential",

    encode(message: unknown): Uint8Array {
      return encoder.encode(message);
    },

    decode(wire: string | Uint8Array): unknown {
      return decoder.decode(decodeGuard(wire));
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
