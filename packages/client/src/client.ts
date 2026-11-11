import { createMessage, ErrorCode, MessageType, newId } from "@basestation/protocol";
import type { Message } from "@basestation/protocol";

import { BaseStationError, ConnectionError, RequestError, TimeoutError } from "./errors.js";
import { MessageBus } from "./message-bus.js";
import type { BusEntry } from "./message-bus.js";
import { PendingTable } from "./pending.js";
import { PollingTransport } from "./transports/polling.js";
import { WebSocketTransport } from "./transports/websocket.js";
import { Subscription } from "./types.js";
import type {
  BaseStationOptions,
  ClientState,
  CloseReason,
  IBaseStationClient,
  LogLevel,
  OnceOptions,
  ReconnectOptions,
  RequestOptions,
  StateChangeInfo,
  SubscribeOptions,
  Transport,
  TransportFactory,
  TransportKind,
} from "./types.js";

const HEARTBEAT_FALLBACK_MS = 15000;

interface ResolvedOptions {
  url: string;
  transport: "auto" | "ws" | "poll";
  requestTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  pollWaitMs: number;
  wsUpgradeProbeMs: number;
  sessionStorageKey: string | false;
  reconnect: Required<ReconnectOptions>;
  logger?: (level: LogLevel, event: string, meta?: unknown) => void;
}

interface SubRecord {
  topic: string;
  entry: BusEntry;
  subscription: Subscription;
}

/**
 * 页面唯一的通信出口。
 *
 * - 同一时刻至多持有一个 Transport（WS 或轮询），切换串行化
 * - 所有入站帧只经过 handleInbound 一个入口后分发
 * - 订阅按订阅 id 隔离，监听器异常互不影响
 */
export class BaseStationClient implements IBaseStationClient {
  private readonly opts: ResolvedOptions;
  private readonly factory: TransportFactory;

  private readonly bus = new MessageBus((err, entry) => {
    this.log("error", "subscription_handler_failed", { topic: entry.topic, error: String(err) });
  });
  private readonly pending = new PendingTable();
  private readonly subs = new Map<string, SubRecord>();
  private readonly stateListeners = new Set<(state: ClientState, info: StateChangeInfo) => void>();
  private readonly trafficListeners = new Set<(msg: Message, dir: "in" | "out") => void>();

  private _state: ClientState = "idle";
  private _transport: Transport | null = null;
  private _transportKind: TransportKind | null = null;
  private _sessionId: string | null = null;

  private switchLock: Promise<void> = Promise.resolve();
  private switching = false;
  private manualClose = false;

  private outbound: Message[] = [];
  private lastSeq = 0;

  private heartbeatInterval = HEARTBEAT_FALLBACK_MS;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatDeadline: ReturnType<typeof setTimeout> | null = null;
  private heartbeatPending = false;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private upgradeTimer: ReturnType<typeof setInterval> | null = null;
  private upgradeSuppressedUntil = 0;

  constructor(options: BaseStationOptions) {
    if (!options.url) {
      throw new BaseStationError(ErrorCode.BadMessage, "BaseStationOptions.url is required");
    }
    const reconnect = options.reconnect ?? {};
    this.opts = {
      url: options.url,
      transport: options.transport ?? "auto",
      requestTimeoutMs: options.requestTimeoutMs ?? 10000,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? HEARTBEAT_FALLBACK_MS,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 5000,
      pollWaitMs: options.pollWaitMs ?? 25000,
      wsUpgradeProbeMs: options.wsUpgradeProbeMs ?? 30000,
      sessionStorageKey: options.sessionStorageKey ?? "basestation.sessionId",
      reconnect: {
        baseDelayMs: reconnect.baseDelayMs ?? 500,
        maxDelayMs: reconnect.maxDelayMs ?? 10000,
        factor: reconnect.factor ?? 2,
        jitterRatio: reconnect.jitterRatio ?? 0.2,
      },
      logger: options.logger,
    };
    this.heartbeatInterval = this.opts.heartbeatIntervalMs;
    this._sessionId = this.readStoredSession();
    this.factory =
      options.transportFactory ??
      {
        createWebSocket: () => new WebSocketTransport(this.opts.url, this._sessionId),
        createPolling: () => new PollingTransport(this.opts.url, this._sessionId, this.opts.pollWaitMs),
      };
  }

