import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IBaseStationClient } from "@basestation/client";
import { BaseStationProvider, useSubscription } from "@basestation/react";

/**
 * React 绑定面板：Provider 注入页面单例（不另建连接），
 * useSubscription 订阅 metrics.cpu，数值实时刷新。
 */
function CpuView() {
  const [value, setValue] = useState<string>("--");
  useSubscription<{ value: number }>("metrics.cpu", (payload) => setValue(String(payload.value)));
  return (
    <p className="framework-value">
      CPU 使用率：<strong data-react-value>{value}</strong>%
    </p>
  );
}

export function mountReactPanel(root: HTMLElement, client: IBaseStationClient): void {
  root.innerHTML = `
    <div class="panel-head"><h2>React 绑定 <span class="badge">@basestation/react</span></h2></div>
    <p class="hint">BaseStationProvider 注入的是页面单例（client 属性），
    useSubscription 随组件挂载/卸载自动订阅退订，不另开连接。</p>
    <div data-react-root></div>`;
  const mountPoint = root.querySelector<HTMLElement>("[data-react-root]")!;
  createRoot(mountPoint).render(
    <BaseStationProvider client={client}>
      <CpuView />
    </BaseStationProvider>,
  );
}
