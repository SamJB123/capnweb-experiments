// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import type { PropertyPath } from "./core.js";

export type RpcSessionExportProvenance = {
  expr: unknown;
  captures?: ["import", number][];
  instructions?: unknown[];
  path?: PropertyPath;
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

export type RpcSessionSnapshot = {
  version: 1 | 2;
  nextExportId: number;
  exports: RpcSessionSnapshotExport[];
  /** Peer-imported capabilities (stubs pointing back to the peer's exports).
   *  Only unresolved imports are snapshotted — resolved imports have already
   *  sent a release to the peer and are handled locally. */
  imports?: RpcSessionSnapshotImport[];
  /** Replayable inbound calls that introduced imported capabilities into local
   *  application state. Replaying these after restore rebuilds app-held
   *  references without requiring application-layer persistence. */
  importReplays?: RpcSessionExportProvenance[];
};

/**
 * Everything needed to resume an RPC session after hibernation, stored in the
 * WebSocket attachment via workerd's serializeAttachment API.
 */
export type HibernatableWebSocketAttachment = {
  sessionId: string;
  version: 1;
  /** Full RPC session snapshot, persisted per-connection. */
  snapshot?: RpcSessionSnapshot;
};

export interface HibernatableSessionStore {
  load(sessionId: string): Promise<RpcSessionSnapshot | undefined>;
  save(sessionId: string, snapshot: RpcSessionSnapshot): Promise<void>;
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
      return value as RpcSessionSnapshot | undefined;
    },

    async save(sessionId: string, snapshot: RpcSessionSnapshot) {
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
