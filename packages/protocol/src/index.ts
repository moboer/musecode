/**
 * 基站通信协议 —— 前后端共享的唯一事实来源。
 * 与 server/internal/protocol/message.go 保持字段与取值一致。
 */

export const MessageType = {
  Hello: "hello",
  Ping: "ping",
  Pong: "pong",
  Req: "req",
  Res: "res",
  Sub: "sub",
  SubOk: "subok",
  Unsub: "unsub",
  UnsubOk: "unsubok",
  Event: "event",
  Error: "error",
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export const ErrorCode = {
  BadMessage: "BAD_MESSAGE",
  UnknownTopic: "UNKNOWN_TOPIC",
  HandlerError: "HANDLER_ERROR",
  Timeout: "TIMEOUT",
  SessionNotFound: "SESSION_NOT_FOUND",
  SessionReplaced: "SESSION_REPLACED",
  TransportUnavailable: "TRANSPORT_UNAVAILABLE",
  NotSubscribed: "NOT_SUBSCRIBED",
  Internal: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 信封中的错误字段；无论成功与否该字段都存在，成功时为 null。 */
export interface MessageError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}

/** 所有通信帧的统一信封。 */
export interface Message<T = unknown> {
  /** 必填：消息类型 */
  type: MessageType;
  /** 必填：唯一标识（32 位 hex） */
  id: string;
  /** 必填：毫秒时间戳 */
  ts: number;
  /** 必填：负载数据，无数据时为 {} */
  payload: T;
  /** 必填：错误字段，成功时为 null */
  error: MessageError | null;
  /** 路由主题 */
  topic?: string;
  /** 基站会话标识 */
  sessionId?: string;
  /** 响应/确认帧指向的原消息 id */
  replyTo?: string;
  /** 基站 → 客户端单调递增序号，用于跨传输去重 */
  seq?: number;
}

export interface CreateMessageInit<T> {
  id?: string;
  ts?: number;
  payload?: T;
  error?: MessageError | null;
  topic?: string;
  sessionId?: string;
  replyTo?: string;
  seq?: number;
}

/** 生成 32 位十六进制唯一标识。 */
export function newId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** 构造一个信封，自动补齐必填字段。 */
export function createMessage<T = unknown>(type: MessageType, init: CreateMessageInit<T> = {}): Message<T> {
  const msg: Message<T> = {
    type,
    id: init.id ?? newId(),
    ts: init.ts ?? Date.now(),
    payload: (init.payload ?? {}) as T,
    error: init.error ?? null,
  };
  if (init.topic !== undefined) msg.topic = init.topic;
  if (init.sessionId !== undefined) msg.sessionId = init.sessionId;
  if (init.replyTo !== undefined) msg.replyTo = init.replyTo;
  if (init.seq !== undefined) msg.seq = init.seq;
  return msg;
}

/**
 * 主题匹配规则，与服务端完全一致：
 * - `*`        匹配全部主题
 * - `prefix.*` 匹配所有以 `prefix.` 开头的主题
 * - 其他       精确匹配
 */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    return topic.length > prefix.length && topic.startsWith(prefix);
  }
  return pattern === topic;
}

const KNOWN_TYPES = new Set<string>(Object.values(MessageType));

/** 运行时校验一个未知对象是否为合法信封（边界防御）。 */
export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    KNOWN_TYPES.has(candidate.type) &&
    typeof candidate.id === "string" &&
    typeof candidate.ts === "number" &&
    "payload" in candidate &&
    "error" in candidate
  );
}

export function isEvent(msg: Message): boolean {
  return msg.type === MessageType.Event;
}

export function isResponse(msg: Message): boolean {
  return msg.type === MessageType.Res;
}

export function isErrorFrame(msg: Message): boolean {
  return msg.type === MessageType.Error || msg.error !== null;
}
