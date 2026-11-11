// @vitest-environment jsdom
import { createApp, defineComponent, h } from "vue";
import { describe, expect, it, vi } from "vitest";

import type { IBaseStationClient } from "@basestation/client";
import type { Message } from "@basestation/protocol";

import { createBaseStationPlugin, useBaseStationState, useSubscription } from "../index.js";

function makeMockClient() {
  const handlers = new Map<string, (payload: unknown, msg: Message) => void>();
  const raw = {
    state: "connected",
    transportKind: "ws",
    sessionId: "sess-1",
    onStateChange: () => () => {},
    onTraffic: () => () => {},
    forceDegrade: () => {},
    request: vi.fn(async () => ({})),
    subscribe: vi.fn((topic: string, handler: (payload: unknown, msg: Message) => void) => {
      handlers.set(topic, handler);
      return {
        topic,
        unsubscribe: async () => {
          handlers.delete(topic);
        },
      };
    }),
    unsubscribe: vi.fn(async () => {}),
    once: vi.fn(async () => ({}) as Promise<Message>),
  };
  return { client: raw as unknown as IBaseStationClient, handlers, raw };
}

describe("Vue 绑定", () => {
  it("useSubscription 挂载订阅、收到消息、卸载退订", async () => {
    const { client, handlers, raw } = makeMockClient();
    const received: unknown[] = [];

    const Probe = defineComponent({
      setup() {
        const state = useBaseStationState();
        useSubscription<{ value: number }>("metrics.cpu", (payload) => received.push(payload));
        return () => h("span", state.value);
      },
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp(Probe);
    app.use(createBaseStationPlugin({ client }));
    app.mount(container);

    expect(container.textContent).toBe("connected");
    expect(raw.subscribe).toHaveBeenCalledWith("metrics.cpu", expect.any(Function));

    handlers.get("metrics.cpu")?.({ value: 9 }, { type: "event", topic: "metrics.cpu" } as Message);
    expect(received).toEqual([{ value: 9 }]);

    app.unmount();
    expect(handlers.has("metrics.cpu")).toBe(false);
  });
});
