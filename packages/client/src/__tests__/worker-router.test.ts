import { describe, expect, it, vi } from "vitest";

import type { Message } from "@basestation/protocol";

import { WorkerRouter } from "../hosts/worker-router.js";
import type { PortEvent, RouterClient } from "../hosts/worker-router.js";
import { Subscription } from "../types.js";

class FakePort {
  events: PortEvent[] = [];
  postMessage(data: PortEvent): void {
    this.events.push(data);
  }
  eventsOf(kind: string): PortEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }
}

function makeRouter() {
  let now = 1000;
  const topicHandlers = new Map<string, (payload: unknown, msg: Message) => void>();
  const client = {
    state: "connected",
    subscribe: vi.fn((topic: string, handler: (payload: unknown, msg: Message) => void) => {
      topicHandlers.set(topic, handler);
      return new Subscription(`real-${topic}`, topic, async () => {
        topicHandlers.delete(topic);
      });
    }),
    request: vi.fn(async (topic: string, payload: unknown) => ({ echoed: payload, topic })),
    onStateChange: () => () => {},
  } as unknown as RouterClient & {
    subscribe: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
  };
  const router = new WorkerRouter({
    clientFactory: () => client,
    staleMs: 15000,
    now: () => now,
  });
  const tab = (): { id: number; port: FakePort } => {
    const port = new FakePort();
    const id = router.attach(port);
    router.handleMessage(id, { kind: "init", url: "http://localhost:8080" });
    return { id, port };
  };
  return {
    router,
    client,
    topicHandlers,
    tab,
    setNow: (v: number) => {
      now = v;
    },
  };
}

describe("WorkerRouter（多标签单连接）", () => {
  it("两个标签订同一主题只产生一份真实订阅，事件扇出给两者", () => {
    const { router, client, topicHandlers, tab } = makeRouter();
    const a = tab();
    const b = tab();
    router.handleMessage(a.id, { kind: "sub", subId: "a1", topic: "metrics.cpu" });
    router.handleMessage(b.id, { kind: "sub", subId: "b1", topic: "metrics.cpu" });

    expect(client.subscribe).toHaveBeenCalledTimes(1);
    expect(router.topicCount).toBe(1);

    topicHandlers.get("metrics.cpu")?.({ value: 1 }, {} as Message);
    expect(a.port.eventsOf("event")).toEqual([{ kind: "event", subId: "a1", topic: "metrics.cpu", payload: { value: 1 } }]);
    expect(b.port.eventsOf("event")).toEqual([{ kind: "event", subId: "b1", topic: "metrics.cpu", payload: { value: 1 } }]);
  });

  it("一个标签退订不影响另一个；最后一个退订才释放真实订阅", () => {
    const { router, topicHandlers, tab } = makeRouter();
    const a = tab();
    const b = tab();
    router.handleMessage(a.id, { kind: "sub", subId: "a1", topic: "metrics.cpu" });
    router.handleMessage(b.id, { kind: "sub", subId: "b1", topic: "metrics.cpu" });

    router.handleMessage(a.id, { kind: "unsub", subId: "a1" });
    expect(router.topicCount).toBe(1);
    topicHandlers.get("metrics.cpu")?.({ value: 2 }, {} as Message);
    expect(a.port.eventsOf("event")).toHaveLength(0);
    expect(b.port.eventsOf("event")).toHaveLength(1);

    router.handleMessage(b.id, { kind: "unsub", subId: "b1" });
    expect(router.topicCount).toBe(0);
    expect(topicHandlers.has("metrics.cpu")).toBe(false);
  });

  it("标签 bye 后订阅被清理；请求只回给发起标签", async () => {
    const { router, tab } = makeRouter();
    const a = tab();
    const b = tab();
    router.handleMessage(a.id, { kind: "sub", subId: "a1", topic: "news.notice" });
    expect(router.topicCount).toBe(1);

    router.handleMessage(a.id, { kind: "req", reqId: "r1", topic: "echo", payload: { x: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(a.port.eventsOf("res")).toEqual([{ kind: "res", reqId: "r1", ok: true, payload: { echoed: { x: 1 }, topic: "echo" } }]);
    expect(b.port.eventsOf("res")).toHaveLength(0);

    router.handleMessage(a.id, { kind: "bye" });
    expect(router.topicCount).toBe(0);
    expect(router.tabCount).toBe(1);
  });

  it("心跳超时的标签（关页/崩溃）被回收，订阅无残留", () => {
    const { router, tab, setNow } = makeRouter();
    const a = tab();
    router.handleMessage(a.id, { kind: "sub", subId: "a1", topic: "metrics.mem" });
    expect(router.topicCount).toBe(1);

    setNow(1000 + 15001);
    expect(router.pruneStale()).toBe(1);
    expect(router.topicCount).toBe(0);
    expect(router.tabCount).toBe(0);
  });
});
