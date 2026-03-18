// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import {
  StubHook,
  RpcPayload,
  RpcStub,
  RpcPromise,
  PropertyPath,
  PayloadStubHook,
  ErrorStubHook,
  RpcTarget,
  unwrapStubAndPath,
  streamImpl,
  mapImpl,
  __experimental_debugStubHookIdentity,
} from "./core.js";
import { Devaluator, Evaluator, ExportId, ImportId, Exporter, Importer, serialize } from "./serialize.js";
import { __experimental_recordInputPath } from "./map.js";
import type {
  RpcSessionExportProvenance,
  RpcSessionSnapshot,
} from "./hibernation.js";

/**
 * Interface for an RPC transport, which is a simple bidirectional message stream. Implement this
 * interface if the built-in transports (e.g. for HTTP batch and WebSocket) don't meet your needs.
 */
export interface RpcTransport {
  /**
   * Sends a message to the other end.
   */
  send(message: string): Promise<void>;

  /**
   * Receives a message sent by the other end.
   *
   * If and when the transport becomes disconnected, this will reject. The thrown error will be
   * propagated to all outstanding calls and future calls on any stubs associated with the session.
   * If there are no outstanding calls (and none are made in the future), then the error does not
   * propagate anywhere -- this is considered a "clean" shutdown.
   */
  receive(): Promise<string>;

  /**
   * Indicates that the RPC system has suffered an error that prevents the session from continuing.
   * The transport should ideally try to send any queued messages if it can, and then close the
   * connection. (It's not strictly necessary to deliver queued messages, but the last message sent
   * before abort() is called is often an "abort" message, which communicates the error to the
   * peer, so if that is dropped, the peer may have less information about what happened.)
   */
  abort?(reason: any): void;
}

// Entry on the exports table.
type ExportTableEntry = {
  hook?: StubHook,
  refcount: number,
  provenance?: RpcSessionExportProvenance,
  // Transient origin expression for positive exports. This is not snapshotted, but it is used
  // while resolving a positive export so any negative exports found in its result can inherit
  // provenance from the originating call.
  sourceExpr?: unknown,
  pull?: Promise<void>,

  // If true, the export should be automatically released (with refcount 1) after its "resolve"
  // or "reject" message is sent. This is set for exports created by ["stream"] messages.
  autoRelease?: boolean,

  // If this export was created by a ["pipe"] message, this holds the ReadableStream end of the
  // pipe. It is consumed (and set to undefined) when a ["readable", importId] expression
  // references this export.
  pipeReadable?: ReadableStream
};

// Entry on the imports table.
class ImportTableEntry {
  constructor(public session: RpcSessionImpl, public importId: number, pulling: boolean) {
    if (pulling) {
      this.activePull = Promise.withResolvers<void>();
    }
  }

  public localRefcount: number = 0;
  public remoteRefcount: number = 1;

  private activePull?: PromiseWithResolvers<void>;
  public resolution?: StubHook;

  // List of integer indexes into session.onBrokenCallbacks which are callbacks registered on
  // this import. Initialized on first use (so `undefined` is the same as an empty list).
  private onBrokenRegistrations?: number[];

  resolve(resolution: StubHook) {
    // TODO: Need embargo handling here? PayloadStubHook needs to be wrapped in a
    // PromiseStubHook awaiting the embargo I suppose. Previous notes on embargoes:
    // - Resolve message specifies last call that was received before the resolve. The introducer is
    //   responsible for any embargoes up to that point.
    // - Any further calls forwarded by the introducer after that point MUST immediately resolve to
    //   a forwarded call. The caller is responsible for ensuring the last of these is handed off
    //   before direct calls can be delivered.

    if (this.localRefcount == 0) {
      // Already disposed (canceled), so ignore the resolution and don't send a redundant release.
      resolution.dispose();
      return;
    }

    this.resolution = resolution;
    this.sendRelease();

    if (this.onBrokenRegistrations) {
      // Delete all our callback registrations from this session and re-register them on the
      // target stub.
      for (let i of this.onBrokenRegistrations) {
        let callback = this.session.onBrokenCallbacks[i];
        let endIndex = this.session.onBrokenCallbacks.length;
        resolution.onBroken(callback);
        if (this.session.onBrokenCallbacks[endIndex] === callback) {
          // Oh, calling onBroken() just registered the callback back on this connection again.
          // But when the connection dies, we want all the callbacks to be called in the order in
          // which they were registered. So we don't want this one pushed to the back of the line
          // here. So, let's remove the newly-added registration and keep the original.
          // TODO: This is quite hacky, think about whether this is really the right answer.
          delete this.session.onBrokenCallbacks[endIndex];
        } else {
          // The callback is now registered elsewhere, so delete it from our session.
          delete this.session.onBrokenCallbacks[i];
        }
      }
      this.onBrokenRegistrations = undefined;
    }

    if (this.activePull) {
      this.activePull.resolve();
      this.activePull = undefined;
    }
  }

  async awaitResolution(): Promise<RpcPayload> {
    if (!this.activePull) {
      this.session.sendPull(this.importId);
      this.activePull = Promise.withResolvers<void>();
    }
    await this.activePull.promise;
    return this.resolution!.pull();
  }

  dispose() {
    if (this.resolution) {
      this.resolution.dispose();
    } else {
      this.abort(new Error("RPC was canceled because the RpcPromise was disposed."));
      this.sendRelease();
    }
  }

  abort(error: any) {
    if (!this.resolution) {
      this.resolution = new ErrorStubHook(error);

      if (this.activePull) {
        this.activePull.reject(error);
        this.activePull = undefined;
      }

      // The RpcSession itself will have called all our callbacks so we don't need to track the
      // registrations anymore.
      this.onBrokenRegistrations = undefined;
    }
  }

