import { afterEach, describe, expect, it, vi } from "vitest";

import { SharedWorkerClient } from "../hosts/shared-worker-client.js";
import type { PortEvent, PortRequest } from "../hosts/worker-protocol.js";

class FakePort {
  sent: PortRequest[] = [];
  onmessage: ((ev: MessageEvent<PortEvent>) => void) | null = null;
  closed = false;
  postMessage(data: PortRequest): void {
    this.sent.push(data);
  }
  start(): void {}
  close(): void {
    this.closed = true;
  }
  /** 模拟 worker → 页面 */
  emit(data: PortEvent): void {
    this.onmessage?.({ data } as MessageEvent<PortEvent>);
  }
}

class FakeSharedWorker {
  static lastPort: FakePort | null = null;
  readonly port = new FakePort();
  constructor() {
    FakeSharedWorker.lastPort = this.port;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeClient(): { client: SharedWorkerClient; port: FakePort } {
  vi.stubGlobal("SharedWorker", FakeSharedWorker);
  const client = new SharedWorkerClient({ url: "http://localhost:8080", workerUrl: "worker.js", token: "T1" });
  const connectPromise = client.connect();
  const port = FakeSharedWorker.lastPort!;
  port.emit({ kind: "state", state: "connected" });
  return { client, port, connectDone: connectPromise } as never;
}

describe("SharedWorkerClient（页面 stub）", () => {
  it("connect 发送 init（带 url/token），状态跟随 worker 广播", async () => {
    const { client, port, connectDone } = makeClient() as unknown as {
      client: SharedWorkerClient;
      port: FakePort;
      connectDone: Promise<void>;
    };
    await connectDone;
    expect(port.sent[0]).toEqual({ kind: "init", url: "http://localhost:8080", token: "T1" });
    expect(client.state).toBe("connected");
    client.disconnect();
  });

  it("订阅转发、事件回放给 handler、退订转发", async () => {
    const { client, port } = makeClient() as unknown as { client: SharedWorkerClient; port: FakePort };
    const seen: unknown[] = [];
    const sub = client.subscribe("metrics.cpu", (payload) => seen.push(payload));

    const subMsg = port.sent.find((m) => m.kind === "sub") as Extract<PortRequest, { kind: "sub" }>;
    expect(subMsg.topic).toBe("metrics.cpu");

    port.emit({ kind: "event", subId: subMsg.subId, topic: "metrics.cpu", payload: { value: 5 } });
    expect(seen).toEqual([{ value: 5 }]);

    await sub.unsubscribe();
    expect(port.sent.some((m) => m.kind === "unsub")).toBe(true);
    client.disconnect();
  });

  it("请求经 worker 代答并按 reqId 对回", async () => {
    const { client, port } = makeClient() as unknown as { client: SharedWorkerClient; port: FakePort };
    const promise = client.request("echo", { x: 2 });
    const reqMsg = port.sent.find((m) => m.kind === "req") as Extract<PortRequest, { kind: "req" }>;
    expect(reqMsg.topic).toBe("echo");
    port.emit({ kind: "res", reqId: reqMsg.reqId, ok: true, payload: { x: 2 } });
    await expect(promise).resolves.toEqual({ x: 2 });
    client.disconnect();
  });

  it("connect 前订阅会在连接时补发给 worker", async () => {
    vi.stubGlobal("SharedWorker", FakeSharedWorker);
    const client = new SharedWorkerClient({ url: "http://localhost:8080", workerUrl: "worker.js" });
    const seen: unknown[] = [];
    client.subscribe("metrics.mem", (payload) => seen.push(payload)); // 先订阅，此时还没有 port
    const done = client.connect();
    const port = FakeSharedWorker.lastPort!;
    expect(port.sent[0]?.kind).toBe("init");
    const subMsg = port.sent.find((m) => m.kind === "sub") as Extract<PortRequest, { kind: "sub" }>;
    expect(subMsg.topic).toBe("metrics.mem");
    port.emit({ kind: "state", state: "connected" });
    await done;
    port.emit({ kind: "event", subId: subMsg.subId, topic: "metrics.mem", payload: { value: 9 } });
    expect(seen).toEqual([{ value: 9 }]);
    client.disconnect();
  });

  it("传入预构造 worker 时不再自行构造 SharedWorker", async () => {
    vi.stubGlobal(
      "SharedWorker",
      class {
        constructor() {
          throw new Error("不应被构造");
        }
      },
    );
    const fake = new FakeSharedWorker();
    const client = new SharedWorkerClient({
      url: "http://localhost:8080",
      worker: fake as unknown as SharedWorker,
    });
    const done = client.connect();
    fake.port.emit({ kind: "state", state: "connected" });
    await expect(done).resolves.toBeUndefined();
    expect(client.state).toBe("connected");
    client.disconnect();
  });

  it("disconnect 发送 bye 并关 port", () => {
    const { client, port } = makeClient() as unknown as { client: SharedWorkerClient; port: FakePort };
    client.disconnect();
    expect(port.sent.some((m) => m.kind === "bye")).toBe(true);
    expect(port.closed).toBe(true);
    expect(client.state).toBe("closed");
  });
});
