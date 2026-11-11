import { ErrorCode } from "@basestation/protocol";

import { BaseStationClient } from "./client.js";
import { BaseStationError } from "./errors.js";
import type { BaseStationOptions, IBaseStationClient } from "./types.js";

// 页面级单例：整页只允许一条到基站的物理连接。
let instance: BaseStationClient | null = null;
let instanceUrl: string | null = null;

/**
 * 在应用启动时调用一次（仅 bootstrap 层使用，组件请改用 getBaseStation）。
 * 重复调用同 URL 返回同一实例；不同 URL 直接抛错，从源头杜绝多连接。
 */
export function initBaseStation(options: BaseStationOptions): BaseStationClient {
  if (instance) {
    if (instanceUrl !== options.url) {
      throw new BaseStationError(
        ErrorCode.BadMessage,
        `BaseStation already initialized for ${instanceUrl}; refusing a second connection to ${options.url}`,
      );
    }
    options.logger?.("warn", "init_base_station_duplicate", { url: options.url });
    return instance;
  }
  instance = new BaseStationClient(options);
  instanceUrl = options.url;
  return instance;
}

/** 组件获取连接的唯一方式；未初始化时抛错。 */
export function getBaseStation(): IBaseStationClient {
  if (!instance) {
    throw new BaseStationError(
      ErrorCode.TransportUnavailable,
      "BaseStation is not initialized; call initBaseStation(options) once during app bootstrap",
    );
  }
  return instance;
}

export function isBaseStationReady(): boolean {
  return instance !== null;
}
