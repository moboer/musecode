import { afterEach, describe, expect, it, vi } from "vitest";

import { createMessage, ErrorCode, newId } from "@basestation/protocol";
import type { Message, MessageType } from "@basestation/protocol";

import { BaseStationClient } from "../client.js";
import { RequestError, TimeoutError } from "../errors.js";
import { getBaseStation, initBaseStation, isBaseStationReady } from "../singleton.js";
import type { CloseReason, Transport, TransportFactory, TransportInfo } from "../types.js";

class MockTransport implements Transport {
  readonly kind: "ws" | "poll";
  sent: Message[] = [];
  failStart: Error | null = null;
  started = false;

  private messageCb: ((msg: Message) => void) | null = null;
  private closeCb: ((reason: CloseReason) => void) | null = null;

  constructor(kind: "ws" | "poll") {
    this.kind = kind;
  }

  async start(): Promise<TransportInfo> {
    if (this.failStart) throw this.failStart;
    this.started = true;
    return { sessionId: `sess-${this.kind}`, heartbeatIntervalMs: 60000, pollWaitMs: 25000, resumed: false };
  }

  stop(): void {
    this.started = false;
  }

  send(messages: Message[]): void {
    this.sent.push(...messages);
  }

  onMessage(cb: (msg: Message) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (reason: CloseReason) => void): void {
    this.closeCb = cb;
  }

  receive(msg: Message): void {
    this.messageCb?.(msg);
  }

  simulateClose(reason: CloseReason): void {
    this.started = false;
    this.closeCb?.(reason);
  }

  lastOf(type: MessageType): Message | undefined {
    return [...this.sent].reverse().find((msg) => msg.type === type);
  }

  countOf(type: MessageType): number {
    return this.sent.filter((msg) => msg.type === type).length;
  }
}

class MockFactory implements TransportFactory {
  readonly wsList: MockTransport[] = [];
  readonly pollList: MockTransport[] = [];
  wsStartError: Error | null = null;
  pollStartError: Error | null = null;

  createWebSocket(): Transport {
    const transport = new MockTransport("ws");
    transport.failStart = this.wsStartError;
    this.wsList.push(transport);
    return transport;
  }

  createPolling(): Transport {
    const transport = new MockTransport("poll");
    transport.failStart = this.pollStartError;
    this.pollList.push(transport);
    return transport;
  }

  get ws(): MockTransport {
    const last = this.wsList.at(-1);
    if (!last) throw new Error("no ws transport created");
    return last;
  }

  get poll(): MockTransport {
    const last = this.pollList.at(-1);
    if (!last) throw new Error("no poll transport created");
    return last;
  }
}

function frame(init: Partial<Message> & { type: MessageType }): Message {
  return {
    id: init.id ?? newId(),
    ts: Date.now(),
    payload: {},
    error: null,
    ...init,
  } as Message;
}

const clients: BaseStationClient[] = [];

function makeClient(factory: MockFactory, overrides: Record<string, unknown> = {}): BaseStationClient {
  const client = new BaseStationClient({
    url: "http://test.local",
    transportFactory: factory,
    sessionStorageKey: false,
    heartbeatIntervalMs: 60000,
    heartbeatTimeoutMs: 60000,
    wsUpgradeProbeMs: 60000,
    requestTimeoutMs: 100,
    reconnect: { baseDelayMs: 10, maxDelayMs: 20, factor: 2, jitterRatio: 0 },
    ...overrides,
  });
  clients.push(client);
  return client;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  while (clients.length > 0) {
    const client = clients.pop();
    await client?.disconnect();
  }
});

