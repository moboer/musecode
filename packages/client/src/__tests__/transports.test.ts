import { describe, expect, it, vi } from "vitest";

import { createMessage } from "@basestation/protocol";

import { PollingTransport } from "../transports/polling.js";
import { WebSocketTransport } from "../transports/websocket.js";

describe("令牌传递（服务端 jwt 模式的第 2 关）", () => {
  it("轮询：建会话与拉取都带 Authorization 头", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchStub = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      if (String(url).endsWith("/api/sessions")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ sessionId: "s1", resumed: false, heartbeatIntervalMs: 15000, pollWaitMs: 50 }),
        } as Response;
      }
      await new Promise((resolve) => setTimeout(resolve, 10)); // 真实长轮询会挂起，替身用小延迟模拟，避免空转
      return { ok: true, status: 200, json: async () => ({ messages: [], timeout: true }) } as Response;
    });

    const transport = new PollingTransport(
      "http://localhost:8080",
      null,
      50,
      fetchStub as unknown as typeof fetch,
      undefined,
      () => "TOKEN123",
    );
    const info = await transport.start();
    expect(info.sessionId).toBe("s1");
    // 等轮询循环至少发出一次 GET
    await new Promise((resolve) => setTimeout(resolve, 30));
    transport.stop();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.headers.Authorization).toBe("Bearer TOKEN123");
    }
  });

  it("WS：令牌经 ?token= 传递（浏览器 WS 不能设头）", async () => {
    let seenUrl = "";
    class FakeWebSocket {
      private listeners = new Map<string, ((ev: never) => void)[]>();
      constructor(url: string) {
        seenUrl = url;
        queueMicrotask(() => {
          this.emit("open", {});
          const hello = createMessage("hello", {
            sessionId: "s9",
            payload: { sessionId: "s9", resumed: false, heartbeatIntervalMs: 15000, pollWaitMs: 25000 },
          });
          this.emit("message", { data: JSON.stringify(hello) });
        });
      }
      addEventListener(type: string, cb: (ev: never) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
      }
      removeEventListener(): void {}
      private emit(type: string, ev: unknown): void {
        for (const cb of this.listeners.get(type) ?? []) cb(ev as never);
      }
      send(): void {}
      close(): void {}
    }

    const transport = new WebSocketTransport(
      "http://localhost:8080",
      null,
      FakeWebSocket as unknown as typeof WebSocket,
      undefined,
      () => "TOKEN123",
    );
    const info = await transport.start();
    expect(info.sessionId).toBe("s9");
    expect(seenUrl).toContain("token=TOKEN123");
    transport.stop();
  });

  it("base 带路径前缀时 WS 地址保留前缀（/bs → /bs/ws）", async () => {
    let seenUrl = "";
    class FakeWebSocket {
      private listeners = new Map<string, ((ev: never) => void)[]>();
      constructor(url: string) {
        seenUrl = url;
        queueMicrotask(() => {
          this.emit("open", {});
          const hello = createMessage("hello", {
            sessionId: "s9",
            payload: { sessionId: "s9", resumed: false },
          });
          this.emit("message", { data: JSON.stringify(hello) });
        });
      }
      addEventListener(type: string, cb: (ev: never) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
      }
      removeEventListener(): void {}
      private emit(type: string, ev: unknown): void {
        for (const cb of this.listeners.get(type) ?? []) cb(ev as never);
      }
      send(): void {}
      close(): void {}
    }
    const transport = new WebSocketTransport(
      "http://localhost:8080/bs",
      null,
      FakeWebSocket as unknown as typeof WebSocket,
    );
    const info = await transport.start();
    expect(info.sessionId).toBe("s9");
    expect(seenUrl.startsWith("ws://localhost:8080/bs/ws")).toBe(true);
    transport.stop();
  });

  it("无令牌时不带 token 参数与 Authorization 头（兼容 auth-mode=none）", async () => {
    let seenUrl = "";
    class FakeWebSocket {
      private listeners = new Map<string, ((ev: never) => void)[]>();
      constructor(url: string) {
        seenUrl = url;
        queueMicrotask(() => {
          this.emit("open", {});
          const hello = createMessage("hello", {
            sessionId: "s9",
            payload: { sessionId: "s9", resumed: false },
          });
          this.emit("message", { data: JSON.stringify(hello) });
        });
      }
      addEventListener(type: string, cb: (ev: never) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
      }
      removeEventListener(): void {}
      private emit(type: string, ev: unknown): void {
        for (const cb of this.listeners.get(type) ?? []) cb(ev as never);
      }
      send(): void {}
      close(): void {}
    }
    const transport = new WebSocketTransport("http://localhost:8080", null, FakeWebSocket as unknown as typeof WebSocket);
    await transport.start();
    expect(seenUrl).not.toContain("token=");
    transport.stop();
  });
});
