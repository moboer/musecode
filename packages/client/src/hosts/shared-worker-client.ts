/**
 * SharedWorkerClient —— 页面侧的基站客户端（SharedWorker 宿主，方案 v2 §4.1）。
 *
 * 接口与 BaseStationClient 对齐（实现 IBaseStationClient），但页面里不建连接：
 * 它把订阅/请求经 MessagePort 转给 SharedWorker 里唯一的真实客户端，
 * 同源的多个标签页因此共享同一条后端连接（§9.3 多标签验收）。
 *
 * - 构造时即创建 SharedWorker 并发送 init（url/token 取自选项，首个标签的参数生效）
 * - 每 5 秒发一次 ping 作为标签存活心跳；关页前 disconnect() 发送 bye 立即释放订阅
 * - 不支持 SharedWorker 的环境用 isSupported() 预检，降级路径见 createBestClient
 */
import type { Message } from "@basestation/protocol";

import type { ErrorCode } from "@basestation/protocol";

import { BaseStationClient } from "../client.js";
import { ConnectionError, RequestError } from "../errors.js";
import { browserHost } from "../host.js";
import { Subscription } from "../types.js";
import type {
  BaseStationOptions,
  ClientState,
  IBaseStationClient,
  OnceOptions,
  RequestOptions,
  StateChangeInfo,
  TransportKind,
} from "../types.js";
import type { PortEvent, PortRequest } from "./worker-protocol.js";

export interface SharedWorkerClientOptions extends BaseStationOptions {
  /** worker 脚本地址（构建产物 dist/hosts/worker-entry.js，或由打包器产出的 URL） */
  workerUrl: string | URL;
}

interface PendingRequest {
  topic: string;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

const PING_INTERVAL_MS = 5000;

export class SharedWorkerClient implements IBaseStationClient {
  private readonly options: SharedWorkerClientOptions;
  private readonly host;
  private worker: SharedWorker | null = null;
  private port: MessagePort | null = null;
  private _state: ClientState = "idle";
  private stateCbs = new Set<(state: ClientState, info: StateChangeInfo) => void>();
  private handlers = new Map<string, { topic: string; handler: (payload: unknown, msg: Message) => void }>();
  private pending = new Map<string, PendingRequest>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private counter = 0;
  private connectResolve: (() => void) | null = null;

  constructor(options: SharedWorkerClientOptions) {
    this.options = options;
    this.host = options.host ?? browserHost;
  }

  /** 当前环境是否支持 SharedWorker。 */
  static isSupported(): boolean {
    return typeof SharedWorker !== "undefined";
  }

  get state(): ClientState {
    return this._state;
  }

  /** 连接在 worker 内，页面侧不感知具体传输。 */
  get transportKind(): TransportKind | null {
    return null;
  }

  /** 会话在 worker 内持有，页面侧不暴露。 */
  get sessionId(): string | null {
    return null;
  }

  connect(): Promise<void> {
    if (this.port) return Promise.resolve();
    const worker = new SharedWorker(this.options.workerUrl, { name: "basestation" });
    this.worker = worker;
    this.port = worker.port;
    worker.port.onmessage = (ev: MessageEvent<PortEvent>) => this.handleEvent(ev.data);
    worker.port.start();
    this.setState("connecting");
    this.post({ kind: "init", url: this.options.url, token: this.currentToken() });
    this.pingTimer = this.host.setInterval(() => this.post({ kind: "ping" }), PING_INTERVAL_MS);
    return new Promise<void>((resolve) => {
      this.connectResolve = resolve;
    });
  }

  disconnect(): void {
    this.post({ kind: "bye" });
    if (this.pingTimer) {
      this.host.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const pending of this.pending.values()) {
      if (pending.timer) this.host.clearTimeout(pending.timer);
      pending.reject(new ConnectionError("shared worker client disconnected"));
    }
    this.pending.clear();
    this.handlers.clear();
    this.port?.close();
    this.port = null;
    this.worker = null;
    this.setState("closed");
  }

  subscribe<T = unknown>(topic: string, handler: (payload: T, msg: Message<T>) => void): Subscription {
    const subId = `sub-${++this.counter}`;
    this.handlers.set(subId, { topic, handler: handler as (payload: unknown, msg: Message) => void });
    this.post({ kind: "sub", subId, topic });
    return new Subscription(subId, topic, async (id) => {
      this.handlers.delete(id);
      this.post({ kind: "unsub", subId: id });
    });
  }

