export { BaseStationClient } from "./client.js";
export { initBaseStation, getBaseStation, isBaseStationReady } from "./singleton.js";
export { Subscription } from "./types.js";
export type {
  BaseStationOptions,
  ClientState,
  CloseReason,
  IBaseStationClient,
  LogLevel,
  OnceOptions,
  ReconnectOptions,
  RequestOptions,
  StateChangeInfo,
  SubscribeOptions,
  Transport,
  TransportFactory,
  TransportInfo,
  TransportKind,
} from "./types.js";
export { BaseStationError, ConnectionError, RequestError, TimeoutError } from "./errors.js";
export { MessageBus } from "./message-bus.js";
export type { BusEntry } from "./message-bus.js";
export { PollingTransport } from "./transports/polling.js";
export { WebSocketTransport } from "./transports/websocket.js";

export { createMessage, ErrorCode, MessageType, newId, topicMatches } from "@basestation/protocol";
export type { Message, MessageError } from "@basestation/protocol";
