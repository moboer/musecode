import type { BaseStationClient, ClientState, StateChangeInfo } from "@basestation/client";

const STATE_LABEL: Record<ClientState, string> = {
  idle: "未连接",
  connecting: "连接中",
  connected: "已连接",
  degraded: "降级轮询",
  reconnecting: "重连中",
  closed: "已断开",
};

const TRANSPORT_LABEL = {
  ws: "WebSocket",
  poll: "HTTP 轮询",
} as const;

/**
 * 连接控制面板：只负责展示状态与触发连接生命周期。
 * 订阅与业务消息全部由其他组件自己管理，这里不碰。
 */
export function mountConnectionPanel(root: HTMLElement, bs: BaseStationClient): void {
  root.innerHTML = `
    <div class="conn-bar">
      <span class="dot" data-dot data-state="idle"></span>
      <span class="conn-state" data-state-label>未连接</span>
      <span class="conn-meta" data-transport>传输 --</span>
      <span class="conn-meta" data-session>会话 --</span>
      <label class="conn-select">初始传输
        <select data-transport-select>
          <option value="auto">自动（先 WS）</option>
          <option value="ws">仅 WebSocket</option>
          <option value="poll">仅长轮询</option>
        </select>
      </label>
      <button class="primary" data-action="connect">连接</button>
      <button data-action="disconnect">断开</button>
      <button class="ghost" data-action="degrade">强制降级 WS</button>
    </div>
    <div class="conn-reason" data-reason>页面级单例：全页共享这一条连接</div>
  `;

  const transportSelect = query<HTMLSelectElement>(root, "[data-transport-select]");
  transportSelect.value = localStorage.getItem("bs-demo-transport") ?? "auto";
  transportSelect.addEventListener("change", () => {
    localStorage.setItem("bs-demo-transport", transportSelect.value);
    location.reload();
  });

  const dot = query<HTMLSpanElement>(root, "[data-dot]");
  const stateLabel = query<HTMLElement>(root, "[data-state-label]");
  const transportLabel = query<HTMLElement>(root, "[data-transport]");
  const sessionLabel = query<HTMLElement>(root, "[data-session]");
  const reasonLabel = query<HTMLElement>(root, "[data-reason]");
  const connectBtn = query<HTMLButtonElement>(root, '[data-action="connect"]');
  const disconnectBtn = query<HTMLButtonElement>(root, '[data-action="disconnect"]');
  const degradeBtn = query<HTMLButtonElement>(root, '[data-action="degrade"]');

  const render = (info?: StateChangeInfo) => {
    const state = bs.state;
    dot.dataset.state = state;
    stateLabel.textContent = STATE_LABEL[state];
    transportLabel.textContent = bs.transportKind ? `传输 ${TRANSPORT_LABEL[bs.transportKind]}` : "传输 --";
    sessionLabel.textContent = bs.sessionId ? `会话 ${bs.sessionId.slice(0, 8)}` : "会话 --";
    if (info?.reason) reasonLabel.textContent = `状态变化：${info.previous} → ${info.state}（${info.reason}）`;

    const busy = state === "connected" || state === "connecting" || state === "degraded";
    connectBtn.disabled = busy;
    disconnectBtn.disabled = state === "idle" || state === "closed";
    degradeBtn.disabled = bs.transportKind !== "ws";
  };

  bs.onStateChange((_state, info) => render(info));
  render();

  connectBtn.addEventListener("click", () => {
    connectBtn.disabled = true;
    void bs.connect().catch((err: unknown) => {
      reasonLabel.textContent = `连接失败：${describe(err)}`;
      render();
    });
  });

  disconnectBtn.addEventListener("click", () => {
    void bs.disconnect().catch((err: unknown) => {
      reasonLabel.textContent = `断开失败：${describe(err)}`;
    });
  });

  degradeBtn.addEventListener("click", () => {
    // 主动断开 WS 并降级到轮询，15s 内不再尝试升级回 WS。
    bs.forceDegrade(15_000);
    reasonLabel.textContent = "已主动断开 WS，15s 内不尝试升级（观察轮询续接）";
    render();
  });
}

function query<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`connection-panel: missing ${selector}`);
  return el;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
