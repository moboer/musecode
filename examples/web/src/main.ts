import { getBaseStation, initBaseStation } from "@basestation/client";
import type { TransportKind } from "@basestation/client";

import { mountAuthLab } from "./components/auth-lab";
import { mountConnectionPanel } from "./components/connection-panel";
import { mountMetricsPanel } from "./components/metrics-panel";
import { mountMultiTabPanel } from "./components/multi-tab-panel";
import { mountNewsPanel } from "./components/news-panel";
import { mountReactPanel } from "./components/react-panel";
import { mountRequestPanel } from "./components/request-panel";
import { mountSessionPanel } from "./components/session-panel";
import { mountComponentPanel, mountRegistryPanel } from "./components/showcase-panels";
import { mountTestBench } from "./components/test-runner";
import { mountTrafficLog } from "./components/traffic-log";
import { mountVuePanel } from "./components/vue-panel";
import type { TestCtx } from "./tests";
import "./style.css";

const debugLogs: string[] = [];
(globalThis as unknown as { __bsLogs: string[] }).__bsLogs = debugLogs;

const savedTransport = (localStorage.getItem("bs-demo-transport") ?? "auto") as
  | TransportKind
  | "auto";

/**
 * 全页唯一的连接在这里创建一次，之后所有组件都通过 getBaseStation()
 * 拿到同一个实例 —— 组件之间不会、也不能各自建连。
 * 初始传输可在连接面板切换（auto / ws / poll，切换后重载页面生效）。
 */
const client = initBaseStation({
  url: window.location.origin,
  transport: savedTransport,
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
const ctx: TestCtx = { bs: client, jwtBase: "http://localhost:8081" };

mountConnectionPanel(requireMount("#connection-panel"), client);
mountRequestPanel(requireMount("#request-panel"), bs);
mountMetricsPanel(requireMount("#metrics-panel"), bs);
mountNewsPanel(requireMount("#news-panel"), bs);
mountTrafficLog(requireMount("#traffic-log"), bs);
mountSessionPanel(requireMount("#session-panel"), client);
mountRegistryPanel(requireMount("#registry-panel"));
mountAuthLab(requireMount("#auth-lab"), ctx);
mountComponentPanel(requireMount("#component-panel"));
mountReactPanel(requireMount("#react-panel"), bs);
mountVuePanel(requireMount("#vue-panel"), bs);
mountMultiTabPanel(requireMount("#shared-panel"));
mountTestBench(ctx);

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
