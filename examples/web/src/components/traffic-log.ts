import type { IBaseStationClient } from "@basestation/client";
import type { Message } from "@basestation/protocol";

const MAX_ROWS = 80;

/**
 * 流量日志：通过 onTraffic 旁路观测整条连接的全部收发帧。
 * 这是纯本地观测接口，不会向服务端额外订阅任何主题。
 */
export function mountTrafficLog(root: HTMLElement, bs: IBaseStationClient): void {
  root.innerHTML = `
    <div class="panel-head">
      <h2>通信流量 <span class="badge">onTraffic</span></h2>
      <div class="log-toolbar">
        <span data-count>共 0 帧</span>
        <button data-action="toggle">暂停</button>
        <button class="ghost" data-action="clear">清空</button>
      </div>
    </div>
    <p class="hint">这里能看到整条连接的全部帧；各业务组件仍然只拿到自己订阅的那一部分，二者互不影响。</p>
    <div class="log-list" data-list></div>
  `;

  const list = query(root, "[data-list]");
  const count = query(root, "[data-count]");
  const toggleBtn = query<HTMLButtonElement>(root, '[data-action="toggle"]');
  const clearBtn = query<HTMLButtonElement>(root, '[data-action="clear"]');

  let paused = false;
  let total = 0;
  let missed = 0;

  const updateCount = () => {
    const suffix = paused && missed > 0 ? ` · 暂停期间积压 ${missed} 帧` : "";
    count.textContent = `共 ${total} 帧${suffix}`;
  };

  const addRow = (msg: Message, dir: "in" | "out") => {
    const row = document.createElement("div");
    row.className = "log-row";
    row.dataset.dir = dir;

    row.append(
      cell("log-dir", dir === "in" ? "↓ 入站" : "↑ 出站"),
      cell("log-type", msg.type),
      cell("log-topic", msg.topic ?? "—"),
      cell("log-preview", preview(msg)),
      cell("log-time", new Date(msg.ts).toLocaleTimeString("zh-CN", { hour12: false })),
      cell("log-seq", msg.seq ? `#${msg.seq}` : "—"),
      cell("log-id", msg.id.slice(0, 8)),
    );
    row.children[1].setAttribute("data-type", msg.type);

    list.prepend(row);
    while (list.childElementCount > MAX_ROWS) list.lastElementChild?.remove();
  };

  bs.onTraffic((msg, dir) => {
    total += 1;
    if (paused) {
      missed += 1;
      updateCount();
      return;
    }
    addRow(msg, dir);
    updateCount();
  });

  toggleBtn.addEventListener("click", () => {
    paused = !paused;
    toggleBtn.textContent = paused ? "继续" : "暂停";
    if (!paused) missed = 0;
    updateCount();
  });

  clearBtn.addEventListener("click", () => {
    list.innerHTML = "";
    total = 0;
    missed = 0;
    updateCount();
  });

  updateCount();
}

function cell(className: string, text: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

function preview(msg: Message): string {
  if (msg.error) return `${msg.error.code}: ${msg.error.message}`;
  let text: string;
  try {
    text = JSON.stringify(msg.payload);
  } catch {
    text = String(msg.payload);
  }
  return text.length > 88 ? `${text.slice(0, 88)}…` : text;
}

function query<T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`traffic-log: missing ${selector}`);
  return el;
}
