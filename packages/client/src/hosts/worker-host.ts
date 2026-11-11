/**
 * Worker 宿主：core 跑在 SharedWorker 里时用的 CoreHost 实现（与 host.ts 的 browserHost 并列，
 * 同为宿主实现文件，是 check:host 纪律的豁免名单成员）。
 *
 * 与主线程宿主的差异：Worker 里没有 localStorage，storage 为 null——
 * 会话 id 不落盘，worker 重启后重新建会话（服务端 Session 有宽限续接，影响可控）。
 */
import type { CoreHost } from "../host.js";

export const workerHost: CoreHost = {
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id ?? undefined),
  setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
  clearInterval: (id) => globalThis.clearInterval(id ?? undefined),
  now: () => Date.now(),
  storage: null,
  WebSocket: globalThis.WebSocket,
  fetch: (input, init) => globalThis.fetch(input, init),
};
