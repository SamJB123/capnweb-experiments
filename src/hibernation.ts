// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import type { PropertyPath } from "./core.js";

export type RpcSessionExportProvenance = {
  expr: unknown;
  /** Existing positive export id of the particular call result that produced
   *  this export. Lazy restoration uses it to bind all still-live siblings
   *  from one evaluation, just as importReplay does for eager restoration. */
  producerExportId?: number;
  captures?: ["import", number][];
  instructions?: unknown[];
  path?: PropertyPath;
};

/**
 * A replayable inbound call that introduced an imported capability into local
 * application state (e.g. `subscribe(callback)` capturing the callback). On
 * restore, re-evaluating `expr` re-runs the call so its server-side side effects
 * (subscriptions, registrations) are re-established.
 *
 * If the call ALSO returned one or more capabilities the peer still holds,
 * `producesExportIds` lists the export ids of EVERY such capability — captured at
 * resolve time, wherever they sit in the returned value (bare, or nested in an
 * object/array). On restore the call is re-evaluated ONCE and each of those
 * exports is bound to its capability from that single result (navigating the
 * export's own provenance path), instead of the result being disposed. Disposing
 * it would run the returned capabilities' disposers, which may tear down the very
 * side effect the replay just re-established. When empty/absent (e.g. a
 * void-returning call), the result is discarded as before.
 */
export type RpcSessionImportReplay = {
  expr: unknown;
  producesExportIds?: number[];
};

export type RpcSessionSnapshotExport = {
  id: number;
  refcount: number;
  provenance?: RpcSessionExportProvenance;
  /** If true, this export had an in-flight pull at snapshot time.
   *  On restore the pull will be re-triggered automatically so the
   *  client receives the resolve/reject it is still waiting for. */
  pulling?: boolean;
};

/**
 * Snapshot of a peer-imported capability (i.e. the peer exported an RpcTarget to us).
 *
 * Unlike exports, imports don't need provenance — the real object lives on the peer.
 * We just need to remember the import ID and refcount so we can continue sending
 * RPC messages referencing the correct ID after hibernation. The peer's export table
 * still maps this ID to the real object because the WebSocket was never disconnected.
 */
export type RpcSessionSnapshotImport = {
  id: number;
  remoteRefcount: number;
};

/**
 * Wire-codec state carried inside the session snapshot so a stateful codec (e.g.
 * a CBOR codec sharing structure definitions across messages) can survive
 * hibernation in sync with the peer. `state` is whatever the transport's
 * `snapshotState()` returns and must be JSON-serializable. `id` guards against
 * restoring codec state into a session configured with a different codec.
 */
export type RpcSessionCodecState = {
  id: string;
  state: unknown;
};

/**
 * A positive (call-result) export that an importReplay's expression references as a pipeline
 * base. Positive exports are normally transient and dropped from snapshots, but a replay such as
 * `["pipeline", <positive id>, ["avatar"], [writer]]` cannot be re-evaluated on restore unless
 * its base exists on the exports table. `expr` is the original push expression that created the
 * call result; restore re-evaluates it (in ascending id order, so chained bases work) to
 * re-establish the entry before replays run.
 */
export type RpcSessionSnapshotPositiveBase = {
  id: number;
  /** Peer-held refcount at snapshot time. 0 means the peer had already released the export;
   *  restore then re-creates it only for the duration of replay evaluation. */
  refcount: number;
  expr: unknown;
  /** If true, the peer was still awaiting this call's resolution at snapshot time; restore
   *  re-triggers the pull so the peer receives its resolve/reject. */
  pulling?: boolean;
};

export type RpcSessionSnapshot = {
  version: 1 | 2 | 3;
  nextExportId: number;
  exports: RpcSessionSnapshotExport[];
  /** Peer-imported capabilities (stubs pointing back to the peer's exports).
   *  Only unresolved imports are snapshotted — resolved imports have already
   *  sent a release to the peer and are handled locally. */
  imports?: RpcSessionSnapshotImport[];
  /** Replayable inbound calls that introduced imported capabilities into local
   *  application state. Replaying these after restore rebuilds app-held
   *  references without requiring application-layer persistence. */
  importReplays?: RpcSessionImportReplay[];
  /** Stateful wire-codec state (version 3+). Present only when the session's
   *  transport implements `snapshotState()` (e.g. a codec transport wrapping a
   *  stateful CBOR codec). The default JSON wire format omits this. */
  codec?: RpcSessionCodecState;
  /** Positive call-result exports referenced (transitively) as pipeline bases by
   *  `importReplays` expressions. Restored before the replays are evaluated. */
  positiveBases?: RpcSessionSnapshotPositiveBase[];
};

