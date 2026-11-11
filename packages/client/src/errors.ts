import { ErrorCode } from "@basestation/protocol";
import type { MessageError } from "@basestation/protocol";

export interface BaseStationErrorOptions {
  retryable?: boolean;
  details?: unknown;
  cause?: unknown;
}

/** SDK 的统一错误类型，携带协议错误码与是否可重试。 */
export class BaseStationError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, options: BaseStationErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "BaseStationError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  static fromMessageError(err: MessageError, context?: string): BaseStationError {
    const prefix = context ? `${context}: ` : "";
    return new BaseStationError(err.code, `${prefix}${err.message}`, {
      retryable: err.retryable,
      details: err.details,
    });
  }
}

/** 请求在超时（且重试耗尽）后失败。 */
export class TimeoutError extends BaseStationError {
  readonly topic: string;

  constructor(topic: string, timeoutMs: number) {
    super(ErrorCode.Timeout, `request "${topic}" timed out after ${timeoutMs}ms`, { retryable: true });
    this.name = "TimeoutError";
    this.topic = topic;
  }
}

/** 传输不可用或连接被意外关闭。 */
export class ConnectionError extends BaseStationError {
  constructor(message: string, options: BaseStationErrorOptions = {}) {
    super(ErrorCode.TransportUnavailable, message, { retryable: true, ...options });
    this.name = "ConnectionError";
  }
}

/** 服务端返回了业务错误（信封中的 error 字段非空）。 */
export class RequestError extends BaseStationError {
  readonly topic: string;

  constructor(topic: string, err: MessageError) {
    super(err.code, `request "${topic}" failed: ${err.message}`, {
      retryable: err.retryable,
      details: err.details,
    });
    this.name = "RequestError";
    this.topic = topic;
  }
}
