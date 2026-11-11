import type { IBaseStationClient, Subscription } from "@basestation/client";

interface NewsPayload {
  noticeId: number;
  level?: string;
  title: string;
  publishedAt?: number;
}

/**
 * 公告面板：只订阅 news.notice。
 * 即使 metrics.* 每秒都有帧，这里也一帧都不会收到。
 */
export function mountNewsPanel(root: HTMLElement, bs: IBaseStationClient): void {
  root.innerHTML = `
    <div class="panel-head">
      <h2>公告推送 <span class="badge">news.notice</span></h2>
      <div class="actions">
        <button data-action="once">一次性监听</button>
        <button data-action="toggle">取消订阅</button>
      </div>
    </div>
    <p class="hint">只渲染 news.notice；指标帧不会进入本组件。一次性监听命中后自动注销。</p>
    <div class="news-list" data-list>
      <div class="news-empty">订阅中，等待下一条公告…</div>
    </div>
    <div class="status-line" data-status>已订阅 news.notice</div>
  `;

  const list = query(root, "[data-list]");
  const status = query(root, "[data-status]");
  const onceBtn = query<HTMLButtonElement>(root, '[data-action="once"]');
  const toggleBtn = query<HTMLButtonElement>(root, '[data-action="toggle"]');

  let subscription: Subscription | null = null;
  let frames = 0;
  const items: NewsPayload[] = [];

  const renderList = () => {
    list.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "news-empty";
      empty.textContent = "订阅中，等待下一条公告…";
      list.append(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "news-item";

      const id = document.createElement("span");
      id.className = "news-id";
      id.textContent = `#${item.noticeId}`;

      const title = document.createElement("span");
      title.className = "news-title";
      title.textContent = item.title;

      const time = document.createElement("span");
      time.className = "news-time";
      time.textContent = item.publishedAt
        ? new Date(item.publishedAt).toLocaleTimeString("zh-CN", { hour12: false })
        : "--";

      row.append(id, title, time);
      list.append(row);
    }
  };

  const subscribe = () => {
    if (subscription) return;
    subscription = bs.subscribe<NewsPayload>(
      "news.notice",
      (payload) => {
        frames += 1;
        items.unshift(payload);
        items.length = Math.min(items.length, 4);
        renderList();
        status.textContent = `已收 ${frames} 条公告`;
      },
      { onError: (err) => (status.textContent = `监听器异常（已隔离）：${String(err)}`) },
    );
    toggleBtn.textContent = "取消订阅";
  };

  const unsubscribe = async () => {
    const current = subscription;
    subscription = null;
    toggleBtn.disabled = true;
    try {
      await current?.unsubscribe();
      status.textContent = "已取消订阅 news.notice（其他组件不受影响）";
    } finally {
      toggleBtn.disabled = false;
      toggleBtn.textContent = "重新订阅";
    }
  };

  toggleBtn.addEventListener("click", () => {
    if (subscription) void unsubscribe();
    else subscribe();
  });

  onceBtn.addEventListener("click", () => {
    onceBtn.disabled = true;
    status.textContent = "一次性监听已注册，等待下一条公告（最多 12s）…";
    bs.once<NewsPayload>("news.notice", { timeoutMs: 12_000 })
      .then((msg) => {
        status.textContent = `once 命中 #${msg.payload.noticeId}「${msg.payload.title}」，监听器已自动注销`;
      })
      .catch((err: unknown) => {
        status.textContent = `once 未命中：${err instanceof Error ? err.message : String(err)}`;
      })
      .finally(() => {
        onceBtn.disabled = false;
      });
  });

  subscribe();
}

function query<T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`news-panel: missing ${selector}`);
  return el;
}
