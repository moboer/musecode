import type { Message } from "@basestation/protocol";

import { ConnectionError } from "../errors.js";
import { browserHost } from "../host.js";
import type { CoreHost } from "../host.js";
import type { CloseReason, TokenProvider, Transport, TransportInfo } from "../types.js";

interface PollBody {
  messages?: Message[];
  timeout?: boolean;
  replacedBy?: string;
}

const FLUSH_INTERVAL_MS = 50;

/**
 * HTTP 长轮询传输：出站帧批量 POST，入站帧靠长挂起 GET 拉取。
 * 轮询请求本身即心跳；一旦请求失败即视为连接失效，交由客户端决策。
 */
export class PollingTransport implements Transport {
  readonly kind = "poll" as const;

  private sessionId: string | null;
  private running = false;
  private abort: AbortController | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private queue: Message[] = [];
  private flushing = false;
  private lastSeq = 0;
  private replacedByWS = 0;
  private messageCb: ((msg: Message) => void) | null = null;
  private closeCb: ((reason: CloseReason) => void) | null = null;

  constructor(
    private readonly baseUrl: string,
    sessionId: string | null,
    private pollWaitMs: number,
    private readonly fetchImpl: typeof fetch = browserHost.fetch,
    private readonly host: CoreHost = browserHost,
    private readonly tokenProvider?: TokenProvider,
  ) {
    this.sessionId = sessionId;
  }

  /** 轮询经 Authorization 头带令牌（服务端第 2 关在建会话与每次 send/poll 时校验主体）。 */
  private authHeaders(): Record<string, string> {
    const token = this.tokenProvider?.();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  onMessage(cb: (msg: Message) => void): void {
    this.messageCb = cb;
  }

  onClose(cb: (reason: CloseReason) => void): void {
    this.closeCb = cb;
  }

  async start(): Promise<TransportInfo> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint("/api/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({ sessionId: this.sessionId ?? "" }),
      });
    } catch (err) {
      throw new ConnectionError("failed to create polling session", { cause: err });
    }
    if (!res.ok) {
      throw new ConnectionError(`session create failed: HTTP ${res.status}`);
    }

    const body = (await res.json()) as {
      sessionId?: string;
      resumed?: boolean;
      heartbeatIntervalMs?: number;
      pollWaitMs?: number;
    };
    if (!body.sessionId) {
      throw new ConnectionError("session create returned no sessionId");
    }
    if (typeof body.pollWaitMs === "number" && body.pollWaitMs > 0) {
      this.pollWaitMs = body.pollWaitMs;
    }

    this.sessionId = body.sessionId;
    this.running = true;
    this.lastSeq = 0;
    this.flushTimer = this.host.setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
    void this.pollLoop();

    return {
      sessionId: body.sessionId,
      heartbeatIntervalMs: body.heartbeatIntervalMs ?? 15000,
      pollWaitMs: this.pollWaitMs,
      resumed: body.resumed === true,
    };
  }

  send(messages: Message[]): void {
    this.queue.push(...messages);
    void this.flush();
  }

  stop(): void {
    this.running = false;
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    if (this.flushTimer) {
      this.host.clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.queue = [];
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      const controller = new AbortController();
      this.abort = controller;
      try {
        const target = this.endpoint(
          `/api/sessions/${encodeURIComponent(this.sessionId ?? "")}/messages?waitMs=${this.pollWaitMs}&lastSeq=${this.lastSeq}`,
        );
        const res = await this.fetchImpl(target, {
          signal: controller.signal,
          headers: { Accept: "application/json", ...this.authHeaders() },
        });
        if (!this.running) return;
        if (!res.ok) throw new Error(`poll failed: HTTP ${res.status}`);

        const body = (await res.json()) as PollBody;
        if (body.replacedBy === "ws") {
          // 服务端仍认为该会话有 WS 附着。刚主动断开 WS 时这里可能短暂出现，
          // 稍等重试；连续多次才认定会话确实被另一条 WS 接管。
          this.replacedByWS += 1;
          if (this.replacedByWS >= 4) {
            this.emitClose("switch");
            return;
          }
          await sleep(this.host, 250);
          continue;
        }
        this.replacedByWS = 0;
        for (const msg of body.messages ?? []) {
          if (typeof msg.seq === "number" && msg.seq > 0) {
            if (msg.seq <= this.lastSeq) continue;
            this.lastSeq = msg.seq;
          }
          this.messageCb?.(msg);
        }
      } catch (err) {
        if (!this.running) return;
        if (isAbortError(err)) return;
        this.emitClose("network");
        return;
      } finally {
        if (this.abort === controller) this.abort = null;
      }
    }
  }

  private async flush(): Promise<void> {
    if (!this.running || this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue;
    this.queue = [];
    try {
      const target = this.endpoint(`/api/sessions/${encodeURIComponent(this.sessionId ?? "")}/messages`);
      const res = await this.fetchImpl(target, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...this.authHeaders() },
        body: JSON.stringify({ messages: batch }),
      });
      if (!res.ok) throw new Error(`send failed: HTTP ${res.status}`);
    } catch (err) {
      this.queue = batch.concat(this.queue);
      if (this.running && !isAbortError(err)) this.emitClose("network");
    } finally {
      this.flushing = false;
    }
  }

  private emitClose(reason: CloseReason): void {
    if (!this.running) return;
    this.running = false;
    if (this.flushTimer) {
      this.host.clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.closeCb?.(reason);
  }

  private endpoint(path: string): string {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl.slice(0, -1) : this.baseUrl;
    return `${base}${path}`;
  }
}

function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}

function sleep(host: CoreHost, ms: number): Promise<void> {
  return new Promise((resolve) => host.setTimeout(resolve, ms));
}
