/**
 * SharedWorker 入口 —— 部署时以独立脚本加载（构建产物 dist/hosts/worker-entry.js）。
 *
 * 它在 SharedWorker 里组装唯一真实客户端（workerHost）+ WorkerRouter：
 * 每个标签页 connect 进来一个 port，订阅做引用计数扇出，请求代答，
 * 每 5 秒回收心跳超时的标签订阅。这就是"同源多标签 = 一条后端连接"的落点。
 */
import { BaseStationClient } from "../client.js";
import { workerHost } from "./worker-host.js";
import { WorkerRouter } from "./worker-router.js";
import type { RouterClient } from "./worker-router.js";
import type { PortRequest } from "./worker-protocol.js";

interface SharedWorkerScope {
  onconnect: ((ev: { ports: MessagePort[] }) => void) | null;
  setInterval(cb: () => void, ms: number): number;
}

const scope = globalThis as unknown as SharedWorkerScope;

const router = new WorkerRouter({
  staleMs: 15000,
  clientFactory: (init) => {
    const client = new BaseStationClient({
      url: init.url,
      token: init.token,
      host: workerHost,
      sessionStorageKey: false,
    });
    void client.connect().catch(() => {
      // 连接失败由客户端内部重连处理
    });
    return client as unknown as RouterClient;
  },
});

scope.setInterval(() => router.pruneStale(), 5000);

scope.onconnect = (ev) => {
  const port = ev.ports[0];
  if (!port) return;
  const tabId = router.attach({
    postMessage: (data) => port.postMessage(data),
  });
  port.onmessage = (msgEv: MessageEvent<PortRequest>) => {
    router.handleMessage(tabId, msgEv.data);
  };
  port.start();
};
