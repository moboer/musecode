import { topicMatches } from "@basestation/protocol";
import type { Message } from "@basestation/protocol";

export interface BusEntry {
  id: string;
  topic: string;
  handler: (payload: unknown, msg: Message) => void;
  filter?: (payload: unknown, msg: Message) => boolean;
  onError?: (err: unknown) => void;
}

/**
 * 主题 → 监听器。派发时只命中 topicMatches 的监听器，
 * 每个监听器独立 try/catch，互不影响。
 */
export class MessageBus {
  private readonly entries = new Map<string, BusEntry>();
  private readonly reportError: (err: unknown, entry: BusEntry) => void;

  constructor(reportError?: (err: unknown, entry: BusEntry) => void) {
    this.reportError =
      reportError ??
      ((err) => {
        console.error("[basestation] subscription handler threw", err);
      });
  }

  add(entry: BusEntry): void {
    this.entries.set(entry.id, entry);
  }

  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  get(id: string): BusEntry | undefined {
    return this.entries.get(id);
  }

  size(): number {
    return this.entries.size;
  }

  hasTopic(topic: string): boolean {
    for (const entry of this.entries.values()) {
      if (entry.topic === topic) return true;
    }
    return false;
  }

  topics(): string[] {
    return [...new Set([...this.entries.values()].map((entry) => entry.topic))];
  }

  clear(): void {
    this.entries.clear();
  }

  /** 返回成功投递的监听器数量。 */
  dispatch(msg: Message): number {
    if (!msg.topic) return 0;
    let delivered = 0;
    // 快照遍历：监听器内部取消订阅不会影响本轮派发。
    for (const entry of [...this.entries.values()]) {
      if (!topicMatches(entry.topic, msg.topic)) continue;
      try {
        if (entry.filter && !entry.filter(msg.payload, msg)) continue;
        entry.handler(msg.payload, msg);
        delivered += 1;
      } catch (err) {
        if (entry.onError) {
          try {
            entry.onError(err);
          } catch (nested) {
            this.reportError(nested, entry);
          }
        } else {
          this.reportError(err, entry);
        }
      }
    }
    return delivered;
  }
}
