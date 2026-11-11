/**
 * GENERATED from registry/topics.json —— 禁止手改，改注册表后运行 npm run gen:topics。
 * Topic 注册表的前端镜像：常量、元数据与 payload 类型与服务端校验表同源生成。
 */

export const Topics = {
  Boom: "boom",
  Echo: "echo",
  MetricsCpu: "metrics.cpu",
  MetricsMem: "metrics.mem",
  MetricsSnapshot: "metrics.snapshot",
  NewsNotice: "news.notice",
  SlowEcho: "slow.echo",
  SystemInfo: "system.info",
} as const;

export type TopicName = (typeof Topics)[keyof typeof Topics];

export interface TopicMeta {
  direction: "request" | "event";
  /** 投递意图（声明语义，不写协议参数） */
  delivery: "at-least-once" | "latest-only";
  retention: "none" | "last";
  since: string;
}

export const TOPIC_META: Record<string, TopicMeta> = {
  "boom": { direction: "request", delivery: "at-least-once", retention: "none", since: "1.0" },
  "echo": { direction: "request", delivery: "at-least-once", retention: "none", since: "1.0" },
  "metrics.cpu": { direction: "event", delivery: "latest-only", retention: "last", since: "1.0" },
  "metrics.mem": { direction: "event", delivery: "latest-only", retention: "last", since: "1.0" },
  "metrics.snapshot": { direction: "request", delivery: "at-least-once", retention: "none", since: "1.0" },
  "news.notice": { direction: "event", delivery: "at-least-once", retention: "none", since: "1.0" },
  "slow.echo": { direction: "request", delivery: "at-least-once", retention: "none", since: "1.0" },
  "system.info": { direction: "request", delivery: "at-least-once", retention: "none", since: "1.0" },
};

export interface MetricsCpuPayload {
  series?: string;
  serverTs?: number;
  unit?: string;
  value: number;
}

export interface MetricsMemPayload {
  series?: string;
  serverTs?: number;
  unit?: string;
  value: number;
}

export interface NewsNoticePayload {
  level?: string;
  noticeId: number;
  publishedAt?: number;
  title: string;
}

export interface SlowEchoPayload {
  delayMs?: number;
}