  onBroken(callback: (error: any) => void): void {
    if (this.resolution) {
      this.resolution.onBroken(callback);
    } else {
      let index = this.session.onBrokenCallbacks.length;
      this.session.onBrokenCallbacks.push(callback);

      if (!this.onBrokenRegistrations) this.onBrokenRegistrations = [];
      this.onBrokenRegistrations.push(index);
    }
  }

  private sendRelease() {
    if (this.remoteRefcount > 0) {
      this.session.sendRelease(this.importId, this.remoteRefcount);
      this.remoteRefcount = 0;
    }
  }

  __experimental_debugState() {
    return {
      id: this.importId,
      localRefcount: this.localRefcount,
      remoteRefcount: this.remoteRefcount,
      hasResolution: !!this.resolution,
      resolutionType: this.resolution?.constructor?.name ?? null,
      hasActivePull: !!this.activePull,
    };
  }
};

class RpcImportHook extends StubHook {
  public entry?: ImportTableEntry;  // undefined when we're disposed

  // `pulling` is true if we already expect that this import is going to be resolved later, and
  // null if this import is not allowed to be pulled (i.e. it's a stub not a promise).
  constructor(public isPromise: boolean, entry: ImportTableEntry) {
    super();
    ++entry.localRefcount;
    this.entry = entry;
  }

  collectPath(path: PropertyPath): RpcImportHook {
    return this;
  }

  getEntry(): ImportTableEntry {
    if (this.entry) {
      return this.entry;
    } else {
      // Shouldn't get here in practice since the holding stub should have replaced the hook when
      // disposed.
      throw new Error("This RpcImportHook was already disposed.");
    }
  }

  // -------------------------------------------------------------------------------------
  // implements StubHook

  call(path: PropertyPath, args: RpcPayload): StubHook {
    let entry = this.getEntry();
    if (entry.resolution) {
      return entry.resolution.call(path, args);
    } else {
      return entry.session.sendCall(entry.importId, path, args);
    }
  }

  stream(path: PropertyPath, args: RpcPayload): {promise: Promise<void>, size?: number} {
    let entry = this.getEntry();
    if (entry.resolution) {
      return entry.resolution.stream(path, args);
    } else {
      return entry.session.sendStream(entry.importId, path, args);
    }
  }

  map(path: PropertyPath, captures: StubHook[], instructions: unknown[]): StubHook {
    let entry: ImportTableEntry;
    try {
      entry = this.getEntry();
    } catch (err) {
      for (let cap of captures) {
        cap.dispose();
      }
      throw err;
    }

    if (entry.resolution) {
      return entry.resolution.map(path, captures, instructions);
    } else {
      return entry.session.sendMap(entry.importId, path, captures, instructions);
    }
  }

  get(path: PropertyPath): StubHook {
    let entry = this.getEntry();
    if (entry.resolution) {
      return entry.resolution.get(path);
    } else {
      return entry.session.sendCall(entry.importId, path);
    }
  }

  dup(): RpcImportHook {
    return new RpcImportHook(false, this.getEntry());
  }

  pull(): RpcPayload | Promise<RpcPayload> {
    let entry = this.getEntry();

    if (!this.isPromise) {
      throw new Error("Can't pull this hook because it's not a promise hook.");
    }

    if (entry.resolution) {
      return entry.resolution.pull();
    }

    return entry.awaitResolution();
  }

  ignoreUnhandledRejections(): void {
    // We don't actually have to do anything here because this method only has to ignore rejections
    // if pull() is *not* called, and if pull() is not called then we won't generate any rejections
    // anyway.
  }

  dispose(): void {
    let entry = this.entry;
    this.entry = undefined;
    if (entry) {
      if (--entry.localRefcount === 0) {
        entry.dispose();
      }
    }
  }

  onBroken(callback: (error: any) => void): void {
    if (this.entry) {
      this.entry.onBroken(callback);
    }
  }

  __experimental_debugIdentity() {
    return {
      hookType: this.constructor?.name ?? null,
      isPromise: this.isPromise,
      entry: this.entry?.__experimental_debugState() ?? null,
    };
  }
}

export function __experimental_getImportIdForRpcValue(value: unknown): number | undefined {
  if (!(value instanceof RpcStub) && !(value instanceof RpcPromise)) {
    return undefined;
  }

  const { hook, pathIfPromise } = unwrapStubAndPath(value);
  if (pathIfPromise && pathIfPromise.length > 0) {
    return undefined;
  }
  if (!(hook instanceof RpcImportHook)) {
    return undefined;
  }

  return hook.getEntry().importId;
}

class RpcMainHook extends RpcImportHook {
  private session?: RpcSessionImpl;

  constructor(entry: ImportTableEntry) {
    super(false, entry);
    this.session = entry.session;
  }

  dispose(): void {
    if (this.session) {
      let session = this.session;
      this.session = undefined;
      session.shutdown();
    }
  }
}

/**
 * Options to customize behavior of an RPC session. All functions which start a session should
 * optionally accept this.
 */
export type RpcSessionOptions = {
  /**
   * If provided, this function will be called whenever an `Error` object is serialized (for any
   * reason, not just because it was thrown). This can be used to log errors, and also to redact
   * them.
   *
   * If `onSendError` returns an Error object, than object will be substituted in place of the
   * original. If it has a stack property, the stack will be sent to the client.
   *
   * If `onSendError` doesn't return anything (or is not provided at all), the default behavior is
   * to serialize the error with the stack omitted.
   */
  onSendError?: (error: Error) => Error | void;

  /**
   * EXPERIMENTAL: Restore a session from a previously-captured snapshot.
   */
  __experimental_restoreSnapshot?: RpcSessionSnapshot;

  /**
   * EXPERIMENTAL: Low-level trace hook for observing session message flow.
   */
  __experimental_trace?: (event: RpcTraceEvent) => void;
};

