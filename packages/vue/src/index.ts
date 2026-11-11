/**
 * @basestation/vue —— Vue 3 薄绑定（方案 v2 §5.1 L3）。
 * 插件管连接生命周期，composable 管订阅生命周期；机制全在 @basestation/client。
 */
import { BaseStationClient } from "@basestation/client";
import type { BaseStationOptions, ClientState, IBaseStationClient, Subscription } from "@basestation/client";
import type { Message } from "@basestation/protocol";
import { getCurrentInstance, inject, onMounted, onUnmounted, ref, unref, watch } from "vue";
import type { App, InjectionKey, Ref } from "vue";

const BaseStationKey: InjectionKey<IBaseStationClient> = Symbol("basestation");

export interface BaseStationPluginOptions extends Omit<BaseStationOptions, "url"> {
  url?: string;
  /** 直接注入现成客户端（测试/高级场景）；注入时插件不负责其连接生命周期 */
  client?: IBaseStationClient;
}

/** 创建 Vue 插件：app.use(createBaseStationPlugin({ url, token }))。 */
export function createBaseStationPlugin(options: BaseStationPluginOptions): { install(app: App): void } {
  return {
    install(app: App): void {
      if (options.client) {
        app.provide(BaseStationKey, options.client);
        return;
      }
      if (!options.url) throw new Error("createBaseStationPlugin requires either `client` or `url`");
      const { client: _ignored, ...clientOptions } = options;
      const client = new BaseStationClient({ ...clientOptions, url: options.url });
      app.provide(BaseStationKey, client);
      void client.connect().catch(() => {
        // 连接失败由客户端内部重连处理；状态经 useBaseStationState 观察
      });
      (app as { onUnmount?: (cb: () => void) => void }).onUnmount?.(() => client.disconnect());
    },
  };
}

/** 取当前基站客户端；未装插件会抛错（早失败胜过静默无消息）。 */
export function useBaseStation(): IBaseStationClient {
  const client = inject(BaseStationKey);
  if (!client) throw new Error("useBaseStation: base station plugin is not installed");
  return client;
}

/**
 * 订阅主题：挂载时订阅、卸载时退订；topic 传 Ref 时变化自动换订。
 * 不在组件 setup 内调用时立即订阅并返回停止函数。
 */
export function useSubscription<T = unknown>(
  topic: string | Ref<string>,
  handler: (payload: T, msg: Message<T>) => void,
): { stop: () => void } {
  const client = useBaseStation();
  let subscription: Subscription | null = null;

  const start = (): void => {
    subscription = client.subscribe<T>(unref(topic), handler);
  };
  const stop = (): void => {
    void subscription?.unsubscribe();
    subscription = null;
  };

  if (getCurrentInstance()) {
    onMounted(start);
    onUnmounted(stop);
    if (typeof topic !== "string") {
      watch(topic, () => {
        stop();
        start();
      });
    }
  } else {
    start();
  }
  return { stop };
}

/** 观察连接状态（响应式）。 */
export function useBaseStationState(): Ref<ClientState> {
  const client = useBaseStation();
  const state = ref<ClientState>(client.state) as Ref<ClientState>;
  let off: (() => void) | null = null;
  if (getCurrentInstance()) {
    onMounted(() => {
      off = client.onStateChange((next) => {
        state.value = next;
      });
    });
    onUnmounted(() => off?.());
  }
  return state;
}
