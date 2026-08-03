// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcStub } from "./core.js";
import { RpcTransport, RpcSession, RpcSessionOptions } from "./rpc.js";
import { RpcTargetBranded } from "./types.js";
import type { ServerWebSocket } from "bun";
import type { Codec } from "./codec/index.js";
import { CodecTransport } from "./codec/transport.js";

/** Options accepted by the Bun helpers: session options plus an optional wire codec. */
export type BunSessionOptions = RpcSessionOptions & {
  /**
   * Optional wire codec (e.g. CBOR via `capnweb/codec/cbor`). When set, the layering is
   * `session → CodecTransport (codec encodes/decodes) → Bun WebSocket transport (raw frames)`.
   * Both ends of the session must use the same codec and codec options; there is no codec
   * negotiation in the protocol. Omitted → standard JSON text.
   */
  codec?: Codec;
};

/**
 * Start an RPC session over a Bun ServerWebSocket.
 *
 * Returns both the stub and the transport. The transport must be wired to Bun's
 * `WebSocketHandler` callbacks (`message`, `close`, `error`) by calling its
 * `dispatchMessage`, `dispatchClose`, and `dispatchError` methods.
 *
 * For a zero-wiring alternative, see `newBunWebSocketRpcHandler`.
 */
export function newBunWebSocketRpcSession<T>(
    ws: ServerWebSocket<T>, localMain?: any,
    options?: BunSessionOptions): { stub: RpcStub, transport: BunWebSocketTransport<T> } {
  let transport = new BunWebSocketTransport<T>(ws);
  // Without a codec, only text frames ever flow; the transport's wider message type exists for
  // the codec case, so asserting the string-only RpcTransport shape states a runtime fact.
  let sessionTransport = options?.codec
      ? new CodecTransport(transport, options.codec,
          { maxMessageSize: options.limits?.maxMessageSize })
      : transport as RpcTransport;
  let rpc = new RpcSession(sessionTransport, localMain, options);
  return { stub: rpc.getRemoteMain(), transport };
}

type WsData = { __capnwebTransport: BunWebSocketTransport<WsData>, __capnwebStub: RpcStub };

/**
 * Create a Bun `WebSocketHandler` object that manages RPC sessions automatically.
 *
 * The returned object can be passed directly as the `websocket` option to `Bun.serve()`.
 * A fresh `localMain` is created for each connection via the `createMain` callback.
 * The transport is stored on `ws.data.__capnwebTransport`.
 *
 * @param createMain Called once per connection to create the main RPC interface for that client.
 * @param options Optional RPC session options applied to every connection.
 */
export function newBunWebSocketRpcHandler(createMain: () => RpcTargetBranded, options?: BunSessionOptions) {
  return {
    open(ws: ServerWebSocket<WsData>) {
      let transport = new BunWebSocketTransport<WsData>(ws);
      let sessionTransport = options?.codec
          ? new CodecTransport(transport, options.codec,
              { maxMessageSize: options.limits?.maxMessageSize })
          : transport as RpcTransport;
      let rpc = new RpcSession(sessionTransport, createMain(), options);
      ws.data = { __capnwebTransport: transport, __capnwebStub: rpc.getRemoteMain() };
    },
    message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
      ws.data.__capnwebTransport.dispatchMessage(message);
    },
    close(ws: ServerWebSocket<WsData>, code: number, reason: string) {
      ws.data.__capnwebTransport.dispatchClose(code, reason);
    },
    error(ws: ServerWebSocket<WsData>, error: Error) {
      ws.data.__capnwebTransport.dispatchError(error);
    },
  };
}

// Carries `string | Uint8Array` frames (binary for codec sessions), so it is intentionally wider
// than `RpcTransport` and doesn't declare `implements`. Codec-less sessions assert the
// string-only shape at the construction sites above.
export class BunWebSocketTransport<T = undefined> {
  constructor (ws: ServerWebSocket<T>) {
    this.#ws = ws;
  }

  #ws: ServerWebSocket<T>;
  #receiveResolver?: (message: string | Uint8Array) => void;
  #receiveRejecter?: (err: any) => void;
  #receiveQueue: (string | Uint8Array)[] = [];
  #error?: any;

  async send(message: string | Uint8Array): Promise<void> {
    this.#ws.send(message);
  }

  async receive(): Promise<string | Uint8Array> {
    if (this.#receiveQueue.length > 0) {
      return this.#receiveQueue.shift()!;
    } else if (this.#error) {
      throw this.#error;
    } else {
      return new Promise<string | Uint8Array>((resolve, reject) => {
        this.#receiveResolver = resolve;
        this.#receiveRejecter = reject;
      });
    }
  }

  abort?(reason: any): void {
    let message: string;
    if (reason instanceof Error) {
      message = reason.message;
    } else {
      message = `${reason}`;
    }
    this.#ws.close(3000, message);

    if (!this.#error) {
      this.#error = reason;
      // No need to call receiveRejecter(); RPC implementation will stop listening anyway.
    }
  }

  dispatchMessage(data: string | Buffer | ArrayBuffer | Uint8Array): void {
    if (this.#error) {
      return;
    }

    // Strings carry the default JSON codec; binary frames carry a binary codec
    // (e.g. CBOR). Preserve bytes as Uint8Array rather than forcing UTF-8.
    let message: string | Uint8Array;
    if (typeof data === "string") {
      message = data;
    } else if (data instanceof ArrayBuffer) {
      message = new Uint8Array(data);
    } else {
      // Node/Bun Buffer is a Uint8Array subclass; pass through as bytes.
      message = data;
    }

    if (this.#receiveResolver) {
      this.#receiveResolver(message);
      this.#receiveResolver = undefined;
      this.#receiveRejecter = undefined;
    } else {
      this.#receiveQueue.push(message);
    }
  }

  dispatchClose(code: number, reason: string): void {
    this.#receivedError(new Error(`Peer closed WebSocket: ${code} ${reason}`));
  }

  dispatchError(error: Error): void {
    this.#receivedError(new Error(`WebSocket connection failed.`));
  }

  #receivedError(reason: any) {
    if (!this.#error) {
      this.#error = reason;
      if (this.#receiveRejecter) {
        this.#receiveRejecter(reason);
        this.#receiveResolver = undefined;
        this.#receiveRejecter = undefined;
      }
    }
  }
}
