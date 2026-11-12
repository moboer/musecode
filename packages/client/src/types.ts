import type { Message } from "@basestation/protocol";

import type { CoreHost } from "./host.js";

export type TransportKind = "ws" | "poll";

export type ClientState = "idle" | "connecting" | "connected" | "degraded" | "reconnecting" | "closed";

export type CloseReason = "manual" | "heartbeat" | "network" | "server" | "switch";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 消息令牌提供者：返回当前有效令牌（无令牌时返回 null/undefined）。 */
export type TokenProvider = () => string | null | undefined;

/** 传输层启动后回填的会话信息，来自服务端的 hello / 会话接口。 */
export interface TransportInfo {
  sessionId: string;
  heartbeatIntervalMs: number;
  pollWaitMs: number;
  resumed: boolean;
}

/**
 * 传输抽象：只负责搬运帧，不做重连、心跳与降级决策。
 * WS 与轮询是两个可互换的实现，这是「同一时刻至多一条连接」的边界。
 */
export interface Transport {
  readonly kind: TransportKind;
  start(): Promise<TransportInfo>;
  stop(): void;
  send(messages: Message[]): void;
  onMessage(cb: (msg: Message) => void): void;
  onClose(cb: (reason: CloseReason) => void): void;
}

export interface TransportFactory {
  createWebSocket(): Transport;
  createPolling(): Transport;
}

export interface ReconnectOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitterRatio?: number;
}

export interface BaseStationOptions {
  /** 基站基地址，例如 http://localhost:8080 */
  url: string;
  /** auto 为先 WS，失败后降级轮询；也可强制指定单一传输（排障用） */
  transport?: "auto" | "ws" | "poll";
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  pollWaitMs?: number;
  /** 降级到轮询后尝试升级回 WS 的间隔 */
  wsUpgradeProbeMs?: number;
  reconnect?: ReconnectOptions;
  /**
   * 网络试探（重连前先行，分两段判定“网络断”还是“服务挂”）：
   * - 第一段（网络）：探一个与基站进程无关的目标（见 networkProbeUrl，
   *   默认页面所在源）——不通说明网络/路径断了；
   * - 第二段（服务）：探基站 `GET /api/health`——网络通而它不通，说明
   *   基站服务本身不可用。
   * 任一段不通，本轮都跳过 WS 与轮询的尝试（必然失败，只会白建会话），
   * 保持重连退避继续试探；两段都通才走 WS → 轮询的传输阶梯。当前卡在
   * 哪一段会经状态事件的 reason（`probe:network` / `probe:service`）与
   * 日志（`network_unreachable` / `service_unreachable`）区分上报。
   * 注入本选项可整体替换默认两段试探（返回 false 按网络段不通处理）。
   */
  networkProbe?: () => Promise<boolean>;
  /**
   * 网络段试探的目标 URL。默认取页面所在源（location.origin）——它与
   * 基站同主机/同网段时能准确代表“网络通不通”；基站在另一台主机时，
   * 建议显式指定为那台主机或同网段常驻服务的地址。无页面环境且未指定
   * 时跳过网络段、只探服务段。
   */
  networkProbeUrl?: string;
  /** 每段试探的超时（ms），默认 2000；设为 0 禁用试探，重连直接尝试传输（旧行为） */
  networkProbeTimeoutMs?: number;
  /** 默认 "basestation.sessionId"；false 表示不持久化 */
  sessionStorageKey?: string | false;
  /** 依赖注入，主要用于测试 */
  transportFactory?: TransportFactory;
  /** 宿主接口（定时器/时钟/存储/网络的注入点），默认浏览器主线程宿主 */
  host?: CoreHost;
  /** 入站 seq 出现缺口（中间帧被丢弃）时的告警出口；同时也会记 warn 日志 */
  onSeqGap?: (info: SeqGapInfo) => void;
  /**
   * 消息令牌（服务端 -auth-mode=jwt 时必带）：由业务登录态向基站令牌端点交换得到，
   * 决定可订阅/可发布的 topic 与速率配额。WS 经 ?token= 传递，轮询经 Authorization 头。
   */
  token?: string;
  /** 令牌提供者：每次（重）连时调用，令牌过期刷新后自动生效；优先于 token */
  tokenProvider?: TokenProvider;
  logger?: (level: LogLevel, event: string, meta?: unknown) => void;
}

/** 入站 seq 缺口信息：expected 本应到达的下一帧，received 实际到达，missed 中间丢了几帧。 */
export interface SeqGapInfo {
  expected: number;
  received: number;
  missed: number;
}

export interface StateChangeInfo {
  previous: ClientState;
  state: ClientState;
  transport: TransportKind | null;
  sessionId: string | null;
  reason?: string;
}

export interface RequestOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export interface SubscribeOptions {
  /** 同一主题内的二级数据隔离：返回 false 的帧不会进入该监听器 */
  filter?: (payload: unknown, msg: Message) => boolean;
  /** 该订阅自己的错误出口，避免影响其他监听器 */
  onError?: (err: unknown) => void;
}

export interface OnceOptions {
  timeoutMs?: number;
}

/** 订阅句柄。取消订阅按订阅 id 精确移除，不影响同主题上的其他监听器。 */
export class Subscription {
  private activeFlag = true;

  constructor(
    readonly id: string,
    readonly topic: string,
    private readonly remove: (id: string) => Promise<void>,
  ) {}

  get active(): boolean {
    return this.activeFlag;
  }

  async unsubscribe(): Promise<void> {
    if (!this.activeFlag) return;
    this.activeFlag = false;
    await this.remove(this.id);
  }

  /** 内部使用：批量取消时标记失效。 */
  markInactive(): void {
    this.activeFlag = false;
  }
}

/**
 * 组件唯一需要依赖的接口。业务代码只感知订阅/请求，
 * 不感知 WS、轮询、重连与心跳的实现细节。
 */
export interface IBaseStationClient {
  readonly state: ClientState;
  readonly transportKind: TransportKind | null;
  readonly sessionId: string | null;

  onStateChange(cb: (state: ClientState, info: StateChangeInfo) => void): () => void;
  /** 纯本地旁路观测（不产生任何服务端订阅），用于日志与排障 */
  onTraffic(cb: (msg: Message, dir: "in" | "out") => void): () => void;
  /** 排障/演示：主动断开 WS 降级到轮询，并在 durationMs 内屏蔽升级回 WS */
  forceDegrade(durationMs?: number): void;

  request<T = unknown>(topic: string, payload?: unknown, opts?: RequestOptions): Promise<T>;
  subscribe<T = unknown>(
    topic: string,
    handler: (payload: T, msg: Message<T>) => void,
    opts?: SubscribeOptions,
  ): Subscription;
  unsubscribe(target: Subscription | string): Promise<void>;
  once<T = unknown>(topic: string, opts?: OnceOptions): Promise<Message<T>>;
}