  get state(): ClientState {
    return this._state;
  }

  get transportKind(): TransportKind | null {
    return this._transportKind;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  onStateChange(cb: (state: ClientState, info: StateChangeInfo) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  onTraffic(cb: (msg: Message, dir: "in" | "out") => void): () => void {
    this.trafficListeners.add(cb);
    return () => {
      this.trafficListeners.delete(cb);
    };
  }

  // ---------------------------------------------------------------- 连接管理

  async connect(): Promise<void> {
    if (this._state === "connected" || this._state === "connecting") return;
    this.manualClose = false;
    this.setState("connecting", "connect");
    this.clearReconnect();

    const preference = this.opts.transport;
    if (preference === "poll") {
      await this.connectStrict("poll");
      return;
    }
    if (preference === "ws") {
      await this.connectStrict("ws");
      return;
    }

    // auto：先 WS，失败立即降级轮询
    try {
      await this.switchTo("ws");
      this.setState("connected", "transport:ws");
      return;
    } catch (err) {
      this.log("warn", "ws_unavailable", { error: String(err) });
    }
    try {
      await this.switchTo("poll");
      this.setState("degraded", "fallback:poll");
      this.startUpgradeProbe();
    } catch (err) {
      this.enterReconnecting();
      throw err instanceof Error ? err : new ConnectionError("failed to connect");
    }
  }

  async disconnect(): Promise<void> {
    this.manualClose = true;
    this.clearReconnect();
    this.stopUpgradeProbe();
    this.stopHeartbeat();
    await this.withLock(async () => {
      this.stopTransportLocked();
    });
    this.pending.abandonAll(new ConnectionError("client disconnected"));
    this.outbound = [];
    this.setState("closed", "disconnect");
  }

  private async connectStrict(kind: TransportKind): Promise<void> {
    try {
      await this.switchTo(kind);
      this.setState("connected", `transport:${kind}`);
    } catch (err) {
      this.enterReconnecting();
      throw err instanceof Error ? err : new ConnectionError("failed to connect");
    }
  }

  /** 串行化切换：先停旧传输，再起新传输，保证同一时刻至多一条连接。 */
  private switchTo(kind: TransportKind): Promise<void> {
    return this.withLock(async () => {
      this.switching = true;
      this.stopHeartbeat();
      this.stopTransportLocked();
      try {
        await this.activateLocked(kind);
      } finally {
        this.switching = false;
      }
    });
  }

  private async activateLocked(kind: TransportKind): Promise<void> {
    const transport = kind === "ws" ? this.factory.createWebSocket() : this.factory.createPolling();
    transport.onMessage((msg) => this.handleInbound(msg));
    transport.onClose((reason) => this.handleTransportClose(transport, reason));

    const info = await transport.start();

    this._transport = transport;
    this._transportKind = kind;
    this._sessionId = info.sessionId;
    this.persistSession(info.sessionId);
    if (info.heartbeatIntervalMs > 0) this.heartbeatInterval = info.heartbeatIntervalMs;
    if (info.pollWaitMs > 0) this.opts.pollWaitMs = info.pollWaitMs;

    this.replaySubscriptions();
    this.flushOutbound();
    if (kind === "ws") this.startHeartbeat();
    this.log("info", "transport_ready", { kind, sessionId: info.sessionId, resumed: info.resumed });
  }

  private stopTransportLocked(): void {
    const transport = this._transport;
    this._transport = null;
    this._transportKind = null;
    if (!transport) return;
    this.stopHeartbeat();
    try {
      transport.stop();
    } catch (err) {
      this.log("warn", "transport_stop_failed", { error: String(err) });
    }
  }

  private handleTransportClose(transport: Transport, reason: CloseReason): void {
    if (transport !== this._transport) return; // 旧传输的迟到事件
    if (this.manualClose) return;
    if (reason === "manual") return;

    this.log("warn", "transport_closed", { kind: transport.kind, reason });
    this.stopHeartbeat();
    this._transport = null;
    this._transportKind = null;
    try {
      transport.stop();
    } catch {
      // 忽略
    }

    if (reason === "switch") {
      // 服务端表示该会话已被另一条 WS 接管（例如另一个标签页）。
      // 继续复用只会反复收到 replacedBy，这里丢弃会话后重新建一条。
      this.log("warn", "session_taken_over", { sessionId: this._sessionId });
      this.dropSession();
      this.enterReconnecting();
      return;
    }

    if (reason === "heartbeat") {
      this.setState("degraded", "heartbeat_lost");
    } else {
      this.setState("degraded", `transport_closed:${reason}`);
    }
    void this.recoverToPoll();
  }

  /** 丢弃当前会话（含本地持久化），下一次连接会创建新会话。 */
  private dropSession(): void {
    this._sessionId = null;
    this.lastSeq = 0;
    const key = this.opts.sessionStorageKey;
    if (!key) return;
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      // 隐私模式等场景下忽略
    }
  }

  private async recoverToPoll(): Promise<void> {
    if (this.manualClose) return;
    try {
      await this.switchTo("poll");
      this.setState("degraded", "fallback:poll");
      this.startUpgradeProbe();
    } catch (err) {
      this.log("warn", "poll_fallback_failed", { error: String(err) });
      this.enterReconnecting();
    }
  }

  private enterReconnecting(): void {
    if (this.manualClose) return;
    this.setState("reconnecting", "reconnect");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.manualClose || this.reconnectTimer) return;
    const attempt = this.reconnectAttempt;
    this.reconnectAttempt += 1;

    const { baseDelayMs, maxDelayMs, factor, jitterRatio } = this.opts.reconnect;
    const raw = Math.min(maxDelayMs, baseDelayMs * Math.pow(factor, attempt));
    const jitter = raw * jitterRatio;
    const delay = Math.max(0, raw - jitter + Math.random() * jitter * 2);

    this.log("info", "reconnect_scheduled", { attempt: attempt + 1, delayMs: Math.round(delay) });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectOnce();
    }, delay);
  }

  private async reconnectOnce(): Promise<void> {
    if (this.manualClose || this._state === "connected") return;
    const preferWs = this.opts.transport !== "poll";
    try {
      if (preferWs) {
        try {
          await this.switchTo("ws");
          this.reconnectAttempt = 0;
          this.setState("connected", "reconnect:ws");
          return;
        } catch (err) {
          this.log("warn", "reconnect_ws_failed", { error: String(err) });
        }
      }
      await this.switchTo("poll");
      this.reconnectAttempt = 0;
      this.setState("degraded", "reconnect:poll");
      this.startUpgradeProbe();
    } catch (err) {
      this.log("warn", "reconnect_failed", { error: String(err) });
      this.scheduleReconnect();
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.switchLock.then(fn, fn);
    this.switchLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ------------------------------------------------------------------ 心跳

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this._transportKind !== "ws") return;
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), this.heartbeatInterval);
  }

  private heartbeatTick(): void {
    if (this._transportKind !== "ws" || this.heartbeatPending) return;
    this.heartbeatPending = true;
    this.rawSend(createMessage(MessageType.Ping));

    this.heartbeatDeadline = setTimeout(() => {
      if (!this.heartbeatPending) return;
      this.heartbeatPending = false;
      this.log("warn", "heartbeat_lost", { timeoutMs: this.opts.heartbeatTimeoutMs });
      const transport = this._transport;
      if (transport) this.handleTransportClose(transport, "heartbeat");
    }, this.opts.heartbeatTimeoutMs);
  }

  private clearHeartbeatDeadline(): void {
    if (this.heartbeatDeadline) {
      clearTimeout(this.heartbeatDeadline);
      this.heartbeatDeadline = null;
    }
    this.heartbeatPending = false;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearHeartbeatDeadline();
  }

  // -------------------------------------------------- 降级后定期尝试升级回 WS

  private startUpgradeProbe(): void {
    this.stopUpgradeProbe();
    if (this.opts.transport !== "auto") return;
    this.upgradeTimer = setInterval(() => {
      void this.tryUpgrade();
    }, this.opts.wsUpgradeProbeMs);
  }

  private stopUpgradeProbe(): void {
    if (this.upgradeTimer) {
      clearInterval(this.upgradeTimer);
      this.upgradeTimer = null;
    }
  }

  /**
   * 排障/演示：主动断开当前 WS 并降级到轮询，在 durationMs 内不再尝试升级回 WS。
   * 若当前已是轮询，则只屏蔽后续升级尝试。
   */
  forceDegrade(durationMs = 15000): void {
    this.upgradeSuppressedUntil = Date.now() + Math.max(0, durationMs);
    this.stopUpgradeProbe();
    if (this._transportKind !== "ws") return;

    const transport = this._transport;
    this._transport = null;
    this._transportKind = null;
    this.stopHeartbeat();
    if (transport) {
      try {
        transport.stop();
      } catch {
        // 忽略关闭阶段的异常
      }
    }
    this.setState("degraded", "force_degrade");
    void this.recoverToPoll();
  }

  private async tryUpgrade(): Promise<void> {
    if (this.manualClose || this._state !== "degraded" || this._transportKind !== "poll") return;
    if (Date.now() < this.upgradeSuppressedUntil) return;
    this.log("debug", "ws_upgrade_attempt");
    try {
      await this.switchTo("ws");
      this.setState("connected", "upgrade:ws");
      this.stopUpgradeProbe();
      this.reconnectAttempt = 0;
    } catch (err) {
      this.log("warn", "ws_upgrade_failed", { error: String(err) });
      try {
        await this.switchTo("poll");
        this.setState("degraded", "upgrade:fallback");
      } catch (nested) {
        this.log("warn", "upgrade_restore_failed", { error: String(nested) });
        this.enterReconnecting();
      }
    }
  }

  // ------------------------------------------------------------ 入站统一分发

  private handleInbound(msg: Message): void {
    this.emitTraffic(msg, "in");

    // seq 去重：切换传输后可能重复投递，只保留最新。
    if (typeof msg.seq === "number" && msg.seq > 0) {
      if (msg.seq <= this.lastSeq) return;
      this.lastSeq = msg.seq;
    }

    switch (msg.type) {
      case MessageType.Pong:
        this.clearHeartbeatDeadline();
        return;
      case MessageType.Res:
        if (msg.replyTo) this.pending.settle(msg.replyTo, msg);
        return;
      case MessageType.Error:
        if (msg.replyTo && this.pending.has(msg.replyTo)) {
          this.pending.settle(msg.replyTo, msg);
        } else {
          this.log("warn", "server_error", msg.error ?? msg);
        }
        return;
      case MessageType.Event:
        this.bus.dispatch(msg);
        return;
      case MessageType.Hello:
        return; // 传输层已消费
      default:
        return;
    }
  }

  private emitTraffic(msg: Message, dir: "in" | "out"): void {
    for (const cb of this.trafficListeners) {
      try {
        cb(msg, dir);
      } catch (err) {
        this.log("error", "traffic_listener_failed", String(err));
      }
    }
  }

  private rawSend(msg: Message): void {
    this.emitTraffic(msg, "out");
    if (this._transport && !this.switching) {
      this._transport.send([msg]);
      return;
    }
    this.outbound.push(msg);
  }

  private flushOutbound(): void {
    if (this.outbound.length === 0) return;
    const transport = this._transport;
    if (!transport) return;
    const batch = this.outbound;
    this.outbound = [];
    transport.send(batch);
  }

  // -------------------------------------------------------------- 请求-响应

  request<T = unknown>(topic: string, payload?: unknown, opts: RequestOptions = {}): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs;
    const retries = Math.max(0, opts.retries ?? 0);
    const retryDelayMs = opts.retryDelayMs ?? 300;
    const message = createMessage<unknown>(MessageType.Req, { topic, payload: payload ?? {} });

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let remaining = retries;

      const attempt = (): void => {
        if (settled) return;
        this.pending.add({
          id: message.id,
          topic,
          timeoutMs,
          onSettle: (msg) => {
            settled = true;
            if (msg.error) reject(new RequestError(topic, msg.error));
            else resolve(msg.payload as T);
          },
          onTimeout: () => {
            if (settled) return;
            if (remaining > 0) {
              remaining -= 1;
              this.log("debug", "request_retry", { topic, id: message.id, remaining });
              setTimeout(attempt, retryDelayMs);
              return;
            }
            settled = true;
            reject(new TimeoutError(topic, timeoutMs));
          },
          onAbandon: (err) => {
            settled = true;
            reject(err);
          },
        });
        this.rawSend(message);
      };

      attempt();
    });
  }

  // ------------------------------------------------------------------ 订阅

  subscribe<T = unknown>(
    topic: string,
    handler: (payload: T, msg: Message<T>) => void,
    opts: SubscribeOptions = {},
  ): Subscription {
    const id = newId();
    const subscription = new Subscription(id, topic, (sid) => this.removeSubscription(sid));
    const entry: BusEntry = {
      id,
      topic,
      handler: handler as (payload: unknown, msg: Message) => void,
      filter: opts.filter,
      onError: opts.onError,
    };

    const isFirstListener = !this.bus.hasTopic(topic);
    this.bus.add(entry);
    this.subs.set(id, { topic, entry, subscription });

    if (isFirstListener && this.isReady()) this.sendSub(topic);
    return subscription;
  }

  async unsubscribe(target: Subscription | string): Promise<void> {
    if (typeof target === "string") {
      const records = [...this.subs.values()].filter((rec) => rec.topic === target);
      if (records.length === 0) return;
      for (const rec of records) {
        await rec.subscription.unsubscribe();
      }
      return;
    }
    await target.unsubscribe();
  }

  private async removeSubscription(id: string): Promise<void> {
    const record = this.subs.get(id);
    if (!record) return;
    this.subs.delete(id);
    this.bus.remove(id);
    if (!this.bus.hasTopic(record.topic) && this.isReady()) {
      this.sendUnsub(record.topic);
    }
  }

  once<T = unknown>(topic: string, opts: OnceOptions = {}): Promise<Message<T>> {
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs;
    return new Promise<Message<T>>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let subscription: Subscription | null = null;

      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void subscription?.unsubscribe();
        action();
      };

      subscription = this.subscribe<T>(topic, (_payload, msg) => {
        finish(() => resolve(msg));
      });
      timer = setTimeout(() => {
        finish(() => reject(new TimeoutError(topic, timeoutMs)));
      }, timeoutMs);
    });
  }

  private replaySubscriptions(): void {
    const topics = new Set([...this.subs.values()].map((rec) => rec.topic));
    for (const topic of topics) this.sendSub(topic);
  }

  private sendSub(topic: string): void {
    this.rawSend(createMessage(MessageType.Sub, { topic }));
  }

  private sendUnsub(topic: string): void {
    this.rawSend(createMessage(MessageType.Unsub, { topic }));
  }

  private isReady(): boolean {
    return this._transport !== null && (this._state === "connected" || this._state === "degraded");
  }

  // ------------------------------------------------------------------ 杂项

  private setState(next: ClientState, reason?: string): void {
    const previous = this._state;
    if (previous === next) return;
    this._state = next;
    const info: StateChangeInfo = {
      previous,
      state: next,
      transport: this._transportKind,
      sessionId: this._sessionId,
      reason,
    };
    for (const cb of this.stateListeners) {
      try {
        cb(next, info);
      } catch (err) {
        this.log("error", "state_listener_failed", String(err));
      }
    }
  }

  private readStoredSession(): string | null {
    const key = this.opts.sessionStorageKey;
    if (!key) return null;
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private persistSession(sessionId: string): void {
    const key = this.opts.sessionStorageKey;
    if (!key) return;
    try {
      globalThis.localStorage?.setItem(key, sessionId);
    } catch {
      // 隐私模式等场景下忽略
    }
  }

  private log(level: LogLevel, event: string, meta?: unknown): void {
    this.opts.logger?.(level, event, meta);
  }
}
