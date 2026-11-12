import { isMessage, MessageType } from "@basestation/protocol";
import type { Message } from "@basestation/protocol";

import { ConnectionError } from "../errors.js";
import { browserHost } from "../host.js";
import type { CoreHost } from "../host.js";
import type { CloseReason, TokenProvider, Transport, TransportInfo } from "../types.js";

const HELLO_TIMEOUT_MS = 3000;

/**
 * WebSocket 传输：只负责建连、搬运帧与关闭，不做重连与降级。
 * 连接成功后服务端会立即下发 hello，其中带会话续接参数。
 */
export class WebSocketTransport implements Transport {
  readonly kind = "ws" as const;

  private ws: WebSocket | null = null;
  private buffer: Message[] = [];
  private messageCb: ((msg: Message) => void) | null = null;
  private closeCb: ((reason: CloseReason) => void) | null = null;
  private helloResolve: ((info: TransportInfo) => void) | null = null;
  private helloReject: ((err: Error) => void) | null = null;
  private helloInfo: TransportInfo | null = null;
  private helloTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private sessionId: string | null;

  constructor(
    private readonly url: string,
    sessionId: string | null,
    private readonly WebSocketImpl: typeof WebSocket = browserHost.WebSocket,
    private readonly host: CoreHost = browserHost,
    private readonly tokenProvider?: TokenProvider,
  ) {
    this.sessionId = sessionId;
  }

  onMessage(cb: (msg: Message) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (reason: CloseReason) => void): void {
    this.closeCb = cb;
  }

  start(): Promise<TransportInfo> {
    return new Promise<TransportInfo>((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;

      const target = toWsUrl(this.url, this.sessionId, this.tokenProvider?.() ?? null);
      let socket: WebSocket;
      try {
        socket = new this.WebSocketImpl(target);
      } catch (err) {
        this.helloResolve = null;
        this.helloReject = null;
        reject(new ConnectionError(`failed to open websocket to ${target}`, { cause: err }));
        return;
      }
      this.ws = socket;

      this.helloTimeout = this.host.setTimeout(() => {
        if (this.helloInfo) return;
        this.stopped = true;
        this.failHello(new ConnectionError(`websocket hello timeout after ${HELLO_TIMEOUT_MS}ms`));
        try {
          socket.close();
        } catch {
          // 忽略关闭阶段的异常
        }
      }, HELLO_TIMEOUT_MS);

      socket.addEventListener("message", (event) => this.handleFrame(event.data));
      socket.addEventListener("close", () => this.handleClose(socket));
      socket.addEventListener("error", () => {
        // 浏览器随后会触发 close，这里不重复处理。
      });
    });
  }

  send(messages: Message[]): void {
    if (!this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      this.buffer.push(...messages);
      return;
    }
    for (const msg of messages) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  stop(): void {
    this.stopped = true;
    this.clearHelloTimeout();
    const socket = this.ws;
    this.ws = null;
    this.buffer = [];
    if (socket) {
      try {
        socket.close();
      } catch {
        // 忽略
      }
    }
  }

  private handleFrame(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isMessage(parsed)) return;

    if (parsed.type === MessageType.Hello) {
      this.handleHello(parsed);
      return;
    }
    this.messageCb?.(parsed);
  }

  private handleHello(msg: Message): void {
    if (this.helloInfo) return;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const info: TransportInfo = {
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : (this.sessionId ?? ""),
      heartbeatIntervalMs: typeof payload.heartbeatIntervalMs === "number" ? payload.heartbeatIntervalMs : 15000,
      pollWaitMs: typeof payload.pollWaitMs === "number" ? payload.pollWaitMs : 25000,
      resumed: payload.resumed === true,
    };
    this.helloInfo = info;
    this.sessionId = info.sessionId;
    this.clearHelloTimeout();

    const resolve = this.helloResolve;
    this.helloResolve = null;
    this.helloReject = null;
    this.flushBuffer();
    resolve?.(info);
  }

  private handleClose(socket: WebSocket): void {
    if (this.ws !== socket) return;
    this.ws = null;
    this.clearHelloTimeout();

    if (!this.helloInfo) {
      this.failHello(new ConnectionError("websocket closed before hello"));
      return;
    }
    if (this.stopped) return;
    this.stopped = true;
    this.closeCb?.("network");
  }

  private failHello(err: Error): void {
    this.clearHelloTimeout();
    const reject = this.helloReject;
    this.helloResolve = null;
    this.helloReject = null;
    reject?.(err);
  }

  private clearHelloTimeout(): void {
    if (this.helloTimeout) {
      this.host.clearTimeout(this.helloTimeout);
      this.helloTimeout = null;
    }
  }

  private flushBuffer(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    this.send(batch);
  }
}

function toWsUrl(baseUrl: string, sessionId: string | null, token: string | null): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    url = new URL(baseUrl, "http://localhost:8080");
  }
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  // 在 base 的路径后追加 /ws（base 可能带宿主前缀，如 http://host/bs → ws://host/bs/ws）
  const basePath = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${basePath}/ws`;
  // 浏览器 WebSocket 不能设请求头，令牌经 query 传递（服务端第 2 关校验）。
  const params = new URLSearchParams();
  if (sessionId) params.set("sessionId", sessionId);
  if (token) params.set("token", token);
  url.search = params.toString() ? `?${params.toString()}` : "";
  url.hash = "";
  return url.toString();
}
