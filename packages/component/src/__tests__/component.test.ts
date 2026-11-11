// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Message } from "@basestation/protocol";

import { componentInternals, defineBaseStationComponents } from "../index.js";
import type { ComponentClient } from "../index.js";

class MockClient implements ComponentClient {
  state = "connected" as ComponentClient["state"];
  handlers = new Map<string, (payload: unknown, msg: Message) => void>();
  disconnected = false;

  async connect(): Promise<void> {}
  disconnect(): void {
    this.disconnected = true;
  }
  subscribe<T>(topic: string, handler: (payload: T, msg: Message<T>) => void): { unsubscribe: () => Promise<void> } {
    this.handlers.set(topic, handler as (payload: unknown, msg: Message) => void);
    return {
      unsubscribe: async () => {
        this.handlers.delete(topic);
      },
    };
  }
  onStateChange(): () => void {
    return () => {};
  }
  emit(topic: string, payload: unknown): void {
    this.handlers.get(topic)?.(payload, { type: "event", topic, payload } as Message);
  }
}

let mock: MockClient;

beforeAll(() => {
  mock = new MockClient();
  componentInternals.clientFactory = () => mock;
  defineBaseStationComponents();
});

describe("Web Component 标准组件", () => {
  it("<bs-subscribe> 收到消息后派发 bs-message 并在 show 时渲染文本", async () => {
    document.body.innerHTML = `
      <base-station url="http://localhost:8080">
        <bs-subscribe topic="metrics.cpu" show></bs-subscribe>
      </base-station>`;
    const el = document.querySelector("bs-subscribe")!;
    // 等 attach 的微任务完成
    await new Promise((resolve) => setTimeout(resolve, 0));

    const seen: unknown[] = [];
    el.addEventListener("bs-message", (ev) => seen.push((ev as CustomEvent).detail));

    mock.emit("metrics.cpu", { value: 42, unit: "percent" });

    expect(seen).toHaveLength(1);
    expect((seen[0] as { topic: string }).topic).toBe("metrics.cpu");
    expect((seen[0] as { payload: { value: number } }).payload.value).toBe(42);
    expect(el.textContent).toContain('"value":42');
  });

  it("卸载 <base-station> 会断开客户端", async () => {
    const host = document.querySelector("base-station")!;
    host.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mock.disconnected).toBe(true);
  });

  it("脱离 <base-station> 的 <bs-subscribe> 派发 bs-error", async () => {
    const orphan = document.createElement("bs-subscribe");
    orphan.setAttribute("topic", "metrics.cpu");
    const onError = vi.fn();
    orphan.addEventListener("bs-error", onError);
    document.body.appendChild(orphan);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalled();
    orphan.remove();
  });
});
