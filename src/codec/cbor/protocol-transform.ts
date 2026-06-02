// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { addExtension } from "cbor-x";

/**
 * Optional "envelope optimization" for the CBOR codec.
 *
 * capnweb's devalued wire form is tagged ARRAYS — `["push", id, …]`,
 * `["pipeline", …]`, a method path `["setPose"]`, `["bytes", b64]`, etc. cbor-x's
 * structure-sharing only compresses repeating *object* shapes, so those repeated
 * protocol/method strings ship in full on every message. This module reshapes
 * every string-headed array into a one-key map `{ <head>: [rest…] }` carried under
 * a private CBOR tag, so cbor-x record-sharing can dedupe the head (the tag /
 * method name) across messages.
 *
 * ## Why this CANNOT let user data bleed into the protocol envelope
 *
 * - The reshape is a **total, injective bijection**. Encode replaces every
 *   string-headed array with a {@link ProtocolToken} (written under a private CBOR
 *   tag); everything else — objects, primitives, and arrays whose head is *not* a
 *   string — is structurally untouched. Decode is the exact inverse.
 * - The CBOR tag is a **disjoint namespace**. capnweb's devaluator only ever emits
 *   the JSON data model (strings/numbers/bool/null/arrays/objects) — it never
 *   emits a CBOR tag — so a tag on the wire can *only* have been written by this
 *   transform. Therefore a user object `{push:[…]}` stays an **untagged map** and
 *   decodes back to an object; it can never be mistaken for a `["push", …]` token.
 *   The disjointness is structural (by CBOR major type), not dependent on the walk
 *   visiting every node.
 * - Because decode is the exact inverse of encode, the reconstructed array tree is
 *   identical to what capnweb produced; capnweb's `Evaluator` then interprets it
 *   *positionally* exactly as it would for the JSON path. The transform adds no new
 *   interpretation, so it introduces no new bleed vector — capnweb's `Evaluator`
 *   remains the sole boundary against malicious peers (who could already craft any
 *   token over plain JSON).
 *
 * Note: genuine user arrays are escaped by capnweb to `[[…]]` (array-headed), so
 * they are never string-headed and never become tokens. A user array *of strings*
 * (`["a","b"]`) is reshaped internally but round-trips faithfully — it is
 * reconstructed to the identical array and un-escaped positionally by capnweb.
 *
 * ## Extensibility toward "skeleton + quarantined values" (option #5)
 *
 * {@link toProtocolTokens} is the single encode seam. A #5 variant would, at
 * user-data leaf nodes, push the value onto a side channel and emit a placeholder
 * here instead of inlining it — reusing the same token-detection rule, with the
 * decode side reading values back from that channel. The shape below (one pure
 * walk + a self-inverse tag extension) is intended to make that change local.
 */

// 1-byte CBOR tag (major type 6, value 13). Tag 13 is unused by cbor-x's own
// extensions (it reserves 0-5, 14, 15, 25, 27-29, 51, 256, 258, 259 and its high
// record tags), and a 1-byte tag keeps per-token overhead minimal.
const PROTOCOL_TOKEN_TAG = 13;

/** Marker for a string-headed protocol array, so cbor-x emits it under the tag. */
class ProtocolToken {
  constructor(public head: string, public rest: unknown[]) {}
}

let registered = false;

/** Register the (global, idempotent) cbor-x extension for {@link ProtocolToken}. */
export function ensureProtocolTokenExtension(): void {
  if (registered) return;
  registered = true;
  addExtension({
    Class: ProtocolToken,
    tag: PROTOCOL_TOKEN_TAG,
    encode(token: ProtocolToken, encode: (data: unknown) => Uint8Array): Uint8Array {
      // One-key map keyed by the head string → cbor-x record-shares the key set
      // (so "push"/"pipeline"/"setPose" become a structure id after first use).
      return encode({ [token.head]: token.rest });
    },
    // Inner values are decoded bottom-up (nested tokens are already arrays by now),
    // so we can rebuild the original [head, ...rest] array directly. Returning an
    // array rather than a ProtocolToken means no decode-side walk is needed.
    decode(map: Record<string, unknown>): unknown {
      const head = Object.keys(map)[0];
      return [head, ...(map[head] as unknown[])];
    },
  } as unknown as Parameters<typeof addExtension>[0]);
}

/**
 * Encode-side walk: replace every string-headed array with a {@link ProtocolToken}
 * (which the extension writes under the private tag). Objects, primitives, and
 * arrays whose head is not a string are recursed into but kept structurally as-is.
 *
 * Decoding needs no companion walk — the tag extension reconstructs arrays inline.
 */
export function toProtocolTokens(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length >= 1 && typeof value[0] === "string") {
      const rest = new Array(value.length - 1);
      for (let i = 1; i < value.length; i++) {
        rest[i - 1] = toProtocolTokens(value[i]);
      }
      return new ProtocolToken(value[0], rest);
    }
    return value.map(toProtocolTokens);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key in value as Record<string, unknown>) {
      out[key] = toProtocolTokens((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
