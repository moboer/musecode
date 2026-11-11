import { BaseStationClient, createBestClient } from "@basestation/client";
import type { IBaseStationClient } from "@basestation/client";
import { TOPIC_META } from "@basestation/protocol";
import { defineBaseStationComponents } from "@basestation/component";

/**
 * v2.0 新能力展台：四个面板分别演示 c 阶段的注册表、Web Component、
 * b 阶段的鉴权五关、c 阶段的 SharedWorker 多标签单连接。
 * 鉴权面板连的是第二个基站实例（:8081，jwt 模式），其余面板用主连接（:8080）。
 */

const JWT_BASE = "http://localhost:8081";

/* ---------------- 注册表（v2.0-c） ---------------- */

export function mountRegistryPanel(root: HTMLElement): void {
  const rows = Object.entries(TOPIC_META)
    .map(
      ([name, meta]) =>
        `<tr><td><code>${name}</code></td><td>${meta.direction === "request" ? "请求-响应" : "事件"}</td>` +
        `<td>${meta.delivery}</td><td>${meta.retention}</td><td>v${meta.since}</td></tr>`,
    )
    .join("");
  root.innerHTML = `
    <div class="panel-head"><h2>Topic 注册表 <span class="badge">v2.0-c · 代码生成</span></h2></div>
    <p class="hint">这张表不是手写的：它直接渲染自 <code>registry/topics.json</code> 生成的前端代码
    （<code>TOPIC_META</code>）。同一份注册表还生成了服务端的 payload 校验表——改主题只改一处。</p>
    <table class="topic-table">
      <thead><tr><th>主题</th><th>方向</th><th>投递意图</th><th>保留</th><th>版本</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ---------------- Web Component（v2.0-c） ---------------- */

export function mountComponentPanel(root: HTMLElement): void {
  defineBaseStationComponents();
  root.innerHTML = `
    <div class="panel-head"><h2>Web Component <span class="badge">v2.0-c · 框架无关</span></h2></div>
    <p class="hint">下面这块不是 JS 订阅出来的，而是两个 HTML 标签：
    <code>&lt;base-station&gt;</code> + <code>&lt;bs-subscribe topic="metrics.cpu" show&gt;</code>，
    bs-message 事件会同步打到右侧日志。</p>
    <div class="wc-demo">
      <base-station url="${window.location.origin}">
        <div class="wc-value">CPU 最新值：<bs-subscribe topic="metrics.cpu" show>等待数据…</bs-subscribe></div>
      </base-station>
      <pre class="wc-log" data-wc-log></pre>
    </div>`;
  const log = root.querySelector<HTMLElement>("[data-wc-log]")!;
  const sub = root.querySelector("bs-subscribe")!;
  sub.addEventListener("bs-message", (ev) => {
    const detail = (ev as CustomEvent<{ payload: unknown }>).detail;
    log.textContent = `bs-message 到达：${JSON.stringify(detail.payload)}`;
  });
}

/* ---------------- 鉴权五关（v2.0-b） ---------------- */

export function mountAuthPanel(root: HTMLElement): void {
  root.innerHTML = `
    <div class="panel-head"><h2>鉴权五关 <span class="badge">v2.0-b · jwt :8081</span></h2></div>
    <p class="hint">本面板连第二个基站（jwt 模式）。流程：换一张"访客"令牌（只能订 metrics.*、不能发请求）
    → 订指标（应成功）→ 发 echo 请求（应被 FORBIDDEN 拦下）。</p>
    <ol class="auth-steps" data-auth-steps>
      <li data-step="token">① 换取访客令牌 …</li>
      <li data-step="connect">② 带令牌建连 …</li>
      <li data-step="allowed">③ 订阅 metrics.cpu（权限内）…</li>
      <li data-step="denied">④ 请求 echo（权限外）…</li>
    </ol>`;
  const setStep = (name: string, text: string, ok: boolean): void => {
    const li = root.querySelector<HTMLElement>(`[data-step="${name}"]`)!;
    li.textContent = text;
    li.classList.add(ok ? "ok" : "fail");
  };
  void runAuthDemo(setStep);
}

async function runAuthDemo(setStep: (name: string, text: string, ok: boolean) => void): Promise<void> {
  try {
    const issued = (await fetch(`${JWT_BASE}/api/auth/dev-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sub: "guest",
        tenant: "demo",
        subscribe: ["metrics.*"],
        publish: [],
        ttlSeconds: 600,
      }),
    }).then((r) => r.json())) as { token?: string };
    if (!issued.token) throw new Error("dev-token 未开启或 :8081 未以 jwt 模式启动");
    setStep("token", "① 换取访客令牌 ✓（sub=guest，仅 sub_acl=metrics.*）", true);

    const guest = new BaseStationClient({ url: JWT_BASE, token: issued.token, sessionStorageKey: false });
    await guest.connect();
    setStep("connect", "② 带令牌建连 ✓（无令牌会被 401）", true);

    const firstValue = new Promise<string>((resolve) => {
      guest.subscribe<{ value: number }>("metrics.cpu", (payload) => resolve(String(payload.value)));
    });
    const value = await Promise.race([
      firstValue,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error("超时")), 6000)),
    ]);
    setStep("allowed", `③ 订阅 metrics.cpu ✓ 收到实时数据 value=${value}`, true);

    try {
      await guest.request("echo", { hi: 1 }, { timeoutMs: 3000, retries: 0 });
      setStep("denied", "④ 请求 echo ✗ 居然成功了（不应发生）", false);
    } catch (err) {
      const code = (err as { code?: string }).code ?? String(err);
      setStep("denied", `④ 请求 echo 被拦下 ✓ 错误码 ${code}（没进处理器，前端说了不算）`, code === "FORBIDDEN");
    }
    guest.disconnect();
  } catch (err) {
    setStep("token", `① 换取访客令牌 ✗ ${String(err)}（:8081 需以 -auth-mode=jwt -dev-token 启动）`, false);
  }
}

/* ---------------- SharedWorker 多标签（v2.0-c） ---------------- */

export function mountSharedWorkerPanel(root: HTMLElement): void {
  // 用打包器标准写法先把 SharedWorker 构造出来（Vite 会识别这个模式并单独打包 worker 脚本），
  // 再把实例交给 createBestClient——不要把裸 URL 字符串传进去让运行时自己找脚本。
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
    <div class="panel-head"><h2>SharedWorker 多标签 <span class="badge">v2.0-c</span></h2></div>
    <p class="hint">${shared
      ? "本页的这份订阅不在本页连接上：它经 SharedWorker 由全浏览器唯一连接代收。再开一个本页标签，服务端的 sessions 数不会因它增加。"
      : "当前浏览器不支持 SharedWorker，已自动降级为页面内普通客户端（功能不变，连接每页一条）。"}</p>
    <p class="sw-status" data-sw-status>正在连接…</p>
    <p class="sw-value">内存最新值：<strong data-sw-value>--</strong></p>`;

  const status = root.querySelector<HTMLElement>("[data-sw-status]")!;
  const value = root.querySelector<HTMLElement>("[data-sw-value]")!;
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
