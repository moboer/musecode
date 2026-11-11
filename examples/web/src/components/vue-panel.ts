import { createApp, h, ref } from "vue";
import type { IBaseStationClient } from "@basestation/client";
import { createBaseStationPlugin, useSubscription } from "@basestation/vue";

/**
 * Vue 绑定面板：插件注入页面单例（不另建连接），
 * useSubscription 订阅 metrics.mem，数值实时刷新。
 */
export function mountVuePanel(root: HTMLElement, client: IBaseStationClient): void {
  root.innerHTML = `
    <div class="panel-head"><h2>Vue 绑定 <span class="badge">@basestation/vue</span></h2></div>
    <p class="hint">createBaseStationPlugin 注入的是页面单例（client 选项），
    useSubscription 随组件挂载/卸载自动订阅退订，不另开连接。</p>
    <div data-vue-root></div>`;

  const MemView = {
    setup() {
      const value = ref("--");
      useSubscription<{ value: number }>("metrics.mem", (payload) => {
        value.value = String(payload.value);
      });
      return () =>
        h("p", { class: "framework-value" }, [
          "内存使用率：",
          h("strong", { "data-vue-value": "" }, value.value),
          "%",
        ]);
    },
  };

  const mountPoint = root.querySelector<HTMLElement>("[data-vue-root]")!;
  createApp(MemView).use(createBaseStationPlugin({ client })).mount(mountPoint);
}
