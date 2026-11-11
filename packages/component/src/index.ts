/**
 * @basestation/component —— 标准组件层（方案 v2 §5.1 L3）：框架无关的 Web Component 外壳。
 *
 * 用法：
 *   <base-station url="http://localhost:8080" token="...">
 *     <bs-subscribe topic="metrics.cpu" show></bs-subscribe>
 *   </base-station>
 *
 * - <base-station> 负责连接生命周期：挂载建连、卸载断开；url/token 属性变化会重建连接。
 *   状态变化以冒泡的 `bs-state` 事件（detail: {state}）对外通知。
 * - <bs-subscribe> 找最近的 <base-station> 祖先并订阅其 topic 属性指定的主题；
 *   每条消息派发冒泡的 `bs-message` 事件（detail: {topic, payload, msg}），
 *   带 `show` 属性时把最新 payload 以 JSON 文本渲染进自身。
 *
 * React/Vue 里也可以直接使用这两个标签（属性即配置，事件即回调），
 * 或用 @basestation/react、@basestation/vue 的惯用绑定。
 */
import { BaseStationClient } from "@basestation/client";
import type { BaseStationOptions, ClientState, IBaseStationClient, Subscription } from "@basestation/client";
import type { Message } from "@basestation/protocol";

/** 元素实际依赖的客户端最小接口（便于替换实现与测试注入）。 */
export interface ComponentClient {
  readonly state: ClientState;
  connect(): Promise<void>;
  disconnect(): void;
  subscribe<T = unknown>(topic: string, handler: (payload: T, msg: Message<T>) => void): Subscription;
  onStateChange(cb: (state: ClientState) => void): () => void;
}

export type ClientFactory = (options: BaseStationOptions) => ComponentClient;

/** 测试/高级场景可替换客户端工厂；默认用真实 BaseStationClient。 */
export const componentInternals: { clientFactory: ClientFactory } = {
  clientFactory: (options) => new BaseStationClient(options),
};

export class BaseStationElement extends HTMLElement {
  static observedAttributes = ["url", "token"];

  private clientInstance: ComponentClient | null = null;
  private readyPromise: Promise<ComponentClient> | null = null;
  private offState: (() => void) | null = null;

  /** 当前客户端（连接中/已连接时非空）。 */
  get client(): ComponentClient | null {
    return this.clientInstance;
  }

  /** 等客户端建好（首次连接发起后即可拿到实例，订阅不依赖连接完成）。 */
  whenReady(): Promise<ComponentClient> {
    if (this.readyPromise) return this.readyPromise;
    return Promise.reject(new Error("<base-station> is not connected to the DOM yet"));
  }

  connectedCallback(): void {
    this.setup();
  }

  disconnectedCallback(): void {
    this.teardown();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) {
      this.teardown();
      this.setup();
    }
  }

  private setup(): void {
    const url = this.getAttribute("url");
    if (!url) {
      this.dispatchEvent(new CustomEvent("bs-error", { bubbles: true, detail: { message: "<base-station> requires a url attribute" } }));
      return;
    }
    const token = this.getAttribute("token") ?? undefined;
    const client = componentInternals.clientFactory({ url, token, sessionStorageKey: false });
    this.clientInstance = client;
    this.readyPromise = Promise.resolve(client);
    this.offState = client.onStateChange((state) => {
      this.dispatchEvent(new CustomEvent("bs-state", { bubbles: true, detail: { state } }));
    });
    void client.connect().catch((err: unknown) => {
      this.dispatchEvent(new CustomEvent("bs-error", { bubbles: true, detail: { message: String(err) } }));
    });
  }

  private teardown(): void {
    this.offState?.();
    this.offState = null;
    this.clientInstance?.disconnect();
    this.clientInstance = null;
    this.readyPromise = null;
  }
}

export class BsSubscribeElement extends HTMLElement {
  static observedAttributes = ["topic"];

  private subscription: Subscription | null = null;
  private generation = 0;

  connectedCallback(): void {
    void this.attach();
  }

  disconnectedCallback(): void {
    this.detach();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) {
      this.detach();
      void this.attach();
    }
  }

  private async attach(): Promise<void> {
    const topic = this.getAttribute("topic");
    if (!topic) return;
    const host = this.closest("base-station");
    if (!(host instanceof BaseStationElement)) {
      this.dispatchEvent(
        new CustomEvent("bs-error", { bubbles: true, detail: { message: "<bs-subscribe> must be inside <base-station>" } }),
      );
      return;
    }
    const gen = ++this.generation;
    const client = await host.whenReady();
    if (gen !== this.generation || !this.isConnected) return; // 期间已卸载/换主题
    this.subscription = client.subscribe(topic, (payload: unknown, msg: Message) => {
      if (this.hasAttribute("show")) {
        this.textContent = JSON.stringify(payload);
      }
      this.dispatchEvent(new CustomEvent("bs-message", { bubbles: true, detail: { topic, payload, msg } }));
    });
  }

  private detach(): void {
    this.generation++;
    void this.subscription?.unsubscribe();
    this.subscription = null;
  }
}

/** 注册两个标准元素（重复调用安全）。 */
export function defineBaseStationComponents(): void {
  if (!customElements.get("base-station")) {
    customElements.define("base-station", BaseStationElement);
  }
  if (!customElements.get("bs-subscribe")) {
    customElements.define("bs-subscribe", BsSubscribeElement);
  }
}
