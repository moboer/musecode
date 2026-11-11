/**
 * 页面 ↔ SharedWorker 之间的 Port 协议（方案 v2 §4.1 SharedWorker 宿主）。
 * 页面侧 SharedWorkerClient 与 worker 侧 WorkerRouter 各实现一半，靠这组类型对齐。
 */
import type { ClientState } from "../types.js";

/** 页面 → worker */
export type PortRequest =
  | { kind: "init"; url: string; token?: string }
  | { kind: "sub"; subId: string; topic: string }
  | { kind: "unsub"; subId: string }
  | { kind: "req"; reqId: string; topic: string; payload: unknown; timeoutMs?: number }
  | { kind: "ping" }
  | { kind: "bye" };

/** worker → 页面 */
export type PortEvent =
  | { kind: "event"; subId: string; topic: string; payload: unknown }
  | { kind: "res"; reqId: string; ok: true; payload: unknown }
  | { kind: "res"; reqId: string; ok: false; error: { code: string; message: string } }
  | { kind: "state"; state: ClientState };
