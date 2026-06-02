// Copyright (c) 2025 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE.txt file or at:
//     https://opensource.org/license/mit

import { RpcStub } from "./core.js";
import { RpcTransport, RpcSession, RpcSessionOptions } from "./rpc.js";
import type { IncomingMessage, ServerResponse, OutgoingHttpHeader, OutgoingHttpHeaders } from "node:http";

type WireMessage = string | Uint8Array;
type SendBatchFunc = (batch: WireMessage[]) => Promise<WireMessage[]>;

// Content type used for binary-codec (e.g. CBOR) batches. The default JSON codec
// uses newline-delimited text and sets no special content type, so the JSON wire
// format is unchanged.
const BINARY_CONTENT_TYPE = "application/octet-stream";

/** True if the batch contains any binary message (i.e. a binary codec is in use). */
function batchIsBinary(batch: WireMessage[]): boolean {
  return batch.some(message => typeof message !== "string");
}

function toBytes(message: WireMessage): Uint8Array {
  return typeof message === "string" ? new TextEncoder().encode(message) : message;
}

/**
 * Pack multiple binary messages into one buffer using 4-byte big-endian
 * length-prefix framing: [len][bytes][len][bytes]... A binary codec's bytes can
 * contain any value (including 0x0A), so the JSON path's newline delimiter can't
 * be reused.
 */
function encodeBinaryBatch(messages: WireMessage[]): Uint8Array {
  const parts = messages.map(toBytes);
  let total = 0;
  for (const part of parts) total += 4 + part.length;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, false);
    offset += 4;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function decodeBinaryBatch(data: Uint8Array): Uint8Array[] {
  const messages: Uint8Array[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  while (offset < data.length) {
    const length = view.getUint32(offset, false);
    offset += 4;
    messages.push(data.slice(offset, offset + length));
    offset += length;
  }
  return messages;
}

function isBinaryContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.includes(BINARY_CONTENT_TYPE) || contentType.includes("cbor");
}

class BatchClientTransport implements RpcTransport {
  constructor(sendBatch: SendBatchFunc) {
    this.#promise = this.#scheduleBatch(sendBatch);
  }

  #promise: Promise<void>;
  #aborted: any;

  #batchToSend: WireMessage[] | null = [];
  #batchToReceive: WireMessage[] | null = null;

  async send(message: WireMessage): Promise<void> {
    // If the batch was already sent, we just ignore the message, because throwing may cause the
    // RPC system to abort prematurely. Once the last receive() is done then we'll throw an error
    // that aborts the RPC system at the right time and will propagate to all other requests.
    if (this.#batchToSend !== null) {
      this.#batchToSend.push(message);
    }
  }

  async receive(): Promise<WireMessage> {
    if (!this.#batchToReceive) {
      await this.#promise;
    }

    let msg = this.#batchToReceive!.shift();
    if (msg !== undefined) {
      return msg;
    } else {
      // No more messages. An error thrown here will propagate out of any calls that are still
      // open.
      throw new Error("Batch RPC request ended.");
    }
  }

  abort?(reason: any): void {
    this.#aborted = reason;
  }

  async #scheduleBatch(sendBatch: SendBatchFunc) {
    // Wait for microtask queue to clear before sending a batch.
    //
    // Note that simply waiting for one turn of the microtask queue (await Promise.resolve()) is
    // not good enough here as the application needs a chance to call `.then()` on every RPC
    // promise in order to explicitly indicate they want the results. Unfortunately, `await`ing
    // a thenable does not call `.then()` immediately -- for some reason it waits for a turn of
    // the microtask queue first, *then* calls `.then()`.
    await new Promise(resolve => setTimeout(resolve, 0));

    if (this.#aborted !== undefined) {
      throw this.#aborted;
    }

    let batch = this.#batchToSend!;
    this.#batchToSend = null;
    this.#batchToReceive = await sendBatch(batch);
  }
}

export function newHttpBatchRpcSession(
    urlOrRequest: string | Request, options?: RpcSessionOptions): RpcStub {
  let sendBatch: SendBatchFunc = async (batch: WireMessage[]) => {
    if (batchIsBinary(batch)) {
      // Binary codec: length-prefixed framing over an octet-stream body. The
      // server mirrors this mode, so the response is decoded the same way.
      let response = await fetch(urlOrRequest, {
        method: "POST",
        headers: { "Content-Type": BINARY_CONTENT_TYPE },
        body: encodeBinaryBatch(batch) as BodyInit,
      });

      if (!response.ok) {
        response.body?.cancel();
        throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
      }

      let body = new Uint8Array(await response.arrayBuffer());
      return body.byteLength === 0 ? [] : decodeBinaryBatch(body);
    }

    // Default JSON codec: newline-delimited text (unchanged wire format).
    let response = await fetch(urlOrRequest, {
      method: "POST",
      body: batch.join("\n"),
    });

    if (!response.ok) {
      response.body?.cancel();
      throw new Error(`RPC request failed: ${response.status} ${response.statusText}`);
    }

    let body = await response.text();
    return body == "" ? [] : body.split("\n");
  };

  let transport = new BatchClientTransport(sendBatch);
  let rpc = new RpcSession(transport, undefined, options);
  return rpc.getRemoteMain();
}