export type RpcTraceEvent = {
  source: "rpc";
  phase: string;
  detail?: Record<string, unknown>;
};

export type RpcSessionDebugState = {
  nextExportId: number;
  abortReason: string | null;
  pullCount: number;
  exports: Array<{
    id: number;
    refcount: number;
    hasHook: boolean;
    hookType: string | null;
    hookIdentity: Record<string, unknown> | null;
    provenance: RpcSessionExportProvenance | null;
    hasPull: boolean;
    autoRelease: boolean;
    hasPipeReadable: boolean;
  }>;
  imports: Array<{
    id: number;
    localRefcount: number;
    remoteRefcount: number;
    hasResolution: boolean;
    resolutionType: string | null;
    hasActivePull: boolean;
  }>;
};

function cloneRpcExpr<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function cloneRpcProvenance(provenance: RpcSessionExportProvenance): RpcSessionExportProvenance {
  return {
    expr: cloneRpcExpr(provenance.expr),
    ...(provenance.captures ? { captures: cloneRpcExpr(provenance.captures) } : {}),
    ...(provenance.instructions ? { instructions: cloneRpcExpr(provenance.instructions) } : {}),
    ...(provenance.path ? { path: cloneRpcExpr(provenance.path) } : {}),
  };
}

class RpcSessionImpl implements Importer, Exporter {
  private exports: Array<ExportTableEntry> = [];
  private reverseExports: Map<StubHook, ExportId> = new Map();
  private imports: Array<ImportTableEntry> = [];
  private importReplays: RpcSessionExportProvenance[] = [];
  private abortReason?: any;
  private cancelReadLoop: (error: any) => void;

  // We assign positive numbers to imports we initiate, and negative numbers to exports we
  // initiate. So the next import ID is just `imports.length`, but the next export ID needs
  // to be tracked explicitly.
  private nextExportId = -1;

  // If set, call this when all incoming calls are complete.
  private onBatchDone?: Omit<PromiseWithResolvers<void>, "promise">;

  // How many promises is our peer expecting us to resolve?
  private pullCount = 0;
  private currentNegativeExportProvenanceExpr?: unknown;

  // Sparse array of onBrokenCallback registrations. Items are strictly appended to the end but
  // may be deleted from the middle (hence leaving the array sparse).
  onBrokenCallbacks: ((error: any) => void)[] = [];
  constructor(private transport: RpcTransport, mainHook: StubHook,
      private options: RpcSessionOptions) {
    // Export zero is automatically the bootstrap object.
    this.exports.push({hook: mainHook, refcount: 1});

    // Import zero is the other side's bootstrap object.
    this.imports.push(new ImportTableEntry(this, 0, false));

    const snapshot = options.__experimental_restoreSnapshot;
    if (snapshot) {
      this.restoreFromSnapshot(snapshot);
    }

    let rejectFunc: (error: any) => void;;
    let abortPromise = new Promise<never>((resolve, reject) => { rejectFunc = reject; });
    this.cancelReadLoop = rejectFunc!;

    this.readLoop(abortPromise).catch(err => this.abort(err));
  }

  private trace(phase: string, detail?: Record<string, unknown>) {
    try {
      this.options.__experimental_trace?.({
        source: "rpc",
        phase,
        ...(detail ? { detail } : {}),
      });
    } catch (_err) {
      // Ignore trace hook failures.
    }
  }

  private evaluateWithCurrentProvenance(expr: unknown): RpcPayload {
    const previousExpr = this.currentNegativeExportProvenanceExpr;
    this.currentNegativeExportProvenanceExpr = expr;
    try {
      return new Evaluator(this).evaluate(expr);
    } finally {
      this.currentNegativeExportProvenanceExpr = previousExpr;
    }
  }

  // Should only be called once immediately after construction.
  getMainImport(): RpcImportHook {
    return new RpcMainHook(this.imports[0]);
  }

  shutdown(): void {
    // TODO(someday): Should we add some sort of "clean shutdown" mechanism? This gets the job
    //   done just fine for the moment.
    this.abort(new Error("RPC session was shut down by disposing the main stub"), false);
  }

  exportStub(hook: StubHook, path?: PropertyPath): ExportId {
    if (this.abortReason) throw this.abortReason;

    let existingExportId = this.reverseExports.get(hook);
    if (existingExportId !== undefined) {
      ++this.exports[existingExportId].refcount;
      this.trace("exportStub.reuse", { exportId: existingExportId, refcount: this.exports[existingExportId].refcount });
      return existingExportId;
    } else {
      let exportId = this.nextExportId--;
      this.exports[exportId] = {
        hook,
        refcount: 1,
        ...(this.currentNegativeExportProvenanceExpr !== undefined ? {
          provenance: (() => {
            let mapProgram = __experimental_recordInputPath(path ?? []);
            return {
              expr: cloneRpcExpr(this.currentNegativeExportProvenanceExpr),
              captures: mapProgram.captures,
              instructions: mapProgram.instructions,
            };
          })(),
        } : {}),
      };
      this.reverseExports.set(hook, exportId);
      this.trace("exportStub.new", { exportId, hookType: hook.constructor?.name ?? null });
      // TODO: Use onBroken().
      return exportId;
    }
  }

