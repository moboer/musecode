import { RequestError, TimeoutError } from "@basestation/client";
import type { IBaseStationClient, RequestOptions } from "@basestation/client";

/**
 * 请求面板：通过统一的 request 接口与基站交互。
 * 组件只关心 topic 与 payload，不知道底层是 WS 还是轮询、也不管重试细节。
 */
export function mountRequestPanel(root: HTMLElement, bs: IBaseStationClient): void {
  root.innerHTML = `
    <div class="panel-head">
      <h2>请求 / 响应 <span class="badge">req → res</span></h2>
    </div>
    <p class="hint">收到的响应只会回到发起请求的这个 Promise，不会广播给其他组件。</p>
    <div class="request-form">
      <input type="text" data-input value="hello base station" />
      <button class="primary" data-action="echo">echo</button>
    </div>
    <div class="actions">
      <button data-action="slow">slow.echo（超时重试）</button>
      <button class="danger" data-action="boom">boom（业务错误）</button>
      <button data-action="info">system.info</button>
    </div>
    <pre class="result" data-result>尚未发起请求。</pre>
    <div class="inline-log" data-log></div>
  `;

  const input = query<HTMLInputElement>(root, "[data-input]");
  const result = query<HTMLPreElement>(root, "[data-result]");
  const log = query(root, "[data-log]");
  const buttons = [...root.querySelectorAll<HTMLButtonElement>("button[data-action]")];

  const setBusy = (busy: boolean) => {
    for (const button of buttons) button.disabled = busy;
  };

  const appendLog = (text: string, ok: boolean) => {
    const line = document.createElement("span");
    line.dataset.ok = String(ok);
    line.textContent = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })}  ${text}`;
    log.prepend(line);
    while (log.childElementCount > 6) log.lastElementChild?.remove();
  };

  const run = async (label: string, topic: string, payload: unknown, opts?: RequestOptions) => {
    const started = performance.now();
    setBusy(true);
    result.dataset.ok = "true";
    result.textContent = `${label} → ${topic} 请求中…`;
    try {
      const data = await bs.request(topic, payload, opts);
      const elapsed = Math.round(performance.now() - started);
      result.dataset.ok = "true";
      result.textContent = `${label} → ${topic} ✓ ${elapsed}ms\n\n${pretty(data)}`;
      appendLog(`${label} 成功 ${elapsed}ms`, true);
    } catch (err) {
      const elapsed = Math.round(performance.now() - started);
      result.dataset.ok = "false";
      result.textContent = `${label} → ${topic} ✗ ${elapsed}ms\n\n${formatError(err)}`;
      appendLog(`${label} 失败 ${elapsed}ms`, false);
    } finally {
      setBusy(false);
    }
  };

  const echoPayload = () => ({ text: input.value, at: Date.now() });

  root.querySelector('[data-action="echo"]')?.addEventListener("click", () => {
    void run("echo", "echo", echoPayload());
  });

  root.querySelector('[data-action="slow"]')?.addEventListener("click", () => {
    // 服务端固定耗时 2s；客户端 1s 超时并在 200ms 后用同一个 id 重试。
    void run("slow.echo", "slow.echo", echoPayload(), { timeoutMs: 1000, retries: 1, retryDelayMs: 200 });
  });

  root.querySelector('[data-action="boom"]')?.addEventListener("click", () => {
    void run("boom", "boom", {});
  });

  root.querySelector('[data-action="info"]')?.addEventListener("click", () => {
    void run("system.info", "system.info", {});
  });
}

function query<T extends HTMLElement = HTMLElement>(root: HTMLElement, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`request-panel: missing ${selector}`);
  return el;
}

function pretty(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatError(err: unknown): string {
  if (err instanceof RequestError) {
    return [
      `RequestError [${err.code}]`,
      err.message,
      `retryable: ${err.retryable}`,
      err.details === undefined ? "" : `details: ${pretty(err.details)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (err instanceof TimeoutError) {
    return [`TimeoutError [${err.code}]`, err.message, `retryable: ${err.retryable}`].join("\n");
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
