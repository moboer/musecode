import type { BaseStationClient } from "@basestation/client";

/**
 * 会话面板：实时展示主单例的连接状态时间线与服务端 health。
 * 用来亲眼验证"断开→重连→续接"时 sessionId 是否保持、服务端到底有几个会话。
 */
export function mountSessionPanel(root: HTMLElement, bs: BaseStationClient): void {
  root.innerHTML = `
    <div class="panel-head"><h2>会话与状态时间线 <span class="badge">onStateChange + /api/health</span></h2></div>
    <p class="hint">每次状态变化都记一行。断开再连接、或强制降级后续接成功时，
    sessionId 应当保持不变（订阅与队列都在服务端会话里）。</p>
    <div class="session-facts">
      <div>当前状态：<strong data-fact="state">--</strong></div>
      <div>传输：<strong data-fact="transport">--</strong></div>
      <div>会话 ID：<strong data-fact="session">--</strong></div>
      <div>服务端会话数：<strong data-fact="sessions">--</strong></div>
      <div>服务端累计丢帧：<strong data-fact="dropped">--</strong></div>
      <div>服务端鉴权模式：<strong data-fact="authMode">--</strong></div>
    </div>
    <ol class="timeline" data-timeline></ol>`;

  const fact = (name: string) => root.querySelector<HTMLElement>(`[data-fact="${name}"]`)!;
  const timeline = root.querySelector<HTMLElement>("[data-timeline]")!;
  const stamp = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

  const renderFacts = () => {
    fact("state").textContent = bs.state;
    fact("transport").textContent = bs.transportKind ?? "--";
    fact("session").textContent = bs.sessionId ?? "--";
  };
  bs.onStateChange((state, info) => {
    renderFacts();
    const li = document.createElement("li");
    li.textContent = `${stamp()}  ${info.previous} → ${state}（${info.reason}）· 传输 ${bs.transportKind ?? "--"} · 会话 ${bs.sessionId?.slice(0, 8) ?? "--"}…`;
    timeline.prepend(li);
    while (timeline.children.length > 12) timeline.lastElementChild?.remove();
  });
  renderFacts();

  const pollHealth = async () => {
    try {
      const health = (await fetch("/api/health").then((r) => r.json())) as {
        sessions: number;
        droppedTotal: number;
        authMode: string;
      };
      fact("sessions").textContent = String(health.sessions);
      fact("dropped").textContent = String(health.droppedTotal);
      fact("authMode").textContent = health.authMode;
    } catch {
      fact("sessions").textContent = "（基站未启动）";
    }
  };
  void pollHealth();
  setInterval(() => void pollHealth(), 3000);
}
