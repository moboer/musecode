// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { IBaseStationClient } from "@basestation/client";
import type { Message } from "@basestation/protocol";

import { BaseStationProvider, useBaseStationState, useSubscription } from "../index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeMockClient() {
  const handlers = new Map<string, (payload: unknown, msg: Message) => void>();
  const client = {
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
  return { client: client as unknown as IBaseStationClient, handlers, raw: client };
}

describe("React 绑定", () => {
  it("useSubscription 挂载订阅、收到消息、卸载退订", async () => {
    const { client, handlers, raw } = makeMockClient();
    const received: unknown[] = [];

    function Probe(): React.ReactNode {
      const state = useBaseStationState();
      useSubscription<{ value: number }>("metrics.cpu", (payload) => received.push(payload));
      return <span>{state}</span>;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <BaseStationProvider client={client}>
          <Probe />
        </BaseStationProvider>,
      );
    });

    expect(container.textContent).toBe("connected");
    expect(raw.subscribe).toHaveBeenCalledWith("metrics.cpu", expect.any(Function));

    handlers.get("metrics.cpu")?.({ value: 7 }, { type: "event", topic: "metrics.cpu" } as Message);
    expect(received).toEqual([{ value: 7 }]);

    await act(async () => root.unmount());
    expect(handlers.has("metrics.cpu")).toBe(false);
  });
});
