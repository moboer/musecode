/**
 * CoreHost：core 的宿主接口（方案 v2 §4.1，v2.0-a 预留）。
 *
 * core 的全部环境依赖——定时器、时钟、存储、WebSocket、fetch——只经这个接口注入，
 * core 本体不直接引用 window / document / 全局存储。这样将来把 core 搬进
 * SharedWorker（v2.0-c 的 SharedWorkerHost）时只是换宿主，不用改 core。
 * 纪律由根目录 `npm run check:host` 守住（scripts/check-core-host.mjs）。
 */
export interface HostStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface CoreHost {
  setTimeout(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(id: ReturnType<typeof setTimeout> | null | undefined): void;
  setInterval(cb: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(id: ReturnType<typeof setInterval> | null | undefined): void;
  /** 当前毫秒时间戳 */
  now(): number;
  /** 会话持久化存储；宿主没有存储时为 null */
  storage: HostStorage | null;
  /** WebSocket 构造器 */
  WebSocket: typeof WebSocket;
  fetch: typeof fetch;
  /**
   * 宿主所在源（协议+主机+端口），供重连前的网络段试探使用——它证明的是
   * “到这台主机的网络路径活着”，与基站进程无关。宿主无法提供时为 null，
   * 试探会跳过网络段、只探服务段。
   */
  origin?: string | null;
}

/**
 * 浏览器主线程宿主（当前默认）。所有成员都在调用时才取全局对象，
 * 不在模块加载时捕获，方便测试用假定时器替换全局实现。
 * 存储沿用既有语义：localStorage（隐私模式等异常场景内部吞掉，返回 null / 无操作）。
 */
export const browserHost: CoreHost = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id ?? undefined),
  setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
  clearInterval: (id) => globalThis.clearInterval(id ?? undefined),
  now: () => Date.now(),
  storage: {
    getItem: (key) => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // 隐私模式等场景下忽略
      }
    },
    removeItem: (key) => {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        // 忽略
      }
    },
  },
  get WebSocket() {
    return globalThis.WebSocket;
  },
  fetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  get origin() {
    try {
      return globalThis.location?.origin ?? null;
    } catch {
      return null;
    }
  },
};