  exportPromise(hook: StubHook, path?: PropertyPath): ExportId {
    if (this.abortReason) throw this.abortReason;

    // Promises always use a new ID because otherwise the recipient could miss the resolution.
    let exportId = this.nextExportId--;
    this.exports[exportId] = {
      hook,
      refcount: 1,
      ...(this.currentNegativeExportProvenanceExpr !== undefined ? {
        provenance: (() => {
          let mapProgram = __experimental_recordInputPath(path ?? []);
          return {
            expr: cloneRpcExpr(this.currentNegativeExportProvenanceExpr),
            captures: mapProgram.captures,
            instructions: mapProgram.instructions,
          };
        })(),
      } : {}),
    };
    this.reverseExports.set(hook, exportId);
    this.trace("exportPromise.new", { exportId, hookType: hook.constructor?.name ?? null });

    // Automatically start resolving any promises we send.
    this.ensureResolvingExport(exportId);
    return exportId;
  }

  unexport(ids: Array<ExportId>): void {
    for (let id of ids) {
      this.releaseExport(id, 1);
    }
  }

  private releaseExport(exportId: ExportId, refcount: number) {
    let entry = this.exports[exportId];
    if (!entry) {
      this.trace("releaseExport.missing", { exportId, refcount });
      return;
    }
    if (entry.refcount < refcount) {
      throw new Error(`refcount would go negative: ${entry.refcount} < ${refcount}`);
    }
    entry.refcount -= refcount;
    this.trace("releaseExport", { exportId, refcount, remainingRefcount: entry.refcount });
    if (entry.refcount === 0) {
      delete this.exports[exportId];
      if (entry.hook) {
        this.reverseExports.delete(entry.hook);
        entry.hook.dispose();
      }
    }
  }

  private replacePositiveExport(exportId: ExportId, entry: ExportTableEntry) {
    if (exportId < 0) {
      throw new Error(`Positive export slot expected, got ${exportId}`);
    }

    let previous = this.exports[exportId];
    if (previous?.hook) {
      this.reverseExports.delete(previous.hook);
      previous.hook.dispose();
    }

    this.exports[exportId] = entry;
  }

  onSendError(error: Error): Error | void {
    if (this.options.onSendError) {
      return this.options.onSendError(error);
    }
  }

