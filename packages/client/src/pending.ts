import type { Message } from "@basestation/protocol";

import { browserHost } from "./host.js";
import type { CoreHost } from "./host.js";

export interface PendingSpec {
  id: string;
  topic: string;
  timeoutMs: number;
  onSettle: (msg: Message) => void;
  onTimeout: () => void;
  onAbandon: (err: Error) => void;
}

interface Entry {
  timer: ReturnType<typeof setTimeout>;
  spec: PendingSpec;
}

/** 请求挂起表：按 replyTo 结算 Promise。定时器经宿主接口，不直用全局。 */
export class PendingTable {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly host: CoreHost = browserHost) {}

  add(spec: PendingSpec): void {
    this.remove(spec.id);
    const timer = this.host.setTimeout(() => {
      this.entries.delete(spec.id);
      spec.onTimeout();
    }, spec.timeoutMs);
    this.entries.set(spec.id, { timer, spec });
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  settle(id: string, msg: Message): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.host.clearTimeout(entry.timer);
    this.entries.delete(id);
    entry.spec.onSettle(msg);
    return true;
  }

  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.host.clearTimeout(entry.timer);
    this.entries.delete(id);
  }

  size(): number {
    return this.entries.size;
  }

  /** 连接关闭或主动断开时统一失败，避免 Promise 永久悬挂。 */
  abandonAll(err: Error): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) {
      this.host.clearTimeout(entry.timer);
      entry.spec.onAbandon(err);
    }
  }
}