export type HibernatableSnapshotStorageMode = "inline" | "sessionStore";

export type HibernatableEncryptedSnapshotEnvelope = {
  kind: "encrypted";
  alg: string;
  nonce: string;
  ciphertext: string;
  /** Deterministic, keyed marker for write elision. Not used for decryption. */
  fingerprint?: string;
};

export type HibernatableStoredSnapshot =
  | RpcSessionSnapshot
  | HibernatableEncryptedSnapshotEnvelope;

export type HibernatableSnapshotSecurityInput = {
  plaintext: string;
  associatedData: string;
};

export type HibernatableSnapshotSecurityOpenInput = {
  envelope: HibernatableEncryptedSnapshotEnvelope;
  associatedData: string;
};

export interface HibernatableSnapshotSecurity {
  /** Refuse to restore snapshots that are not encrypted envelopes. */
  required?: boolean;
  fingerprint(input: HibernatableSnapshotSecurityInput): string | Promise<string>;
  seal(input: HibernatableSnapshotSecurityInput):
      HibernatableEncryptedSnapshotEnvelope | Promise<HibernatableEncryptedSnapshotEnvelope>;
  open(input: HibernatableSnapshotSecurityOpenInput): string | Promise<string>;
}

/**
 * Everything needed to resume an RPC session after hibernation, stored in the
 * WebSocket attachment via workerd's serializeAttachment API.
 */
export type HibernatableWebSocketAttachment = {
  sessionId: string;
  version: 1 | 2 | 3;
  /** Legacy/plaintext full RPC session snapshot, persisted per-connection. */
  snapshot?: RpcSessionSnapshot;
  /** Encrypted full RPC session snapshot, persisted per-connection. */
  snapshotEnvelope?: HibernatableEncryptedSnapshotEnvelope;
  /** Legacy authentication marker used by version 2 attachments. */
  snapshotMac?: string;
  /** Deterministic keyed marker for the currently persisted snapshot. */
  snapshotFingerprint?: string;
};

export interface HibernatableSessionStore {
  load(sessionId: string): Promise<HibernatableStoredSnapshot | undefined>;
  save(sessionId: string, snapshot: HibernatableStoredSnapshot): Promise<void>;
  delete(sessionId: string): Promise<void>;

  /**
   * Delete stored sessions whose IDs are NOT in the provided set.
   * Call on Durable Object wake-up to clean up sessions for clients that
   * disconnected during hibernation (whose `handleClose` never fired).
   *
   * @param liveSessionIds - Session IDs that still have connected WebSockets
   * @returns Number of orphaned sessions deleted
   */
  deleteOrphans?(liveSessionIds: Set<string>): Promise<number>;
}

export interface DurableObjectStorageLike {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<unknown>;
  delete(keys: string[]): Promise<number>;
  list?(options: { prefix: string }): Promise<Map<string, unknown>>;
}

export function __experimental_newDurableObjectSessionStore(
    storage: DurableObjectStorageLike,
    prefix: string = "capnweb:session:"): HibernatableSessionStore {
  return {
    async load(sessionId: string) {
      const value = await storage.get(`${prefix}${sessionId}`);
      return value as HibernatableStoredSnapshot | undefined;
    },

    async save(sessionId: string, snapshot: HibernatableStoredSnapshot) {
      await storage.put(`${prefix}${sessionId}`, snapshot);
    },

    async delete(sessionId: string) {
      await storage.delete(`${prefix}${sessionId}`);
    },

    async deleteOrphans(liveSessionIds: Set<string>): Promise<number> {
      if (!storage.list) return 0;

      const stored = await storage.list({ prefix });
      const orphanKeys: string[] = [];
      for (const key of stored.keys()) {
        const sessionId = key.slice(prefix.length);
        if (!liveSessionIds.has(sessionId)) {
          orphanKeys.push(key);
        }
      }

      if (orphanKeys.length > 0) {
        await storage.delete(orphanKeys);
      }

      return orphanKeys.length;
    },
  };
}