  private ensureResolvingExport(exportId: ExportId) {
    let exp = this.exports[exportId];
    if (!exp) {
      this.trace("ensureResolvingExport.missing", { exportId });
      return;
    }
    if (!exp.pull) {
      this.trace("ensureResolvingExport.start", {
        exportId,
        hasHook: !!exp.hook,
        hasProvenance: !!exp.provenance,
      });
      let resolve = async () => {
        let hook = this.getOrRestoreExportHook(exportId);
        this.trace("ensureResolvingExport.hookReady", {
          exportId,
          hookType: hook.constructor?.name ?? null,
        });
        for (;;) {
          let payload = await hook.pull();
          if (payload.value instanceof RpcStub) {
            let {hook: inner, pathIfPromise} = unwrapStubAndPath(payload.value);
            if (pathIfPromise && pathIfPromise.length == 0) {
              if (this.getImport(hook) === undefined) {
                // Optimization: The resolution is just another promise, and it is not a promise
                // pointing back to the peer. So if we send a resolve message, it's just going to
                // resolve to another new promise export, which is just going to have to wait for
                // another resolve message later. This intermediate resolve message gives the peer
                // no useful information, so let's skip it and just wait for the chained
                // resolution.
                hook = inner;
                continue;
              }
            }
          }

          return payload;
        }
      };

      let autoRelease = exp.autoRelease;

      ++this.pullCount;
      exp.pull = resolve().then(
        payload => {
          const previousExpr = this.currentNegativeExportProvenanceExpr;
          this.currentNegativeExportProvenanceExpr = exp.provenance?.expr ?? exp.sourceExpr;
          // We don't transfer ownership of stubs in the payload since the payload
          // belongs to the hook which sticks around to handle pipelined requests.
          let value: unknown;
          try {
            value = Devaluator.devaluate(payload.value, undefined, this, payload);
          } finally {
            this.currentNegativeExportProvenanceExpr = previousExpr;
          }
          this.trace("ensureResolvingExport.resolve", { exportId, valueType: typeof payload.value });
          this.send(["resolve", exportId, value]);
          if (autoRelease) this.releaseExport(exportId, 1);
        },
        error => {
          this.trace("ensureResolvingExport.reject", {
            exportId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.send(["reject", exportId, Devaluator.devaluate(error, undefined, this)]);
          if (autoRelease) this.releaseExport(exportId, 1);
        }
      ).catch(
        error => {
          // If serialization failed, report the serialization error, which should
          // itself always be serializable.
          try {
            this.trace("ensureResolvingExport.rejectSerialization", {
              exportId,
              error: error instanceof Error ? error.message : String(error),
            });
            this.send(["reject", exportId, Devaluator.devaluate(error, undefined, this)]);
            if (autoRelease) this.releaseExport(exportId, 1);
          } catch (error2) {
            // TODO: Shouldn't happen, now what?
            this.abort(error2);
          }
        }
      ).finally(() => {
        if (--this.pullCount === 0) {
          if (this.onBatchDone) {
            this.onBatchDone.resolve();
          }
        }
      });
    }
  }

  getImport(hook: StubHook): ImportId | undefined {
    if (hook instanceof RpcImportHook && hook.entry && hook.entry.session === this) {
      return hook.entry.importId;
    } else {
      return undefined;
    }
  }

  importStub(idx: ImportId): RpcImportHook {
    if (this.abortReason) throw this.abortReason;

    let entry = this.imports[idx];
    if (!entry) {
      entry = new ImportTableEntry(this, idx, false);
      this.imports[idx] = entry;
    }
    return new RpcImportHook(/*isPromise=*/false, entry);
  }

  importPromise(idx: ImportId): StubHook {
    if (this.abortReason) throw this.abortReason;

    if (this.imports[idx]) {
      // Can't reuse an existing ID for a promise!
      return new ErrorStubHook(new Error(
          "Bug in RPC system: The peer sent a promise reusing an existing export ID."));
    }

    // Create an already-pulling hook.
    let entry = new ImportTableEntry(this, idx, true);
    this.imports[idx] = entry;
    return new RpcImportHook(/*isPromise=*/true, entry);
  }

  getExport(idx: ExportId): StubHook | undefined {
    let entry = this.exports[idx];
    if (!entry) return undefined;
    return this.getOrRestoreExportHook(idx);
  }

  __experimental_snapshot(): RpcSessionSnapshot {
    const imports = [] as NonNullable<RpcSessionSnapshot["imports"]>;
    for (let i in this.imports) {
      let id = Number(i);
      if (id === 0) continue;
      if (id > 0) continue;  // Positive imports are transient call results — not needed after hibernation.

      let entry = this.imports[i];
      if (!entry) continue;
      if (entry.resolution) continue;

      imports.push({
        id,
        remoteRefcount: entry.remoteRefcount,
      });
    }

    const exports = [] as RpcSessionSnapshot["exports"];
    for (let i in this.exports) {
      let id = Number(i);
      if (id >= 0) continue;

      let entry = this.exports[i];
      if (!entry) continue;

      if (!entry.provenance) {
        console.error(
            `[capnweb] Export ${id} is not hibernatable (hook type: ${entry.hook?.constructor?.name ?? "none"}). ` +
            `It will be lost on hibernation. It needs intrinsic provenance.`);
        continue;
      }

      exports.push({
        id,
        refcount: entry.refcount,
        provenance: entry.provenance,
        ...(entry.pull ? {pulling: true} : {}),
      });
    }

    return {
      version: 2,
      nextExportId: this.nextExportId,
      exports,
      ...(imports.length > 0 ? {imports} : {}),
      ...(this.importReplays.length > 0 ? { importReplays: this.importReplays } : {}),
    };
  }

  getPipeReadable(exportId: ExportId): ReadableStream {
    let entry = this.exports[exportId];
    if (!entry || !entry.pipeReadable) {
      throw new Error(`Export ${exportId} is not a pipe or its readable end was already consumed.`);
    }
    let readable = entry.pipeReadable;
    entry.pipeReadable = undefined;
    return readable;
  }

  createPipe(readable: ReadableStream, readableHook: StubHook): ImportId {
    if (this.abortReason) throw this.abortReason;

    let importId = this.imports.length;
    // The pipe import is not a promise -- it's immediately usable as a writable stream.
    let entry = new ImportTableEntry(this, importId, false);
    this.imports.push(entry);
    this.send(["pipe", importId]);

    // Create a proxy WritableStream from the import hook and pump the ReadableStream into it.
    let hook = new RpcImportHook(/*isPromise=*/false, entry);
    let writable = streamImpl.createWritableStreamFromHook(hook);
    readable.pipeTo(writable).catch(() => {
      // Errors are handled by the writable stream's error handling -- either the write fails
      // and the writable side reports it, or the readable side errors and pipeTo aborts the
      // writable side. Either way, the hook's disposal will handle cleanup.
    }).finally(() => readableHook.dispose());

    return importId;
  }

  // Serializes and sends a message. Returns the byte length of the serialized message.
  private send(msg: any): number {
    if (this.abortReason !== undefined) {
      // Ignore sends after we've aborted.
      return 0;
    }

    let msgText: string;
    try {
      msgText = JSON.stringify(msg);
    } catch (err) {
      // If JSON stringification failed, there's something wrong with the devaluator, as it should
      // not allow non-JSONable values to be injected in the first place.
      try { this.abort(err); } catch (err2) {}
      throw err;
    }

    this.trace("send", {
      kind: msg instanceof Array ? msg[0] : typeof msg,
      byteLength: msgText.length,
    });

    this.transport.send(msgText)
        // If send fails, abort the connection, but don't try to send an abort message since
        // that'll probably also fail.
        .catch(err => this.abort(err, false));

    return msgText.length;
  }

  sendCall(id: ImportId, path: PropertyPath, args?: RpcPayload): RpcImportHook {
    if (this.abortReason) throw this.abortReason;

    let entry = new ImportTableEntry(this, this.imports.length, false);
    this.imports.push(entry);

    let value: Array<any> = ["pipeline", id, path];
    if (args) {
      let devalue = Devaluator.devaluate(args.value, undefined, this, args);

      // HACK: Since the args is an array, devaluator will wrap in a second array. Need to unwrap.
      // TODO: Clean this up somehow.
      value.push((<Array<unknown>>devalue)[0]);

      // Serializing the payload takes ownership of all stubs within, so the payload itself does
      // not need to be disposed.
    }
    this.send(["push", entry.importId, value]);
    this.trace("sendCall", { importId: entry.importId, targetImportId: id, pathLength: path.length, hasArgs: !!args });
    return new RpcImportHook(/*isPromise=*/true, entry);
  }

  sendStream(id: ImportId, path: PropertyPath, args: RpcPayload)
      : {promise: Promise<void>, size: number} {
    if (this.abortReason) throw this.abortReason;

    let importId = this.imports.length;
    let entry = new ImportTableEntry(this, importId, /*pulling=*/true);
    entry.remoteRefcount = 0;
    entry.localRefcount = 1;
    this.imports.push(entry);

    let value: Array<any> = ["pipeline", id, path];
    let devalue = Devaluator.devaluate(args.value, undefined, this, args);

    // HACK: Since the args is an array, devaluator will wrap in a second array. Need to unwrap.
    // TODO: Clean this up somehow.
    value.push((<Array<unknown>>devalue)[0]);

    let size = this.send(["stream", importId, value]);

    // Create the import entry in "already pulling" state (pulling=true), since stream messages
    // are automatically pulled. Set remoteRefcount to 0 so that resolve() won't send a release
    // message — the server implicitly releases the export after sending the resolve. Set
    // localRefcount to 1 so that resolve() doesn't treat this as already-disposed.
    this.trace("sendStream", { importId, targetImportId: id, pathLength: path.length, size });

    // Await the resolution, then dispose the result payload and clean up the import table entry.
    // (Normally, sendRelease() cleans up the import table, but since remoteRefcount is 0, we
    // need to do it manually.)
    let promise = entry.awaitResolution().then(
      p => { p.dispose(); delete this.imports[importId]; },
      err => { delete this.imports[importId]; throw err; }
    );

    return { promise, size };
  }

  sendMap(id: ImportId, path: PropertyPath, captures: StubHook[], instructions: unknown[])
      : RpcImportHook {
    if (this.abortReason) {
      for (let cap of captures) {
        cap.dispose();
      }
      throw this.abortReason;
    }

    let devaluedCaptures = captures.map(hook => {
      let importId = this.getImport(hook);
      if (importId !== undefined) {
        return ["import", importId];
      } else {
        return ["export", this.exportStub(hook)];
      }
    });

    let value = ["remap", id, path, devaluedCaptures, instructions];
    let entry = new ImportTableEntry(this, this.imports.length, false);
    this.imports.push(entry);
    this.send(["push", entry.importId, value]);
    this.trace("sendMap", { importId: entry.importId, targetImportId: id, pathLength: path.length, captureCount: captures.length });
    return new RpcImportHook(/*isPromise=*/true, entry);
  }

  sendPull(id: ImportId) {
    if (this.abortReason) throw this.abortReason;

    this.send(["pull", id]);
    this.trace("sendPull", { importId: id });
  }

  sendRelease(id: ImportId, remoteRefcount: number) {
    if (this.abortReason) return;

    this.send(["release", id, remoteRefcount]);
    this.trace("sendRelease", { importId: id, remoteRefcount });
    delete this.imports[id];
  }

  abort(error: any, trySendAbortMessage: boolean = true) {
    // Don't double-abort.
    if (this.abortReason !== undefined) return;

    this.cancelReadLoop(error);

    if (trySendAbortMessage) {
      try {
        this.transport.send(JSON.stringify(["abort", Devaluator
            .devaluate(error, undefined, this)]))
            .catch(err => {});
      } catch (err) {
        // ignore, probably the whole reason we're aborting is because the transport is broken
      }
    }

    if (error === undefined) {
      // Shouldn't happen, but if it does, avoid setting `abortReason` to `undefined`.
      error = "undefined";
    }

    this.abortReason = error;
    this.trace("abort", {
      error: error instanceof Error ? error.message : String(error),
      trySendAbortMessage,
    });
    if (this.onBatchDone) {
      this.onBatchDone.reject(error);
    }

    if (this.transport.abort) {
      // Call transport's abort handler, but guard against buggy app code.
      try {
        this.transport.abort(error);
      } catch (err) {
        // Treat as unhandled rejection.
        Promise.resolve(err);
      }
    }

    // WATCH OUT: these are sparse arrays. `for/let/of` will iterate only positive indexes
    // including deleted indexes -- bad. We need to use `for/let/in` instead.
    for (let i in this.onBrokenCallbacks) {
      try {
        this.onBrokenCallbacks[i](error);
      } catch (err) {
        // Treat as unhandled rejection.
        Promise.resolve(err);
      }
    }
    for (let i in this.imports) {
      this.imports[i].abort(error);
    }
    for (let i in this.exports) {
      this.exports[i].hook?.dispose();
    }
  }

  private async readLoop(abortPromise: Promise<never>) {
    while (!this.abortReason) {
      let msg = JSON.parse(await Promise.race([this.transport.receive(), abortPromise]));
      if (this.abortReason) break;  // check again before processing
      this.trace("receive", {
        kind: msg instanceof Array ? msg[0] : typeof msg,
        length: msg instanceof Array ? msg.length : null,
      });

      if (msg instanceof Array) {
        switch (msg[0]) {
          case "push":  // ["push", ImportId, Expression]
            if (msg.length > 2 && typeof msg[1] === "number") {
              let exportId = msg[1];
              if (containsImportedCapabilityReference(msg[2])) {
                this.importReplays.push({ expr: cloneRpcExpr(msg[2]) });
                this.trace("readLoop.push.recordImportReplay", {
                  exportId,
                  replayCount: this.importReplays.length,
                });
              }
              let payload = this.evaluateWithCurrentProvenance(msg[2]);
              let hook = new PayloadStubHook(payload);

              // It's possible for a rejection to occur before the client gets a chance to send
              // a "pull" message or to use the promise in a pipeline. We don't want that to be
              // treated as an unhandled rejection on our end.
              hook.ignoreUnhandledRejections();

              this.replacePositiveExport(exportId, {
                hook,
                refcount: 1,
                sourceExpr: cloneRpcExpr(msg[2]),
              });
              this.trace("readLoop.push", { exportId, hookType: hook.constructor?.name ?? null });
              continue;
            }
            break;

          case "stream": {  // ["stream", ImportId, Expression]
            // Like "push", but:
            // - Promise pipelining on the result is not supported.
            // - The export is automatically considered "pulled".
            // - Once the "resolve" is sent, the export is implicitly released.
            if (msg.length > 2 && typeof msg[1] === "number") {
              let exportId = msg[1];
              let payload = this.evaluateWithCurrentProvenance(msg[2]);
              let hook = new PayloadStubHook(payload);
              hook.ignoreUnhandledRejections();

              this.replacePositiveExport(exportId, {
                hook,
                refcount: 1,
                sourceExpr: cloneRpcExpr(msg[2]),
                autoRelease: true,
              });
              this.trace("readLoop.stream", { exportId, hookType: hook.constructor?.name ?? null });

              // Automatically pull since stream messages are always pulled.
              this.ensureResolvingExport(exportId);
              continue;
            }
            break;
          }

          case "pipe": {  // ["pipe", ImportId]
            // Create a TransformStream. The writable end becomes the export (so the sender can
            // write/close/abort it). The readable end is stashed for later retrieval via
            // ["readable", importId].
            if (msg.length > 1 && typeof msg[1] === "number") {
              let exportId = msg[1];
              let { readable, writable } = new TransformStream();
              let hook = streamImpl.createWritableStreamHook(writable);
              this.replacePositiveExport(exportId, { hook, refcount: 1, pipeReadable: readable });
              this.trace("readLoop.pipe", { exportId });
              continue;
            }
            break;
          }

          case "pull": {  // ["pull", ImportId]
            let exportId = msg[1];
            if (typeof exportId == "number") {
              this.trace("readLoop.pull", { exportId });
              this.ensureResolvingExport(exportId);
              continue;
            }
            break;
          }

          case "resolve":   // ["resolve", ExportId, Expression]
          case "reject": {  // ["reject", ExportId, Expression]
            let importId = msg[1];
            if (typeof importId == "number" && msg.length > 2) {
              this.trace(`readLoop.${msg[0]}`, { importId });
              let imp = this.imports[importId];
              if (imp) {
                if (msg[0] == "resolve") {
                  imp.resolve(new PayloadStubHook(new Evaluator(this).evaluate(msg[2])));
                } else {
                  // HACK: We expect errors are always simple values (no stubs) so we can just
                  //   pull the value out of the payload.
                  let payload = new Evaluator(this).evaluate(msg[2]);
                  payload.dispose();  // just in case -- should be no-op
                  imp.resolve(new ErrorStubHook(payload.value));
                }
              } else {
                // Import ID is not found on the table. Probably we released it already, in which
                // case we do not care about the resolution, so whatever.

                if (msg[0] == "resolve") {
                  // We need to evaluate the resolution and immediately dispose it so that we
                  // release any stubs it contains.
                  new Evaluator(this).evaluate(msg[2]).dispose();
                }
              }
              continue;
            }
            break;
          }

          case "release": {
            let exportId = msg[1];
            let refcount = msg[2];
            if (typeof exportId == "number" && typeof refcount == "number") {
              this.trace("readLoop.release", { exportId, refcount });
              this.releaseExport(exportId, refcount);
              continue;
            }
            break;
          }

          case "abort": {
            this.trace("readLoop.abort");
            let payload = new Evaluator(this).evaluate(msg[1]);
            payload.dispose();  // just in case -- should be no-op
            this.abort(payload, false);
            break;
          }
        }
      }

      throw new Error(`bad RPC message: ${JSON.stringify(msg)}`);
    }
  }

  async drain(): Promise<void> {
    if (this.abortReason) {
      throw this.abortReason;
    }

    if (this.pullCount > 0) {
      let {promise, resolve, reject} = Promise.withResolvers<void>();
      this.onBatchDone = {resolve, reject};
      await promise;
    }
  }

  getStats(): {imports: number, exports: number} {
    let result = {imports: 0, exports: 0};
    // We can't just use `.length` because the arrays can be sparse and can have negative indexes.
    for (let i in this.imports) {
      ++result.imports;
    }
    for (let i in this.exports) {
      ++result.exports;
    }
    return result;
  }

  __experimental_debugState(): RpcSessionDebugState {
    const exports: RpcSessionDebugState["exports"] = [];
    for (let i in this.exports) {
      const id = Number(i);
      const entry = this.exports[i];
      if (!entry) continue;
      exports.push({
        id,
        refcount: entry.refcount,
        hasHook: !!entry.hook,
        hookType: entry.hook?.constructor?.name ?? null,
        hookIdentity: entry.hook ? __experimental_debugStubHookIdentity(entry.hook) : null,
        provenance: entry.provenance ?? null,
        hasPull: !!entry.pull,
        autoRelease: !!entry.autoRelease,
        hasPipeReadable: !!entry.pipeReadable,
      });
    }

    const imports: RpcSessionDebugState["imports"] = [];
    for (let i in this.imports) {
      const entry = this.imports[i];
      if (!entry) continue;
      imports.push(entry.__experimental_debugState());
    }

    return {
      nextExportId: this.nextExportId,
      abortReason: this.abortReason ? String(this.abortReason) : null,
      pullCount: this.pullCount,
      exports,
      imports,
    };
  }

  private getOrRestoreExportHook(exportId: ExportId): StubHook {
    const entry = this.exports[exportId];
    if (!entry) {
      throw new Error(`no such export ID: ${exportId}`);
    }

    if (!entry.hook) {
      if (entry.provenance) {
        let payload = new Evaluator(this).evaluate(cloneRpcExpr(entry.provenance.expr));
        let hook: StubHook;
        if (entry.provenance.instructions) {
          const captures = (entry.provenance.captures ?? []).map(captureExpr => {
            const capturePayload = new Evaluator(this).evaluate(cloneRpcExpr(captureExpr));
            const captureValue = capturePayload.value;
            if (!(captureValue instanceof RpcStub)) {
              capturePayload.dispose();
              throw new Error("Map provenance capture did not evaluate to an RpcStub.");
            }

            const {hook: captureHook, pathIfPromise} = unwrapStubAndPath(captureValue);
            capturePayload.dispose();

            if (pathIfPromise && pathIfPromise.length > 0) {
              return captureHook.get(pathIfPromise);
            } else if (pathIfPromise) {
              return captureHook.get([]);
            } else {
              return captureHook.dup();
            }
          });

          if (payload.value instanceof RpcStub) {
            const {hook: provenanceHook, pathIfPromise} = unwrapStubAndPath(payload.value);
            hook = provenanceHook.map(pathIfPromise ?? [], captures, cloneRpcExpr(entry.provenance.instructions));
            payload.dispose();
          } else {
            hook = mapImpl.applyMap(
                payload.value,
                undefined,
                payload,
                captures,
                cloneRpcExpr(entry.provenance.instructions));
          }
        } else {
          hook = new PayloadStubHook(payload);
          if (entry.provenance.path && entry.provenance.path.length > 0) {
            let derived = hook.get(entry.provenance.path);
            hook.dispose();
            hook = derived;
          }
        }
        entry.hook = hook;
        this.reverseExports.set(entry.hook, exportId);
        this.trace("getOrRestoreExportHook.replay", {
          exportId,
          pathLength: entry.provenance.path?.length ?? 0,
          instructionCount: entry.provenance.instructions?.length ?? 0,
          hookType: entry.hook.constructor?.name ?? null,
        });
      } else {
        throw new Error(`Export ${exportId} can't be restored after hibernation because it has no provenance.`);
      }
    }

    return entry.hook;
  }

  private restoreFromSnapshot(snapshot: RpcSessionSnapshot) {
    if (snapshot.version !== 1 && snapshot.version !== 2) {
      throw new Error(`Unsupported RPC session snapshot version: ${snapshot.version}`);
    }

    this.nextExportId = snapshot.nextExportId;
    const pendingPulls: ExportId[] = [];
    this.trace("restoreFromSnapshot.begin", {
      nextExportId: snapshot.nextExportId,
      exportCount: snapshot.exports.length,
      importCount: snapshot.imports?.length ?? 0,
    });

    for (let exp of snapshot.exports) {
      this.exports[exp.id] = {
        refcount: exp.refcount,
        ...(exp.provenance ? { provenance: exp.provenance } : {}),
      };
      this.trace("restoreFromSnapshot.export", {
        exportId: exp.id,
        refcount: exp.refcount,
        hasProvenance: !!exp.provenance,
        pulling: !!exp.pulling,
      });
      if (exp.pulling) {
        pendingPulls.push(exp.id);
      }
    }

    if (snapshot.imports) {
      for (let imp of snapshot.imports) {
        let entry = new ImportTableEntry(this, imp.id, false);
        entry.remoteRefcount = imp.remoteRefcount;
        this.imports[imp.id] = entry;
        this.trace("restoreFromSnapshot.import", {
          importId: imp.id,
          remoteRefcount: imp.remoteRefcount,
        });
      }
    }

    if (snapshot.importReplays && snapshot.importReplays.length > 0) {
      this.importReplays = snapshot.importReplays.map(cloneRpcProvenance);
      for (let replay of this.importReplays) {
        this.trace("restoreFromSnapshot.importReplay.begin", {
          hasCaptures: !!replay.captures?.length,
          instructionCount: replay.instructions?.length ?? 0,
          pathLength: replay.path?.length ?? 0,
        });
        let payload = new Evaluator(this).evaluate(cloneRpcExpr(replay.expr));
        payload.dispose();
      }
    }

    if (pendingPulls.length > 0) {
      queueMicrotask(() => {
        for (let id of pendingPulls) {
          this.ensureResolvingExport(id);
        }
      });
    }
  }

  __experimental_getImportedStub(importId: number): RpcStub {
    const entry = this.imports[importId];
    if (!entry) {
      throw new Error(`no such import ID: ${importId}`);
    }
    return new RpcStub(new RpcImportHook(false, entry));
  }
}

function containsImportedCapabilityReference(value: unknown): boolean {
  if (!(value instanceof Array)) {
    if (value && typeof value === "object") {
      for (let nested of Object.values(value as Record<string, unknown>)) {
        if (containsImportedCapabilityReference(nested)) {
          return true;
        }
      }
    }
    return false;
  }

  if (value.length > 0 && (value[0] === "export" || value[0] === "promise")) {
    return true;
  }

  for (let nested of value) {
    if (containsImportedCapabilityReference(nested)) {
      return true;
    }
  }
  return false;
}

// Public interface that wraps RpcSession and hides private implementation details (even from
// JavaScript with no type enforcement).
export class RpcSession {
  #session: RpcSessionImpl;
  #mainStub: RpcStub;

  constructor(transport: RpcTransport, localMain?: any, options: RpcSessionOptions = {}) {
    let mainHook: StubHook;
    if (localMain) {
      mainHook = new PayloadStubHook(RpcPayload.fromAppReturn(localMain));
    } else {
      mainHook = new ErrorStubHook(new Error("This connection has no main object."));
    }
    this.#session = new RpcSessionImpl(transport, mainHook, options);
    this.#mainStub = new RpcStub(this.#session.getMainImport());
  }

  getRemoteMain(): RpcStub {
    return this.#mainStub;
  }

  getStats(): {imports: number, exports: number} {
    return this.#session.getStats();
  }

  drain(): Promise<void> {
    return this.#session.drain();
  }

  __experimental_snapshot(): RpcSessionSnapshot {
    return this.#session.__experimental_snapshot();
  }

  __experimental_debugState(): RpcSessionDebugState {
    return this.#session.__experimental_debugState();
  }

  __experimental_getImportedStub(importId: number): RpcStub {
    return this.#session.__experimental_getImportedStub(importId);
  }
}
