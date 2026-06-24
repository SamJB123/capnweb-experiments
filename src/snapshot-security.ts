// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import type { HibernatableSnapshotSecurity } from "./hibernation.js";

export interface WebCryptoSnapshotSecurityOptions {
  /**
   * Whether to refuse a plaintext (unsealed) snapshot on restore. Defaults to
   * `true` — leave it on. With `required: false`, an attacker who can write the
   * snapshot store could downgrade a sealed snapshot to plaintext and have it
   * accepted, defeating the point of sealing.
   */
  required?: boolean;
}

/**
 * A ready-made {@link HibernatableSnapshotSecurity} backed by WebCrypto: AES-GCM
 * for confidentiality+integrity and a keyed HMAC fingerprint for write-elision.
 * This is the recommended way to protect hibernation snapshots — pass the result
 * as `snapshotSecurity` when creating a hibernatable session.
 *
 * Why this exists, and the one rule that makes it secure: a hibernation snapshot
 * (which carries `importReplays` that are re-executed on wake) is persisted in
 * Durable Object storage / the WebSocket attachment. If an attacker can WRITE
 * that storage, the only thing that stops a forged snapshot from being restored
 * and replayed is a verification key the attacker cannot reach — and the
 * library's own storage IS the thing under attack. So the key MUST come from
 * outside that store. Pass a `secret` sourced from a Worker secret binding
 * (`wrangler secret put …`) or a KMS — never from DO storage or client input.
 *
 * Both subkeys are derived from `secret` via SHA-256 with distinct domain-
 * separation labels, so a single high-entropy secret is sufficient. The wire
 * format (key derivation, `AES-GCM` algorithm tag, base64url envelope fields)
 * is fixed, so snapshots sealed by one build remain openable by another with the
 * same secret.
 *
 * Bind extra context (e.g. `{ userId }`) via `snapshotSecurityAssociatedData` on
 * the session options; the library already folds in `sessionId` and the storage
 * mode, and this implementation binds the whole thing as AES-GCM additional data,
 * so a snapshot sealed for one session/user cannot be opened in another.
 *
 * @param secret  High-entropy secret, sourced from outside the snapshot store.
 * @throws if `secret` is empty.
 */
export function __experimental_newWebCryptoSnapshotSecurity(
    secret: string,
    options: WebCryptoSnapshotSecurityOptions = {}): HibernatableSnapshotSecurity {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error("A non-empty secret is required for WebCrypto snapshot security.");
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let aesKeyPromise: Promise<CryptoKey> | undefined;
  let fingerprintKeyPromise: Promise<CryptoKey> | undefined;

  const getAesKey = () => aesKeyPromise ??= deriveRawKey(secret, "capnweb snapshot aes-gcm")
      .then(keyBytes => crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]));
  const getFingerprintKey = () => fingerprintKeyPromise ??= deriveRawKey(secret, "capnweb snapshot fingerprint")
      .then(keyBytes => crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));

  const fingerprint: HibernatableSnapshotSecurity["fingerprint"] = async ({ plaintext, associatedData }) => {
    const key = await getFingerprintKey();
    const bytes = await crypto.subtle.sign("HMAC", key, encoder.encode(`${associatedData}\n${plaintext}`));
    return base64UrlEncode(new Uint8Array(bytes));
  };

  return {
    required: options.required ?? true,
    fingerprint,

    async seal({ plaintext, associatedData }) {
      const key = await getAesKey();
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(associatedData) },
          key,
          encoder.encode(plaintext));
      return {
        kind: "encrypted" as const,
        alg: "AES-GCM",
        nonce: base64UrlEncode(nonce),
        ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
        fingerprint: await fingerprint({ plaintext, associatedData }),
      };
    },

    async open({ envelope, associatedData }): Promise<string> {
      if (envelope.alg !== "AES-GCM") {
        throw new Error(`Unsupported capnweb snapshot encryption algorithm: ${envelope.alg}`);
      }
      const key = await getAesKey();
      // Throws on any tamper or associated-data mismatch; the caller treats that
      // as an invalid snapshot and refuses the restore.
      const plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: base64UrlDecode(envelope.nonce), additionalData: encoder.encode(associatedData) },
          key,
          base64UrlDecode(envelope.ciphertext));
      return decoder.decode(plaintext);
    },
  };
}

async function deriveRawKey(secret: string, label: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest("SHA-256", encoder.encode(`${label}\n${secret}`));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
