import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { unstable_dev } from "wrangler";
import type { UnstableDevWorker } from "wrangler";
import { WebSocket } from "ws";
import { RpcStub, RpcTarget, newWebSocketRpcSession, __experimental_debugRpcReference } from "../src/index.ts";

let worker: UnstableDevWorker;

beforeAll(async () => {
  worker = await unstable_dev("src/index.ts", {
    config: "wrangler.jsonc",
    experimental: { disableExperimentalWarning: true },
  });
});

afterAll(async () => {
  await worker?.stop();
});

function connectWebSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`http://${worker.address}:${worker.port}/ws`, {
      headers: { Upgrade: "websocket" },
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function connectRoomWebSocket(roomName: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
        `http://${worker.address}:${worker.port}/chat-room-ws?room=${encodeURIComponent(roomName)}`,
        {
          headers: { Upgrade: "websocket" },
        });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

async function getInstanceId(): Promise<string> {
  const resp = await worker.fetch("/instance-id");
  const json = (await resp.json()) as { instanceId: string };
  return json.instanceId;
}

async function getAttachments(): Promise<{
  instanceId: string;
  count: number;
  attachments: Array<{
    sessionId: string | null;
    version: number | null;
    hasSnapshot: boolean;
    snapshot: { nextExportId: number | null; exportCount: number; importCount: number } | null;
  }>;
}> {
  const resp = await worker.fetch("/attachments");
  return await resp.json();
}

async function getResumeDiagnostics(): Promise<{
  instanceId: string;
  sessionCount: number;
  counters: {
    restoreAttempts: number;
    restoreSuccesses: number;
    attachSessionCalls: number;
    webSocketMessageCount: number;
    reusedSessionCount: number;
    createdSessionCount: number;
    lastMessageKind: string | null;
  };
  sessions: Array<{
    sessionId: string | null;
    hasAttachment: boolean;
    hasSnapshot: boolean;
    hasSession: boolean;
    stats: { imports: number; exports: number } | null;
    attachmentSnapshot: { nextExportId: number | null; exportCount: number; importCount: number } | null;
    snapshot: { nextExportId: number | null; exportCount: number; importCount: number; error: string | null } | null;
    debugState: any;
    traces: Array<{
      at: number;
      source: string;
      phase: string;
      detail?: Record<string, unknown>;
    }>;
  }>;
}> {
  const resp = await worker.fetch("/resume-diagnostics");
  return await resp.json();
}

async function waitForHibernation(beforeId: string): Promise<string> {
  await new Promise((r) => setTimeout(r, 15_000));
  const newId = await getInstanceId();
  if (newId === beforeId) {
    throw new Error(`DO did not hibernate after 15s (instanceId stayed ${beforeId})`);
  }
  return newId;
}

function withTimeout<T>(promise: Promise<T>, ms = 5000, label = "RPC call"): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

let keySeq = 0;
function uniqueKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${keySeq++}`;
}

function findDurableCounterExport(
    diagnostics: Awaited<ReturnType<typeof getResumeDiagnostics>>,
    key: string) {
  return diagnostics.sessions
      .flatMap(session => session.debugState?.exports ?? [])
      .find((exp: any) =>
        Array.isArray(exp?.provenance?.expr) &&
        exp.provenance.expr[0] === "pipeline" &&
        exp.provenance.expr[1] === 0 &&
        Array.isArray(exp.provenance.expr[2]) &&
        exp.provenance.expr[2][0] === "getDurableCounter" &&
        Array.isArray(exp.provenance.expr[3]) &&
        exp.provenance.expr[3][0] === key);
}

function logResumeState(label: string, diagnostics: Awaited<ReturnType<typeof getResumeDiagnostics>>) {
  console.log(`[${label}] resume diagnostics:`, JSON.stringify(diagnostics, null, 2));
}

function logAttachments(label: string, attachments: Awaited<ReturnType<typeof getAttachments>>) {
  console.log(`[${label}] attachments:`, JSON.stringify(attachments, null, 2));
}

function formatSideBySide(
    leftLabel: string,
    leftValue: unknown,
    rightLabel: string,
    rightValue: unknown): string {
  const leftLines = [`${leftLabel}:`, ...JSON.stringify(leftValue, null, 2).split("\n")];
  const rightLines = [`${rightLabel}:`, ...JSON.stringify(rightValue, null, 2).split("\n")];
  const leftWidth = Math.max(...leftLines.map(line => line.length), 24);
  const lineCount = Math.max(leftLines.length, rightLines.length);
  const rows: string[] = [];

  for (let i = 0; i < lineCount; i++) {
    const left = (leftLines[i] ?? "").padEnd(leftWidth, " ");
    const right = rightLines[i] ?? "";
    rows.push(`${left} | ${right}`);
  }

  return rows.join("\n");
}

function logSideBySide(
    title: string,
    leftLabel: string,
    leftValue: unknown,
    rightLabel: string,
    rightValue: unknown) {
  console.log(`[${title}]\n${formatSideBySide(leftLabel, leftValue, rightLabel, rightValue)}`);
}

describe("real hibernatable DO with capnweb RPC", () => {
  it("websocket attachment survives hibernation and still contains session state", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      expect(await root.echo("prime-attachment")).toBe("prime-attachment");

      const before = await getAttachments();
      expect(before.count).toBeGreaterThan(0);
      expect(before.attachments[0]?.version).toBe(1);
      expect(before.attachments[0]?.sessionId).toBeTruthy();
      expect(before.attachments[0]?.hasSnapshot).toBe(true);
      expect(before.attachments[0]?.snapshot).not.toBeNull();

      const beforeInstanceId = before.instanceId;
      const beforeSessionId = before.attachments[0]!.sessionId;

      const afterInstanceId = await waitForHibernation(beforeInstanceId);
      const after = await getAttachments();

      expect(after.instanceId).toBe(afterInstanceId);
      expect(after.count).toBeGreaterThan(0);
      expect(after.attachments.some((item) =>
          item.sessionId === beforeSessionId &&
          item.version === 1 &&
          item.hasSnapshot)).toBe(true);
    } finally {
      ws.close();
    }
  });

  it("basic RPC works through a real WebSocket + DO", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      expect(await root.square(7)).toBe(49);
      expect(await root.echo("hello")).toBe("hello");
    } finally {
      ws.close();
    }
  });

  it("durable counter works", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      const counter = await root.getDurableCounter(uniqueKey("basic"));
      expect(await counter.increment(10)).toBe(10);
      expect(await counter.increment(5)).toBe(15);
      expect(await counter.getValue()).toBe(15);
    } finally {
      ws.close();
    }
  });

  it("passes a chat-room capability over one websocket and keeps the held room stub working after hub hibernation", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      const roomName = uniqueKey("room");
      const room = await root.getChatRoom(roomName);

      expect(await room.postMessage("sam", "hello room")).toMatchObject({
        count: 1,
        last: { user: "sam", text: "hello room" },
      });
      expect(await room.getMessageCount()).toBe(1);

      const beforeMessages = await room.listMessages();
      expect(beforeMessages).toHaveLength(1);
      expect(beforeMessages[0]).toMatchObject({ user: "sam", text: "hello room" });

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      expect(await room.postMessage("sam", "after wake")).toMatchObject({
        count: 2,
        last: { user: "sam", text: "after wake" },
      });
      expect(await room.getMessageCount()).toBe(2);

      const afterMessages = await room.listMessages();
      expect(afterMessages).toHaveLength(2);
      expect(afterMessages.map((m: any) => m.text)).toEqual(["hello room", "after wake"]);
    } finally {
      ws.close();
    }
  });

  it("direct client-to-room capnweb websocket keeps a held room capability working after room hibernation", { timeout: 30_000 }, async () => {
    const roomName = uniqueKey("direct-room");
    const ws = await connectRoomWebSocket(roomName);
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      const room = await root.getRoomCapability();

      expect(await room.postMessage("sam", "hello direct room")).toMatchObject({
        count: 1,
        last: { user: "sam", text: "hello direct room" },
      });
      expect(await room.getMessageCount()).toBe(1);

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      expect(await room.postMessage("sam", "after direct wake")).toMatchObject({
        count: 2,
        last: { user: "sam", text: "after direct wake" },
      });
      expect(await room.getMessageCount()).toBe(2);
    } finally {
      ws.close();
    }
  });

  it("restores a server-side session object from the attachment before any post-wake RPC", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      expect(await root.echo("prime-session")).toBe("prime-session");

      const before = await getAttachments();
      const beforeSessionId = before.attachments[0]?.sessionId;
      expect(beforeSessionId).toBeTruthy();

      const idBefore = await root.getInstanceId();
      const afterInstanceId = await waitForHibernation(idBefore);
      const diagnostics = await getResumeDiagnostics();

      expect(diagnostics.instanceId).toBe(afterInstanceId);
      expect(diagnostics.counters.restoreAttempts).toBeGreaterThan(0);
      expect(diagnostics.counters.restoreSuccesses).toBeGreaterThan(0);
      expect(diagnostics.sessionCount).toBeGreaterThan(0);
      expect(diagnostics.sessions.some((session) =>
          session.sessionId === beforeSessionId &&
          session.hasAttachment &&
          session.hasSnapshot &&
          session.hasSession)).toBe(true);
    } finally {
      ws.close();
    }
  });

  it("restored session can snapshot itself after wake", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      const counter = await root.getDurableCounter(uniqueKey("snapshot"));
      expect(await counter.increment(2)).toBe(2);

      const before = await getAttachments();
      const beforeSessionId = before.attachments[0]?.sessionId;
      expect(beforeSessionId).toBeTruthy();

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);
      const diagnostics = await getResumeDiagnostics();
      const restored = diagnostics.sessions.find((session) => session.sessionId === beforeSessionId);

      expect(restored).toBeDefined();
      expect(restored!.hasSession).toBe(true);
      expect(restored!.snapshot).not.toBeNull();
      expect(restored!.snapshot!.error).toBeNull();
      expect(restored!.snapshot!.nextExportId).not.toBeNull();
    } finally {
      ws.close();
    }
  });

  it("restored session retains a hibernation snapshot in both attachment and live session state", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      expect(await root.echo("prime-dual-snapshot")).toBe("prime-dual-snapshot");

      const before = await getAttachments();
      const beforeSessionId = before.attachments[0]?.sessionId;
      expect(before.attachments[0]?.hasSnapshot).toBe(true);
      expect(beforeSessionId).toBeTruthy();

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      const diagnostics = await getResumeDiagnostics();
      const restored = diagnostics.sessions.find((session) => session.sessionId === beforeSessionId);
      expect(restored).toBeDefined();
      expect(restored!.hasSnapshot).toBe(true);
      expect(restored!.attachmentSnapshot).not.toBeNull();
      expect(restored!.snapshot).not.toBeNull();
      expect(restored!.snapshot!.error).toBeNull();
    } finally {
      ws.close();
    }
  });

  it("restored session preserves hibernatable child export provenance in the attachment snapshot", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      const counter = await root.getDurableCounter(uniqueKey("descriptor"));
      expect(await counter.increment(1)).toBe(1);

      const before = await getAttachments();
      const beforeSessionId = before.attachments[0]?.sessionId;
      expect(before.attachments[0]?.snapshot?.exportCount ?? 0).toBeGreaterThan(0);

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      const diagnostics = await getResumeDiagnostics();
      const restored = diagnostics.sessions.find((session) => session.sessionId === beforeSessionId);
      expect(restored).toBeDefined();
      expect(restored!.attachmentSnapshot?.exportCount ?? 0).toBeGreaterThan(0);
    } finally {
      ws.close();
    }
  });

  it("restored durable export hook is rebuilt on first use attempt and child-stub behavior remains seamless", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      const key = uniqueKey("rebuild-hook");
      const counter = await root.getDurableCounter(key);
      expect(await counter.increment(1)).toBe(1);

      const before = await getResumeDiagnostics();
      const beforeExport = findDurableCounterExport(before, key);
      expect(beforeExport).toBeDefined();
      expect(beforeExport.hasHook).toBe(true);
      expect(beforeExport.hookType).toBe("TargetStubHook");
      logSideBySide(
          "before-hibernation root vs server bootstrap export",
          "client root ref",
          __experimental_debugRpcReference(root),
          "server export[0]",
          before.sessions[0]?.debugState?.exports?.find((exp: any) => exp.id === 0) ?? null);
      logSideBySide(
          "before-hibernation counter vs server durable export",
          "client counter ref",
          __experimental_debugRpcReference(counter),
          "server durable export",
          beforeExport);

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      const afterWake = await getResumeDiagnostics();
      const restoredExport = findDurableCounterExport(afterWake, key);
      expect(restoredExport).toBeDefined();
      expect(restoredExport.hasHook).toBe(false);
      expect(restoredExport.provenance?.expr).toEqual(["pipeline", 0, ["getDurableCounter"], [key]]);
      logSideBySide(
          "after-wake before use: root vs bootstrap export",
          "client root ref",
          __experimental_debugRpcReference(root),
          "server export[0]",
          afterWake.sessions[0]?.debugState?.exports?.find((exp: any) => exp.id === 0) ?? null);
      logSideBySide(
          "after-wake before use: counter vs restored durable export",
          "client counter ref",
          __experimental_debugRpcReference(counter),
          "server durable export",
          restoredExport);

      expect(await withTimeout(counter.increment(1), 1500, "restored child increment")).toBe(2);

      const afterAttempt = await getResumeDiagnostics();
      const rebuiltExport = findDurableCounterExport(afterAttempt, key);
      expect(rebuiltExport).toBeDefined();
      expect(rebuiltExport.hasHook).toBe(true);
      expect(rebuiltExport.hookType).toBe("PromiseStubHook");
      expect(rebuiltExport.provenance?.expr).toEqual(["pipeline", 0, ["getDurableCounter"], [key]]);
      logSideBySide(
          "after first post-wake use: root vs bootstrap export",
          "client root ref",
          __experimental_debugRpcReference(root),
          "server export[0]",
          afterAttempt.sessions[0]?.debugState?.exports?.find((exp: any) => exp.id === 0) ?? null);
      logSideBySide(
          "after first post-wake use: counter vs rebuilt durable export",
          "client counter ref",
          __experimental_debugRpcReference(counter),
          "server durable export",
          rebuiltExport);
    } finally {
      ws.close();
    }
  });

  it("logs pre-hibernation live export/import state, serialized attachment state, and post-wake restored state", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      const key = uniqueKey("shape");
      const counter = await root.getDurableCounter(key);
      expect(await counter.increment(2)).toBe(2);

      const beforeAttachments = await getAttachments();
      const beforeDiagnostics = await getResumeDiagnostics();
      logAttachments("before-hibernation", beforeAttachments);
      logResumeState("before-hibernation", beforeDiagnostics);

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      const afterAttachments = await getAttachments();
      const afterDiagnostics = await getResumeDiagnostics();
      logAttachments("after-hibernation", afterAttachments);
      logResumeState("after-hibernation", afterDiagnostics);

      expect(beforeAttachments.attachments[0]?.hasSnapshot).toBe(true);
      expect(afterAttachments.attachments[0]?.hasSnapshot).toBe(true);
      expect(beforeDiagnostics.sessions[0]?.debugState?.exports).toBeDefined();
      expect(afterDiagnostics.sessions[0]?.debugState?.exports).toBeDefined();
    } finally {
      ws.close();
    }
  });

  it("first post-wake websocket message reaches the restored session and completes normally", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      expect(await root.square(6)).toBe(36);

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      expect(await withTimeout(root.square(11), 1500, "post-wake root.square")).toBe(121);

      const diagnostics = await getResumeDiagnostics();
      expect(diagnostics.counters.webSocketMessageCount).toBeGreaterThan(0);
      expect(diagnostics.counters.reusedSessionCount).toBeGreaterThan(0);
      expect(diagnostics.counters.lastMessageKind).toMatch(/^string|^binary\(/);
      const traces = diagnostics.sessions.flatMap((session) => session.traces ?? []);
      expect(traces.some((trace) => trace.phase === "receive")).toBe(true);
      expect(traces.some((trace) => trace.phase === "readLoop.push")).toBe(true);
      expect(traces.some((trace) => trace.phase === "send" && trace.detail?.kind === "resolve")).toBe(true);
    } finally {
      ws.close();
    }
  });

  it("post-wake root call keeps push and pull IDs aligned and emits resolve", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      expect(await root.square(8)).toBe(64);

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      expect(await withTimeout(root.square(12), 1500, "post-wake root.square trace probe")).toBe(144);

      const diagnostics = await getResumeDiagnostics();
      const traces = diagnostics.sessions.flatMap((session) => session.traces ?? []);
      console.log("[post-wake root call traces]", JSON.stringify(traces, null, 2));
      expect(traces.some((trace) => trace.phase === "receive.incoming")).toBe(true);
      expect(traces.some((trace) => trace.phase === "receive")).toBe(true);
      expect(traces.some((trace) => trace.phase === "readLoop.push")).toBe(true);
      const postWakePushes = traces.filter((trace) => trace.phase === "readLoop.push").map((trace) => trace.detail?.exportId);
      const postWakePulls = traces.filter((trace) => trace.phase === "readLoop.pull").map((trace) => trace.detail?.exportId);
      expect(postWakePushes.length).toBeGreaterThan(0);
      expect(postWakePushes[postWakePushes.length - 1]).toBe(postWakePulls[postWakePulls.length - 1]);
      expect(traces.some((trace) => trace.phase === "send" && trace.detail?.kind === "resolve")).toBe(true);
      expect(traces.some((trace) => trace.phase === "send" && trace.detail?.kind === "reject")).toBe(false);
    } finally {
      ws.close();
    }
  });

  it("root stub keeps working after hibernation", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      expect(await root.square(3)).toBe(9);

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      expect(await withTimeout(root.square(5))).toBe(25);
    } finally {
      ws.close();
    }
  });

  it("child stub keeps working after hibernation", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      const key = uniqueKey("hib-child");
      const counter = await root.getDurableCounter(key);
      expect(await counter.increment(5)).toBe(5);

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      expect(await withTimeout(counter.increment(3))).toBe(8);
    } finally {
      ws.close();
    }
  });

  it("explicitly reuses the exact same held child stub after ~15s of hibernation idle time", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      const key = uniqueKey("same-stub-after-wake");
      const counter = await root.getDurableCounter(key);
      const beforeClientRef = __experimental_debugRpcReference(counter);
      expect(await counter.increment(4)).toBe(4);

      const beforeDiagnostics = await getResumeDiagnostics();
      const beforeExport = findDurableCounterExport(beforeDiagnostics, key);
      expect(beforeExport).toBeDefined();

      const idBefore = await root.getInstanceId();
      const idAfter = await waitForHibernation(idBefore);

      const afterWakeDiagnostics = await getResumeDiagnostics();
      const restoredExport = findDurableCounterExport(afterWakeDiagnostics, key);
      const afterClientRef = __experimental_debugRpcReference(counter);

      logSideBySide(
          "same-held-stub comparison before call after wake",
          "client held counter ref",
          {
            before: beforeClientRef,
            afterWakeBeforeCall: afterClientRef,
          },
          "server durable export",
          {
            before: beforeExport,
            afterWakeBeforeCall: restoredExport,
            instanceIdBefore: idBefore,
            instanceIdAfter: idAfter,
          });

      expect(await withTimeout(counter.increment(3), 15000, "same held stub increment after ~15s"))
          .toBe(7);
    } finally {
      ws.close();
    }
  });

  it("reacquires a durable counter after hibernation", { timeout: 30_000 }, async () => {
    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      const key = uniqueKey("reacquire");
      const counter = await root.getDurableCounter(key);
      expect(await counter.increment(100)).toBe(100);

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      const counter2 = await withTimeout(root.getDurableCounter(key));
      expect(await withTimeout(counter2.getValue())).toBe(100);
      expect(await withTimeout(counter2.increment(1))).toBe(101);
    } finally {
      ws.close();
    }
  });

  it("holding a client-minted callback stub in the hub does not prevent hub hibernation", { timeout: 30_000 }, async () => {
    class ClientCallback extends RpcTarget {
      notifications: string[] = [];

      notify(message: string) {
        this.notifications.push(message);
        return { ok: true, count: this.notifications.length };
      }
    }

    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      const callback = new RpcStub(new ClientCallback());
      const callbackName = uniqueKey("client-callback");

      expect(await root.storeClientCallback(callbackName, callback)).toBe(1);
      expect(await root.getStoredClientCallbackCount()).toBe(1);

      const beforeDiagnostics = await getResumeDiagnostics();
      expect(beforeDiagnostics.counters.clientCallbackCount).toBe(1);

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      const afterDiagnostics = await getResumeDiagnostics();
      expect(afterDiagnostics.counters.restoreAttempts).toBeGreaterThan(0);
      expect(afterDiagnostics.counters.restoreSuccesses).toBeGreaterThan(0);
    } finally {
      ws.close();
    }
  });

  it("stored client callback survives hibernation and can be invoked after wake", { timeout: 30_000 }, async () => {
    class ClientCallback extends RpcTarget {
      notifications: string[] = [];

      notify(message: string) {
        this.notifications.push(message);
        return { ok: true, count: this.notifications.length };
      }
    }

    const ws = await connectWebSocket();
    try {
      const root = newWebSocketRpcSession<any>(ws as any);
      const callbackTarget = new ClientCallback();
      const callback = new RpcStub(callbackTarget);
      const callbackName = uniqueKey("client-callback-survive");

      expect(await root.storeClientCallback(callbackName, callback)).toBe(1);
      expect(await root.getStoredClientCallbackCount()).toBe(1);

      const idBefore = await root.getInstanceId();
      await waitForHibernation(idBefore);

      expect(await root.getStoredClientCallbackCount()).toBe(1);
      expect(await withTimeout(root.invokeStoredClientCallback(callbackName, "after-wake"))).toEqual({
        ok: true,
        count: 1,
      });
      expect(callbackTarget.notifications).toEqual(["after-wake"]);
    } finally {
      ws.close();
    }
  });
});
