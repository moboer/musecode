import { TOPIC_META } from "@basestation/protocol";
import { defineBaseStationComponents } from "@basestation/component";

/**
 * 标准组件展台之二：注册表面板（渲染生成代码里的 TOPIC_META）
 * 与 Web Component 面板（两个 HTML 标签直接订阅实时数据）。
 * React / Vue / SharedWorker 面板在各自的组件文件里。
 */

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
    bs-message 事件会同步打到下方日志。</p>
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
