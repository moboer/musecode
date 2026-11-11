/**
 * WorkerRouter —— SharedWorker 侧的多标签路由器（方案 v2 §4.1 / §9.3 多标签验收）。
 *
 * 职责：
 * - 全浏览器（同源）只持有一个真实客户端连接（由外部注入的工厂在首个 init 时创建）
 * - 订阅引用计数：多个标签订同一主题只产生一份真实订阅，事件扇出给所有订阅标签
 * - 订阅绑标签：标签发 bye 或心跳超时（标签被关/崩溃）后，其订阅被清理，不残留
 * - 请求代答：标签的 req 由真实客户端执行，结果只回给发起标签
 */
import type { Message } from "@basestation/protocol";

import type { ClientState, RequestOptions, Subscription } from "../types.js";
import type { PortEvent, PortRequest } from "./worker-protocol.js";

/** 路由器依赖的真实客户端最小接口。 */
export interface RouterClient {
  readonly state: ClientState;
  subscribe<T = unknown>(topic: string, handler: (payload: T, msg: Message<T>) => void): Subscription;
  request<T = unknown>(topic: string, payload?: unknown, opts?: RequestOptions): Promise<T>;
  onStateChange(cb: (state: ClientState) => void): () => void;
}

/** MessagePort 的结构化最小接口（便于测试注入假 port）。 */
export interface PortLike {
  postMessage(data: PortEvent): void;
}

interface TabState {
  port: PortLike;
  lastSeen: number;
  /** subId → topic */
  subs: Map<string, string>;
}

interface TopicFanout {
  real: Subscription;
  /** 目标集合，元素键为 `${tabId}\u0000${subId}` */
  targets: Map<string, { tabId: number; subId: string }>;
}

export interface WorkerRouterOptions {
  /** 按首个标签的 init 参数创建真实客户端（全 worker 只调用一次） */
  clientFactory: (init: { url: string; token?: string }) => RouterClient;
  /** 标签心跳超时（ms）：超过未见任何消息即视为标签已消失，清理其订阅 */
  staleMs?: number;
  now?: () => number;
}

const targetKey = (tabId: number, subId: string): string => `${tabId}\u0000${subId}`;

export class WorkerRouter {
  private readonly staleMs: number;
  private readonly now: () => number;
  private client: RouterClient | null = null;
  private tabs = new Map<number, TabState>();
  private topics = new Map<string, TopicFanout>();
  private nextTabId = 1;
  private buffered = new Map<number, PortRequest[]>();

  constructor(private readonly options: WorkerRouterOptions) {
    this.staleMs = options.staleMs ?? 15000;
    this.now = options.now ?? (() => Date.now());
  }

  /** 一个标签的 port 接入时调用，返回 tabId。 */
  attach(port: PortLike): number {
    const tabId = this.nextTabId++;
    this.tabs.set(tabId, { port, lastSeen: this.now(), subs: new Map() });
    if (this.client) {
      port.postMessage({ kind: "state", state: this.client.state });
    }
    return tabId;
  }

  /** 处理某标签的一条消息。 */
  handleMessage(tabId: number, msg: PortRequest): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.lastSeen = this.now();

    if (msg.kind === "bye") {
      this.detach(tabId);
      return;
    }
    if (msg.kind === "init") {
      this.ensureClient(msg);
      const queued = this.buffered.get(tabId) ?? [];
      this.buffered.delete(tabId);
      for (const pending of queued) this.handleMessage(tabId, pending);
      return;
    }
    if (!this.client) {
      // init 还没到：先缓冲（同一 port 的消息有序，init 必在业务消息之前由页面发出）
      const queue = this.buffered.get(tabId) ?? [];
      queue.push(msg);
      this.buffered.set(tabId, queue);
      return;
    }

    switch (msg.kind) {
      case "ping":
        return;
      case "sub":
        this.handleSub(tabId, tab, msg.subId, msg.topic);
        return;
      case "unsub":
        this.handleUnsub(tabId, tab, msg.subId);
        return;
      case "req":
        void this.handleReq(tab, msg);
        return;
    }
  }

  /** 标签消失（bye/超时清理共用）：退订它占用的全部引用。 */
  detach(tabId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    for (const [subId] of [...tab.subs]) {
      this.handleUnsub(tabId, tab, subId);
    }
    this.tabs.delete(tabId);
    this.buffered.delete(tabId);
  }

  /** 清理心跳超时的标签（worker 侧定时调用）。返回清理数量。 */
  pruneStale(): number {
    const now = this.now();
    let pruned = 0;
    for (const [tabId, tab] of [...this.tabs]) {
      if (now - tab.lastSeen > this.staleMs) {
        this.detach(tabId);
        pruned++;
      }
    }
    return pruned;
  }

  /** 当前真实订阅数（验收/调试用）。 */
  get topicCount(): number {
    return this.topics.size;
  }

  /** 当前标签数。 */
  get tabCount(): number {
    return this.tabs.size;
  }

  private ensureClient(init: { url: string; token?: string }): void {
    if (this.client) return;
    const client = this.options.clientFactory(init);
    this.client = client;
    client.onStateChange((state) => {
      for (const tab of this.tabs.values()) {
        tab.port.postMessage({ kind: "state", state });
      }
    });
  }

  private handleSub(tabId: number, tab: TabState, subId: string, topic: string): void {
    if (!this.client) return;
    tab.subs.set(subId, topic);
    let fanout = this.topics.get(topic);
    if (!fanout) {
      const real = this.client.subscribe(topic, (payload: unknown) => {
        const current = this.topics.get(topic);
        if (!current) return;
        for (const target of current.targets.values()) {
          const targetTab = this.tabs.get(target.tabId);
          targetTab?.port.postMessage({ kind: "event", subId: target.subId, topic, payload });
        }
      });
      fanout = { real, targets: new Map() };
      this.topics.set(topic, fanout);
    }
    fanout.targets.set(targetKey(tabId, subId), { tabId, subId });
  }

  private handleUnsub(tabId: number, tab: TabState, subId: string): void {
    const topic = tab.subs.get(subId);
    if (topic === undefined) return;
    tab.subs.delete(subId);
    const fanout = this.topics.get(topic);
    if (!fanout) return;
    fanout.targets.delete(targetKey(tabId, subId));
    if (fanout.targets.size === 0) {
      this.topics.delete(topic);
      void fanout.real.unsubscribe();
    }
  }

  private async handleReq(tab: TabState, msg: Extract<PortRequest, { kind: "req" }>): Promise<void> {
    if (!this.client) return;
    try {
      const payload = await this.client.request(msg.topic, msg.payload, { timeoutMs: msg.timeoutMs });
      tab.port.postMessage({ kind: "res", reqId: msg.reqId, ok: true, payload });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      tab.port.postMessage({
        kind: "res",
        reqId: msg.reqId,
        ok: false,
        error: { code: e.code ?? "INTERNAL", message: e.message ?? String(err) },
      });
    }
  }
}