describe("BaseStationClient 请求-响应", () => {
  it("收到 replyTo 匹配的响应后解析 payload", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory);
    await client.connect();
    expect(client.transportKind).toBe("ws");

    const promise = client.request<{ echoed: number }>("echo", { n: 1 });
    const request = factory.ws.lastOf("req");
    expect(request?.topic).toBe("echo");

    factory.ws.receive(frame({ type: "res", replyTo: request?.id, payload: { echoed: 1 } }));
    await expect(promise).resolves.toEqual({ echoed: 1 });
  });

  it("服务端 error 字段非空时抛出 RequestError 且不可重试者不重发", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory);
    await client.connect();

    const promise = client.request("boom", {}, { retries: 3, timeoutMs: 60 });
    const request = factory.ws.lastOf("req");

    factory.ws.receive(
      frame({
        type: "res",
        replyTo: request?.id,
        error: { code: ErrorCode.HandlerError, message: "boom", retryable: false },
      }),
    );

    await expect(promise).rejects.toBeInstanceOf(RequestError);
    expect(factory.ws.countOf("req")).toBe(1);
  });

  it("超时后按 retries 用同一 id 重发，最终抛 TimeoutError", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory);
    await client.connect();

    const promise = client.request("slow.echo", {}, { retries: 1, retryDelayMs: 5, timeoutMs: 20 });
    await expect(promise).rejects.toBeInstanceOf(TimeoutError);

    expect(factory.ws.countOf("req")).toBe(2);
    const ids = factory.ws.sent.filter((msg) => msg.type === "req").map((msg) => msg.id);
    expect(new Set(ids).size).toBe(1);
  });

  it("断开连接会让挂起请求失败而不是永久悬挂", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory, { requestTimeoutMs: 5000 });
    await client.connect();

    const promise = client.request("never.answers");
    await client.disconnect();
    await expect(promise).rejects.toBeTruthy();
  });
});

describe("BaseStationClient 订阅与隔离", () => {
  it("按主题投递，取消订阅后停止接收且不影响同主题其他监听器", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory);
    await client.connect();

    const cpuA = vi.fn();
    const cpuB = vi.fn();
    const news = vi.fn();

    const subA = client.subscribe("metrics.cpu", cpuA);
    client.subscribe("metrics.cpu", cpuB);
    client.subscribe("news.notice", news);

    // 同一主题的第二个监听器不再重复发送 sub 帧
    expect(factory.ws.sent.filter((msg) => msg.type === "sub" && msg.topic === "metrics.cpu")).toHaveLength(1);
    expect(factory.ws.sent.filter((msg) => msg.type === "sub" && msg.topic === "news.notice")).toHaveLength(1);

    factory.ws.receive(frame({ type: "event", topic: "metrics.cpu", seq: 1, payload: { value: 10 } }));
    expect(cpuA).toHaveBeenCalledTimes(1);
    expect(cpuB).toHaveBeenCalledTimes(1);
    expect(news).not.toHaveBeenCalled();

    await subA.unsubscribe();
    // 仍有一个监听器，不应发送 unsub
    expect(factory.ws.countOf("unsub")).toBe(0);

    factory.ws.receive(frame({ type: "event", topic: "metrics.cpu", seq: 2, payload: { value: 11 } }));
    expect(cpuA).toHaveBeenCalledTimes(1);
    expect(cpuB).toHaveBeenCalledTimes(2);
  });

  it("通配符订阅接收子主题事件", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory);
    await client.connect();

    const wildcard = vi.fn();
    client.subscribe("metrics.*", wildcard);

    factory.ws.receive(frame({ type: "event", topic: "metrics.cpu", seq: 1 }));
    factory.ws.receive(frame({ type: "event", topic: "metrics.mem", seq: 2 }));
    factory.ws.receive(frame({ type: "event", topic: "news.notice", seq: 3 }));

    expect(wildcard).toHaveBeenCalledTimes(2);
  });

  it("按主题批量取消订阅", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory);
    await client.connect();

    client.subscribe("metrics.cpu", vi.fn());
    client.subscribe("metrics.cpu", vi.fn());

    await client.unsubscribe("metrics.cpu");
    expect(factory.ws.lastOf("unsub")?.topic).toBe("metrics.cpu");
  });

  it("once 收到第一条后自动注销", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory);
    await client.connect();

    const promise = client.once<{ noticeId: number }>("news.notice", { timeoutMs: 200 });
    factory.ws.receive(frame({ type: "event", topic: "news.notice", seq: 1, payload: { noticeId: 7 } }));

    await expect(promise).resolves.toMatchObject({ payload: { noticeId: 7 } });
    await waitFor(() => factory.ws.countOf("unsub") === 1);
  });

  it("once 超时后拒绝并清理", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory);
    await client.connect();

    await expect(client.once("news.notice", { timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError);
  });

  it("重复 seq 的帧会被丢弃", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory);
    await client.connect();

    const handler = vi.fn();
    client.subscribe("metrics.cpu", handler);

    const duplicate = frame({ type: "event", topic: "metrics.cpu", seq: 9, payload: { value: 1 } });
    factory.ws.receive(duplicate);
    factory.ws.receive({ ...duplicate, id: newId() });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("seq 跳号时触发 onSeqGap 告警且不中断投递", async () => {
    const factory = new MockFactory();
    const gaps: unknown[] = [];
    const client = makeClient(factory, { onSeqGap: (info: unknown) => gaps.push(info) });
    await client.connect();

    const handler = vi.fn();
    client.subscribe("metrics.cpu", handler);

    factory.ws.receive(frame({ type: "event", topic: "metrics.cpu", seq: 10, payload: { value: 1 } }));
    factory.ws.receive(frame({ type: "event", topic: "metrics.cpu", seq: 13, payload: { value: 2 } }));
    factory.ws.receive(frame({ type: "event", topic: "metrics.cpu", seq: 14, payload: { value: 3 } }));

    expect(handler).toHaveBeenCalledTimes(3);
    expect(gaps).toEqual([{ expected: 11, received: 13, missed: 2 }]);
  });
});

