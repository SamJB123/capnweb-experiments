// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import type { Codec } from "./index.js";

/**
 * The default capnweb wire codec: the standard JSON text format.
 *
 * `encode` always produces a string and `decode` accepts either a string or
 * (defensively) binary that is UTF-8 decoded first, so a JSON session remains
 * byte-for-byte compatible with the historical wire format.
 */
export const jsonCodec: Codec = {
  id: "json",

  encode(message: unknown): string {
    return JSON.stringify(message);
  },

  decode(wire: string | Uint8Array): unknown {
    const text = typeof wire === "string" ? wire : new TextDecoder().decode(wire);
    return JSON.parse(text);
  },
};