  async unsubscribe(target: Subscription | string): Promise<void> {
    if (typeof target !== "string") {
      await target.unsubscribe();
      return;
    }
    // 按主题批量退订本页面的全部匹配订阅
    for (const [subId, entry] of [...this.handlers]) {
      if (entry.topic === target) {
        this.handlers.delete(subId);
        this.post({ kind: "unsub", subId });
      }
    }
  }

  request<T = unknown>(topic: string, payload?: unknown, opts?: RequestOptions): Promise<T> {
    const reqId = `req-${++this.counter}`;
    const timeoutMs = opts?.timeoutMs ?? 10000;
    return new Promise<T>((resolve, reject) => {
      const timer = this.host.setTimeout(() => {
        this.pending.delete(reqId);
        reject(new ConnectionError(`request to ${topic} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(reqId, { topic, resolve: resolve as (v: unknown) => void, reject, timer });
      this.post({ kind: "req", reqId, topic, payload, timeoutMs });
    });
  }

  once<T = unknown>(topic: string, opts?: OnceOptions): Promise<Message<T>> {
    const timeoutMs = opts?.timeoutMs ?? 10000;
    return new Promise<Message<T>>((resolve, reject) => {
      const timer = this.host.setTimeout(() => {
        void subscription.unsubscribe();
        reject(new ConnectionError(`once(${topic}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const subscription = this.subscribe<T>(topic, (payload, msg) => {
        this.host.clearTimeout(timer);
        void subscription.unsubscribe();
        resolve(msg);
        void payload;
      });
    });
  }

  onStateChange(cb: (state: ClientState, info: StateChangeInfo) => void): () => void {
    this.stateCbs.add(cb);
    return () => this.stateCbs.delete(cb);
  }

  /** 旁路观测在 worker 侧发生，页面 stub 不转发原始帧：注册可，回调不触发。 */
  onTraffic(): () => void {
    return () => {};
  }

  /** 降级控制的是 worker 内的传输，页面 stub 不支持：忽略。 */
  forceDegrade(): void {}

  private currentToken(): string | undefined {
    return this.options.tokenProvider?.() ?? this.options.token ?? undefined;
  }

  private post(msg: PortRequest): void {
    this.port?.postMessage(msg);
  }

  private setState(state: ClientState): void {
    if (this._state === state) return;
    const previous = this._state;
    this._state = state;
    const info: StateChangeInfo = { previous, state, transport: null, sessionId: null, reason: "shared-worker" };
    for (const cb of this.stateCbs) {
      cb(state, info);
    }
    if (this.connectResolve && state !== "connecting" && state !== "idle") {
      this.connectResolve();
      this.connectResolve = null;
    }
  }

  private handleEvent(ev: PortEvent): void {
    switch (ev.kind) {
      case "state":
        this.setState(ev.state);
        return;
      case "event": {
        const entry = this.handlers.get(ev.subId);
        if (entry) {
          entry.handler(ev.payload, {
            type: "event",
            id: "",
            ts: Date.now(),
            payload: ev.payload,
            error: null,
            topic: ev.topic,
          } as Message);
        }
        return;
      }
      case "res": {
        const pending = this.pending.get(ev.reqId);
        if (!pending) return;
        this.pending.delete(ev.reqId);
        if (pending.timer) this.host.clearTimeout(pending.timer);
        if (ev.ok) {
          pending.resolve(ev.payload);
        } else {
          pending.reject(
            new RequestError(pending.topic, {
              code: ev.error.code as ErrorCode,
              message: ev.error.message,
              retryable: false,
            }),
          );
        }
        return;
      }
    }
  }
}

/**
 * 按环境选最佳客户端：支持 SharedWorker 时用共享宿主（多标签单连接），
 * 否则降级为页面内 BaseStationClient（每标签一条连接，功能不受影响）。
 */
export function createBestClient(
  options: BaseStationOptions & { workerUrl?: string | URL },
): IBaseStationClient & { connect(): Promise<void>; disconnect(): void } {
  if (options.workerUrl && SharedWorkerClient.isSupported()) {
    return new SharedWorkerClient({ ...options, workerUrl: options.workerUrl });
  }
  return new BaseStationClient(options);
}
