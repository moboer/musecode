import { describe, expect, it, vi } from "vitest";

import { createMessage } from "@basestation/protocol";
import type { Message } from "@basestation/protocol";

import { MessageBus } from "../message-bus.js";

function event(topic: string, payload: unknown = {}): Message {
  return createMessage("event", { topic, payload });
}

describe("MessageBus", () => {
  it("只把消息投递给匹配主题的监听器", () => {
    const bus = new MessageBus(() => {});
    const cpu = vi.fn();
    const news = vi.fn();

    bus.add({ id: "1", topic: "metrics.cpu", handler: cpu });
    bus.add({ id: "2", topic: "news.notice", handler: news });

    bus.dispatch(event("metrics.cpu", { value: 12 }));

    expect(cpu).toHaveBeenCalledTimes(1);
    expect(news).not.toHaveBeenCalled();
  });

  it("通配符订阅能命中子主题", () => {
    const bus = new MessageBus(() => {});
    const wildcard = vi.fn();
    bus.add({ id: "1", topic: "metrics.*", handler: wildcard });

    bus.dispatch(event("metrics.cpu"));
    bus.dispatch(event("metrics.mem"));
    bus.dispatch(event("news.notice"));

    expect(wildcard).toHaveBeenCalledTimes(2);
  });

  it("取消单个订阅不影响同主题的其他监听器", () => {
    const bus = new MessageBus(() => {});
    const first = vi.fn();
    const second = vi.fn();
    bus.add({ id: "1", topic: "metrics.cpu", handler: first });
    bus.add({ id: "2", topic: "metrics.cpu", handler: second });

    expect(bus.remove("1")).toBe(true);
    bus.dispatch(event("metrics.cpu"));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("监听器抛异常不会影响其他监听器", () => {
    const report = vi.fn();
    const bus = new MessageBus(report);
    const boom = vi.fn(() => {
      throw new Error("handler exploded");
    });
    const healthy = vi.fn();

    bus.add({ id: "1", topic: "metrics.cpu", handler: boom });
    bus.add({ id: "2", topic: "metrics.cpu", handler: healthy });

    expect(() => bus.dispatch(event("metrics.cpu"))).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("filter 可在同一主题内做二级隔离", () => {
    const bus = new MessageBus(() => {});
    const mine = vi.fn();
    bus.add({
      id: "1",
      topic: "order.updated",
      filter: (payload) => (payload as { orderId: string }).orderId === "A",
      handler: mine,
    });

    bus.dispatch(event("order.updated", { orderId: "B" }));
    expect(mine).not.toHaveBeenCalled();

    bus.dispatch(event("order.updated", { orderId: "A" }));
    expect(mine).toHaveBeenCalledTimes(1);
  });

  it("filter 抛异常时走 onError 且不向外冒泡", () => {
    const bus = new MessageBus(() => {});
    const onError = vi.fn();
    bus.add({
      id: "1",
      topic: "metrics.cpu",
      filter: () => {
        throw new Error("bad filter");
      },
      handler: vi.fn(),
      onError,
    });

    bus.dispatch(event("metrics.cpu"));
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("hasTopic 与 topics 反映去重后的主题集合", () => {
    const bus = new MessageBus(() => {});
    bus.add({ id: "1", topic: "metrics.cpu", handler: vi.fn() });
    bus.add({ id: "2", topic: "metrics.cpu", handler: vi.fn() });
    bus.add({ id: "3", topic: "news.notice", handler: vi.fn() });

    expect(bus.hasTopic("metrics.cpu")).toBe(true);
    expect(bus.topics().sort()).toEqual(["metrics.cpu", "news.notice"]);
  });
});
