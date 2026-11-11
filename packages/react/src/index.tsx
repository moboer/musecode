/**
 * @basestation/react —— React 薄绑定（方案 v2 §5.1 L3）。
 * 只做框架惯用法的桥：Provider 管连接生命周期，hooks 管订阅生命周期；
 * 机制全在 @basestation/client，绑定层不复制任何逻辑。
 */
import { BaseStationClient } from "@basestation/client";
import type { BaseStationOptions, ClientState, IBaseStationClient } from "@basestation/client";
import type { Message } from "@basestation/protocol";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

const BaseStationContext = createContext<IBaseStationClient | null>(null);

export interface BaseStationProviderProps {
  /** 服务端地址（与 client 二选一） */
  url?: string;
  token?: string;
  tokenProvider?: BaseStationOptions["tokenProvider"];
  /** 其余客户端选项（与 url 一起用） */
  options?: Omit<BaseStationOptions, "url" | "token" | "tokenProvider">;
  /** 直接注入现成客户端（测试/高级场景）；注入时 Provider 不负责其连接生命周期 */
  client?: IBaseStationClient;
  children: ReactNode;
}

export function BaseStationProvider(props: BaseStationProviderProps): ReactNode {
  const { client: injected, url, token, tokenProvider, options, children } = props;

  const ownClient = useMemo<BaseStationClient | null>(() => {
    if (injected) return null;
    if (!url) throw new Error("<BaseStationProvider> requires either `client` or `url`");
    return new BaseStationClient({ ...options, url, token, tokenProvider });
    // 选项以首挂载为准：连接是重资产，不随渲染重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ownClient) return;
    void ownClient.connect().catch(() => {
      // 连接失败由客户端内部重连机制处理；状态经 useBaseStationState 观察
    });
    return () => {
      void ownClient.disconnect();
    };
  }, [ownClient]);

  const value = injected ?? ownClient;
  return <BaseStationContext.Provider value={value}>{children}</BaseStationContext.Provider>;
}

/** 取当前基站客户端；不在 Provider 内会抛错（早失败胜过静默无消息）。 */
export function useBaseStation(): IBaseStationClient {
  const client = useContext(BaseStationContext);
  if (!client) throw new Error("useBaseStation must be used within <BaseStationProvider>");
  return client;
}

/**
 * 订阅主题：组件挂载时订阅、卸载时退订、topic 变化时换订。
 * handler 用 ref 持有最新引用，handler 每次渲染换新函数不会导致重订阅。
 */
export function useSubscription<T = unknown>(topic: string, handler: (payload: T, msg: Message<T>) => void): void {
  const client = useBaseStation();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const subscription = client.subscribe<T>(topic, (payload, msg) => handlerRef.current(payload, msg));
    return () => {
      void subscription.unsubscribe();
    };
  }, [client, topic]);
}

/** 观察连接状态（状态变化时重渲染）。 */
export function useBaseStationState(): ClientState {
  const client = useBaseStation();
  const [state, setState] = useState<ClientState>(client.state);
  useEffect(() => client.onStateChange((next) => setState(next)), [client]);
  return state;
}
