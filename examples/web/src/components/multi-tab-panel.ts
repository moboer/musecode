import { createBestClient } from "@basestation/client";
import type { IBaseStationClient } from "@basestation/client";

/**
 * 多标签面板（SharedWorker）：本页订阅经 worker 的全浏览器唯一连接代收。
 * 面板实时显示 :8080 的服务端会话数，点"新开一个标签页"后观察：
 * 会话数只增加本页自有的那部分（单例 + Web Component），worker 那份不增。
 */
export function mountMultiTabPanel(root: HTMLElement): void {
  let worker: SharedWorker | undefined;
  if (typeof SharedWorker !== "undefined") {
    try {
      worker = new SharedWorker(new URL("../sw-entry.ts", import.meta.url), {
        type: "module",
        name: "basestation",
      });
    } catch {
      worker = undefined;
    }
  }
  const shared = worker !== undefined;
  root.innerHTML = `
    <div class="panel-head"><h2>多标签单连接 <span class="badge">SharedWorker 宿主</span></h2></div>
    <p class="hint">${shared
      ? "下面这份订阅不在本页连接上：它经 SharedWorker 由全浏览器唯一连接代收。"
      : "当前浏览器不支持 SharedWorker，已自动降级为页面内普通客户端。"}</p>
    <p class="sw-status" data-sw-status>正在连接…</p>
    <p class="sw-value">内存最新值：<strong data-sw-value>--</strong></p>
    <p class="sw-value">服务端会话数（:8080）：<strong data-sw-sessions>--</strong></p>
    <div class="actions">
      <button data-open-tab>新开一个标签页</button>
    </div>
    <p class="hint">新标签里同样有主单例与 Web Component 各一条会话，但 SharedWorker 那份全浏览器共享：
    会话数只 +2 而不是 +3，就是多标签单连接在起作用。</p>`;

  const status = root.querySelector<HTMLElement>("[data-sw-status]")!;
  const value = root.querySelector<HTMLElement>("[data-sw-value]")!;
  const sessions = root.querySelector<HTMLElement>("[data-sw-sessions]")!;
  root.querySelector<HTMLButtonElement>("[data-open-tab]")!.addEventListener("click", () => {
    window.open(window.location.href, "_blank");
  });

  const pollSessions = async () => {
    try {
      const health = (await fetch("/api/health").then((r) => r.json())) as { sessions: number };
      sessions.textContent = String(health.sessions);
    } catch {
      sessions.textContent = "--";
    }
  };
  void pollSessions();
  setInterval(() => void pollSessions(), 3000);

  const client: IBaseStationClient & { connect(): Promise<void> } = createBestClient({
    url: window.location.origin,
    worker,
  });
  client.onStateChange((state) => {
    status.textContent = shared
      ? `模式：SharedWorker 宿主 · 状态：${state}（连接在 worker 里，本页只是订阅方）`
      : `模式：降级（页面内客户端） · 状态：${state}`;
  });
  client.subscribe<{ value: number }>("metrics.mem", (payload) => {
    value.textContent = `${payload.value}%`;
  });
  void client.connect().catch((err: unknown) => {
    status.textContent = `连接失败：${String(err)}`;
  });
}
