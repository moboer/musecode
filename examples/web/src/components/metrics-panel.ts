import type { IBaseStationClient, Subscription } from "@basestation/client";

interface MetricPayload {
  value: number;
  unit?: string;
  series?: string;
  serverTs?: number;
}

type Series = "cpu" | "mem";

/**
 * 指标面板：只订阅 metrics.*，只处理 cpu / mem 两个序列。
 * 公告、请求响应等帧根本不会进入这个组件的监听器。
 */
export function mountMetricsPanel(root: HTMLElement, bs: IBaseStationClient): void {
  root.innerHTML = `
    <div class="panel-head">
      <h2>实时指标 <span class="badge">metrics.*</span></h2>
      <div class="actions">
        <button data-action="toggle">取消订阅</button>
      </div>
    </div>
    <p class="hint">本组件只监听 metrics.cpu 与 metrics.mem；news.notice、echo 的响应都不会投递到这里。</p>

    <div class="metric">
      <div class="metric-top">
        <span class="metric-label">CPU 使用率</span>
        <span class="metric-value"><span data-value="cpu">--</span><small>%</small></span>
      </div>
      <div class="track"><div class="fill" data-series="cpu" data-fill="cpu"></div></div>
    </div>

    <div class="metric">
      <div class="metric-top">
        <span class="metric-label">内存使用率</span>
        <span class="metric-value"><span data-value="mem">--</span><small>%</small></span>
      </div>
      <div class="track"><div class="fill" data-series="mem" data-fill="mem"></div></div>
    </div>

    <div class="status-line" data-status>等待连接…</div>
  `;

  const cpuValue = query(root, '[data-value="cpu"]');
  const memValue = query(root, '[data-value="mem"]');
  const cpuFill = query(root, '[data-fill="cpu"]');
  const memFill = query(root, '[data-fill="mem"]');
  const status = query(root, "[data-status]");
  const toggleBtn = query<HTMLButtonElement>(root, '[data-action="toggle"]');

  let subscription: Subscription | null = null;
  let frames = 0;

  const render = (series: Series, payload: MetricPayload) => {
    const value = typeof payload.value === "number" ? payload.value : Number(payload.value ?? 0);
    const text = Number.isFinite(value) ? value.toFixed(1) : "--";
    const fill = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
    if (series === "cpu") {
      cpuValue.textContent = text;
      cpuFill.style.width = `${fill}%`;
    } else {
      memValue.textContent = text;
      memFill.style.width = `${fill}%`;
    }
    frames += 1;
    status.textContent = `已收 ${frames} 帧 · 最近 ${formatTime(payload.serverTs)}`;
  };

  const subscribe = () => {
    if (subscription) return;
    subscription = bs.subscribe<MetricPayload>(
      "metrics.*",
      (payload) => {
        if (payload.series === "cpu") render("cpu", payload);
        else if (payload.series === "mem") render("mem", payload);
      },
      {
        // 监听器内部异常只影响本订阅，不会波及其他组件与连接。
        onError: (err) => {
          status.textContent = `监听器异常（已隔离）：${String(err)}`;
        },
      },
    );
    toggleBtn.textContent = "取消订阅";
    status.textContent = "已订阅 metrics.*，等待推送…";
  };

  const unsubscribe = async () => {
    const current = subscription;
    subscription = null;
    toggleBtn.disabled = true;
    try {
      await current?.unsubscribe();
      status.textContent = "已取消订阅 metrics.*（其他组件不受影响）";
    } finally {
      toggleBtn.disabled = false;
      toggleBtn.textContent = "重新订阅";
    }
  };

  toggleBtn.addEventListener("click", () => {
    if (subscription) void unsubscribe();
    else subscribe();
  });

  subscribe();
}

function query<T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`metrics-panel: missing ${selector}`);
  return el;
}

function formatTime(ts?: number): string {
  if (typeof ts !== "number") return "--";
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}
