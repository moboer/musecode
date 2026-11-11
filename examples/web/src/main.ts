import { getBaseStation, initBaseStation } from "@basestation/client";

import { mountConnectionPanel } from "./components/connection-panel";
import { mountMetricsPanel } from "./components/metrics-panel";
import { mountNewsPanel } from "./components/news-panel";
import { mountRequestPanel } from "./components/request-panel";
import { mountTrafficLog } from "./components/traffic-log";
import "./style.css";

const debugLogs: string[] = [];
(globalThis as unknown as { __bsLogs: string[] }).__bsLogs = debugLogs;

/**
 * 全页唯一的连接在这里创建一次，之后所有组件都通过 getBaseStation()
 * 拿到同一个实例 —— 组件之间不会、也不能各自建连。
 */
const client = initBaseStation({
  url: window.location.origin,
  transport: "auto",
  requestTimeoutMs: 5000,
  logger: (level, event, meta) => {
    const line = `[basestation] ${event}${meta ? ` ${safeJson(meta)}` : ""}`;
    debugLogs.push(line);
    if (debugLogs.length > 200) debugLogs.shift();
    if (level === "debug") return;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
  },
});

const bs = getBaseStation();

mountConnectionPanel(requireMount("#connection-panel"), client);
mountRequestPanel(requireMount("#request-panel"), bs);
mountMetricsPanel(requireMount("#metrics-panel"), bs);
mountNewsPanel(requireMount("#news-panel"), bs);
mountTrafficLog(requireMount("#traffic-log"), bs);

void client.connect().catch((err: unknown) => {
  console.error("[demo] 连接基站失败", err);
});

function requireMount(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing mount point: ${selector}`);
  return el;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