class BatchServerTransport implements RpcTransport {
  constructor(batch: WireMessage[]) {
    this.#batchToReceive = batch;
  }

  #batchToSend: WireMessage[] = [];
  #batchToReceive: WireMessage[];
  #allReceived: PromiseWithResolvers<void> = Promise.withResolvers<void>();

  async send(message: WireMessage): Promise<void> {
    this.#batchToSend.push(message);
  }

  async receive(): Promise<WireMessage> {
    let msg = this.#batchToReceive!.shift();
    if (msg !== undefined) {
      return msg;
    } else {
      // No more messages.
      this.#allReceived.resolve();
      return new Promise(r => {});
    }
  }

  abort?(reason: any): void {
    this.#allReceived.reject(reason);
  }

  whenAllReceived() {
    return this.#allReceived.promise;
  }

  /** Newline-delimited text body for the default JSON codec. */
  getResponseBody(): string {
    return this.#batchToSend.join("\n");
  }

  /** Length-prefixed binary body for a binary codec (e.g. CBOR). */
  getResponseBytes(): Uint8Array {
    return encodeBinaryBatch(this.#batchToSend);
  }
}

/**
 * Implements the server end of an HTTP batch session, using standard Fetch API types to represent
 * HTTP requests and responses.
 *
 * @param request The request received from the client initiating the session.
 * @param localMain The main stub or RpcTarget which the server wishes to expose to the client.
 * @param options Optional RPC session options.
 * @returns The HTTP response to return to the client. Note that the returned object has mutable
 *     headers, so you can modify them using e.g. `response.headers.set("Foo", "bar")`.
 */
export async function newHttpBatchRpcResponse(
    request: Request, localMain: any, options?: RpcSessionOptions): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("This endpoint only accepts POST requests.", { status: 405 });
  }

  const binary = isBinaryContentType(request.headers.get("Content-Type"));

  let batch: WireMessage[];
  if (binary) {
    let body = new Uint8Array(await request.arrayBuffer());
    batch = body.byteLength === 0 ? [] : decodeBinaryBatch(body);
  } else {
    let body = await request.text();
    batch = body === "" ? [] : body.split("\n");
  }

  let transport = new BatchServerTransport(batch);
  let rpc = new RpcSession(transport, localMain, options);

  // TODO: Arguably we should arrange so any attempts to pull promise resolutions from the client
  //   will reject rather than just hang. But it IS valid to make server->client calls in order to
  //   then pipeline the result into something returned to the client. We don't want the errors to
  //   prematurely cancel anything that would eventually complete. So for now we just say, it's the
  //   app's responsibility to not wait on any server -> client calls since they will never
  //   complete.

  await transport.whenAllReceived();
  await rpc.drain();

  // TODO: Ask RpcSession to dispose everything it is still holding on to?

  // Mirror the request's framing in the response so the client decodes it correctly.
  if (binary) {
    return new Response(transport.getResponseBytes() as BodyInit, {
      headers: { "Content-Type": BINARY_CONTENT_TYPE },
    });
  }
  return new Response(transport.getResponseBody());
}

/**
 * Implements the server end of an HTTP batch session using traditional Node.js HTTP APIs.
 *
 * @param request The request received from the client initiating the session.
 * @param response The response object, to which the response should be written.
 * @param localMain The main stub or RpcTarget which the server wishes to expose to the client.
 * @param options Optional RPC session options. You can also pass headers to set on the response.
 */
export async function nodeHttpBatchRpcResponse(
    request: IncomingMessage, response: ServerResponse,
    localMain: any,
    options?: RpcSessionOptions & {
      headers?: OutgoingHttpHeaders | OutgoingHttpHeader[],
    }): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(405, "This endpoint only accepts POST requests.");
  }

  const binary = isBinaryContentType(request.headers["content-type"]);

  let bodyBuffer = await new Promise<Buffer>((resolve, reject) => {
    let chunks: Buffer[] = [];
    request.on("data", chunk => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });

  let batch: WireMessage[];
  if (binary) {
    let body = new Uint8Array(bodyBuffer.buffer, bodyBuffer.byteOffset, bodyBuffer.byteLength);
    batch = body.byteLength === 0 ? [] : decodeBinaryBatch(body);
  } else {
    let body = bodyBuffer.toString();
    batch = body === "" ? [] : body.split("\n");
  }

  let transport = new BatchServerTransport(batch);
  let rpc = new RpcSession(transport, localMain, options);

  await transport.whenAllReceived();
  await rpc.drain();

  // Mirror the request's framing in the response so the client decodes it correctly.
  if (binary) {
    const headers = { ...(options?.headers as OutgoingHttpHeaders | undefined), "Content-Type": BINARY_CONTENT_TYPE };
    response.writeHead(200, headers);
    const bytes = transport.getResponseBytes();
    response.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } else {
    response.writeHead(200, options?.headers);
    response.end(transport.getResponseBody());
  }
}