describe("BaseStationClient 单一连接与降级", () => {
  it("WS 启动失败时自动降级到轮询且只保留一个传输", async () => {
    const factory = new MockFactory();
    factory.wsStartError = new Error("ws blocked");
    const client = makeClient(factory);

    await client.connect();

    expect(client.transportKind).toBe("poll");
    expect(client.state).toBe("degraded");
    expect(factory.wsList).toHaveLength(1);
    expect(factory.pollList).toHaveLength(1);
    expect(factory.ws.started).toBe(false);
  });

  it("WS 运行中断开后切到轮询，并重放既有订阅", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory);
    await client.connect();
    client.subscribe("metrics.cpu", vi.fn());
    factory.ws.sent = [];

    factory.ws.simulateClose("network");
    await waitFor(() => client.transportKind === "poll");

    expect(client.state).toBe("degraded");
    expect(factory.ws.started).toBe(false);
    expect(factory.poll.started).toBe(true);
    const replayed = factory.poll.sent.filter((msg) => msg.type === "sub").map((msg) => msg.topic);
    expect(replayed).toContain("metrics.cpu");
  });

  it("轮询也无法启动时进入重连并最终恢复", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory);
    await client.connect();
    factory.ws.sent = [];

    factory.pollStartError = new Error("poll blocked");
    factory.wsStartError = new Error("ws blocked");
    factory.ws.simulateClose("network");

    await waitFor(() => client.state === "reconnecting");

    // 服务恢复后，重连应回到 WS
    factory.pollStartError = null;
    factory.wsStartError = null;
    await waitFor(() => client.transportKind === "ws", 2000);
    expect(client.state).toBe("connected");
  });

  it("重复 connect 不会创建第二条连接", async () => {
    const factory = new MockFactory();
    const client = makeClient(factory);
    await client.connect();
    await client.connect();

    expect(factory.wsList).toHaveLength(1);
  });
});

describe("页面单例", () => {
  it("同 URL 幂等返回同一实例，不同 URL 抛错", () => {
    expect(isBaseStationReady()).toBe(false);

    const first = initBaseStation({ url: "http://single.local", sessionStorageKey: false });
    const second = initBaseStation({ url: "http://single.local", sessionStorageKey: false });
    expect(second).toBe(first);
    expect(getBaseStation()).toBe(first);

    expect(() => initBaseStation({ url: "http://other.local" })).toThrow();
  });
});
