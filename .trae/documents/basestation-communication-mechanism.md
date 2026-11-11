# 基站模式 + 按需订阅 前后端通信机制 实施计划

## 1. Summary

在空仓库中从零搭建一套「基站（Base Station）」通信机制：Go 服务端作为统一通信入口与消息中枢，TypeScript 客户端 SDK 作为**整个前端页面唯一的通信出口**。

三条硬约束决定了整体设计：

1. **单一连接**：一个页面只允许存在一条到基站的物理连接（WS *或* 轮询，二者互斥），由页面级单例持有；组件不得自行建连。
2. **按需监听**：组件以业务主题注册监听器，基站与客户端双层过滤，只投递其订阅的消息，杜绝全量广播。
3. **消息隔离**：每个监听器只拿到自己主题的 payload；单个监听器抛异常不影响其他监听器与连接；同主题的多个监听器可通过 `filter` 谓词进一步隔离到自己的数据。

交付内容：

- `server/`：Go 基站（会话管理、订阅倒排索引、消息路由、请求处理、心跳/超时/幂等去重）
- `packages/protocol/`：协议类型、错误码、主题匹配（前后端共享的唯一事实来源）
- `packages/client/`：`BaseStationClient` + 页面单例（请求-响应、订阅、取消订阅、一次性监听、心跳、自动重连、WS↔轮询自动降级/升级）
- `examples/web/`：Vite 原生 TS 演示页，用 4 个互相独立的组件模块共享同一条连接，直观演示隔离
- `docs/usage.md` + `README.md`：协议规范与典型场景文档

---

## 2. Current State Analysis

- 仓库 `c:\CODE_WORKSPACE\BaseStation` 完全为空（0 文件、无 git、无 package.json）。
- 可用工具链：Go `1.24.12`、Node `v24.16.0`、npm `11.13.0`、registry 可访问（vite 8.3.5）。
- 无历史约定可继承，目录结构、命名、配置全部由本计划定义。

---

## 3. 总体架构

```
 ┌───────────────────────────── 浏览器（一个页面） ──────────────────────────────┐
 │  组件A metrics-panel   组件B news-panel   组件C request-panel   组件D traffic-log │
 │      │subscribe('metrics.*')  │subscribe('news.notice') │request('echo') │onTraffic│
 │      ▼                       ▼                        ▼                ▼        │
 │  ┌──────────────── getBaseStation() → 同一个单例 ────────────────────────────┐  │
 │  │                    BaseStationClient（全页唯一连接）                       │  │
 │  │  统一入口 handleInbound：按 type 分发 → pending / MessageBus / 控制帧     │  │
 │  │  MessageBus：订阅 id → 监听器，主题精确投递 + 监听器异常隔离               │  │
 │  │  状态机 / 心跳 / 重连 / 请求重试超时 / seq 去重 / switchLock 串行切换      │  │
 │  │        ┌──────────────┐  互斥，同一时刻至多一个   ┌────────────────┐      │  │
 │  │        │ WS Transport │ ←──────── 降级/升级 ──────→ │ Poll Transport │      │  │
 │  │        └──────────────┘   （先停旧的再起新的）     └────────────────┘      │  │
 │  └──────────────────────────────────────────────────────────────────────────┘  │
 └───────────────────┬───────────────────────────────────┬─────────────────────────┘
          GET /ws（升级）                     POST/GET /api/...（长轮询）
 ┌───────────────────▼───────────────────────────────────▼─────────────────────────┐
 │                              Go Base Station                                    │
 │  Transport 层：ws.go / poll.go —— 同一 Session 的两个可替换读写端               │
 │  Hub：Session 注册表、subsByPattern 倒排索引、Router、Handler 注册表、          │
 │       幂等去重缓存、心跳巡检、宽限期清理                                        │
 │  Biz：echo / metrics / news 示例主题处理器与发布器                              │
 └─────────────────────────────────────────────────────────────────────────────────┘
```

**关键设计：传输层可替换、会话有状态。** WS 与 HTTP 轮询共用同一个 `Session`（同一份订阅集合、同一个出站队列、同一个 seq 计数器）。WS 断开后会话进入宽限期，客户端改用轮询携带同一 `sessionId` 续接，订阅与队列都不丢 —— 这是需求 6「自动切换与降级」能平滑成立的基础，也是「不额外建连」的前提。

---

## 4. 消息格式规范（需求 3）

统一信封，5 个必填字段：`type`、`id`、`ts`、`payload`、`error`（`error` 恒存在，成功为 `null`）。

```ts
export type MessageType =
  | "hello" | "ping" | "pong"
  | "req" | "res"
  | "sub" | "subok"
  | "unsub" | "unsubok"
  | "event" | "error";

export interface MessageError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface Message<T = unknown> {
  type: MessageType;
  id: string;                  // 必填，唯一标识（32 位 hex）
  ts: number;                  // 必填，毫秒时间戳
  payload: T;                  // 必填，无数据时为 {}
  error: MessageError | null;  // 必填，成功为 null
  topic?: string;              // 路由主题
  sessionId?: string;          // 基站会话标识
  replyTo?: string;            // 响应/确认帧指向的原消息 id
  seq?: number;                // 基站 → 客户端单调递增序号，跨传输去重
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | 见枚举；未知类型回 `error`（`BAD_MESSAGE`），不断连 |
| `id` | 是 | `crypto/rand` / `crypto.getRandomValues` 生成的 32 位 hex |
| `ts` | 是 | `time.Now().UnixMilli()` / `Date.now()` |
| `payload` | 是 | 任意 JSON，缺省归一化为 `{}` |
| `error` | 是 | Go 侧不带 `omitempty`，成功序列化为 `null` |
| `topic` | 否 | `req/sub/unsub` 必带；`res/event` 回填原主题 |
| `replyTo` | 否 | `res/subok/unsubok/pong/error` 必带，等于触发帧 `id` |
| `seq` | 否 | 仅基站出站帧填写 |

**错误码**（Go 与 TS 常量一致）：`BAD_MESSAGE` `UNKNOWN_TOPIC` `HANDLER_ERROR` `TIMEOUT` `SESSION_NOT_FOUND` `SESSION_REPLACED` `TRANSPORT_UNAVAILABLE` `NOT_SUBSCRIBED` `INTERNAL`

**主题匹配规则**（前后端同一实现）：

- `*` → 全部主题
- `prefix.*` → 以 `prefix.` 开头的所有主题（任意深度）
- 其他 → 精确匹配

**服务端帧处理**：

| type | 行为 | 回帧 |
|---|---|---|
| `ping` | 刷新 lastSeen | `pong` + `replyTo` |
| `sub` | 幂等加入订阅集合与倒排索引 | `subok`，payload `{topic}` |
| `unsub` | 移除订阅（未订阅也算成功） | `unsubok` |
| `req` | 查去重缓存 → 调处理器（受 `handlerTimeout` 约束） | `res`（新 `id`，`replyTo`=req.id，带 `topic`） |
| 其他/非法 | 不崩溃、不断连 | `error` + `replyTo` |

**请求幂等**：服务端以 `(sessionId, reqId)` 缓存响应 5 分钟；客户端重试沿用同一 `id`，所以重试不会二次执行业务逻辑（`slow.echo` 也不会跑两遍）。

---

## 5. 服务端（Go）设计

模块名 `basestation`，唯一外部依赖 `github.com/gorilla/websocket v1.5.3`；uuid 用 `crypto/rand` 自实现。

### 5.1 文件清单

| 文件 | 职责 |
|---|---|
| `server/go.mod` / `go.sum` | 模块与依赖锁定 |
| `server/cmd/basestation/main.go` | 组装根：flag 解析、创建 Hub、注册示例业务、启动 HTTP、优雅关闭 |
| `server/internal/protocol/message.go` | `Message`/`MessageError`、类型与错误码常量、`NewMessage`、`Validate`、`TopicMatches`、`NewID` |
| `server/internal/protocol/message_test.go` | 校验、主题匹配、`error` 字段序列化 |
| `server/internal/hub/session.go` | `Session`：ID、出站队列 `chan *Message`（容量 512）、订阅集合、seq、lastSeen、绑定的 WS 连接、`enqueue`（满则丢最旧并告警） |
| `server/internal/hub/hub.go` | `Hub`：会话注册表、`subsByPattern` 倒排索引、`HandleInbound`、`Publish`、`HandleRequest`、去重缓存与 TTL 清理、会话巡检 |
| `server/internal/hub/topic.go` | 订阅增删与 `Publish` 扇出 |
| `server/internal/hub/hub_test.go` | 扇出、取消订阅、通配符、请求去重、未订阅不投递 |
| `server/internal/transport/httpx/server.go` | 路由、CORS、JSON 工具、`GET /api/health` |
| `server/internal/transport/httpx/ws.go` | `/ws` 升级、下发 `hello`、读写泵、原生 ping/pong、读超时 |
| `server/internal/transport/httpx/poll.go` | 会话创建/续接、批量入站、长轮询出站、会话删除 |
| `server/internal/biz/topics.go` | 示例处理器与发布器，演示业务模块只依赖 `Hub` 接口 |

### 5.2 核心类型与接口

```go
type Message struct {
    Type      string          `json:"type"`
    ID        string          `json:"id"`
    TS        int64           `json:"ts"`
    Payload   json.RawMessage `json:"payload"`
    Error     *MessageError   `json:"error"`      // 无 omitempty：成功为 null
    Topic     string          `json:"topic,omitempty"`
    SessionID string          `json:"sessionId,omitempty"`
    ReplyTo   string          `json:"replyTo,omitempty"`
    Seq       int64           `json:"seq,omitempty"`
}

// 业务模块只依赖该接口，不感知 WS/轮询
type HandlerFunc func(ctx context.Context, sess *Session, req Message) (any, *MessageError)

func (h *Hub) HandleRequest(topic string, fn HandlerFunc)
func (h *Hub) Publish(topic string, payload any) int   // 返回实际投递的会话数
```

出站统一走 `Session.enqueue`：分配 `seq` → 写 channel → 满则丢弃最旧帧并记日志（慢消费者不阻塞基站）。

### 5.3 会话生命周期

- `POST /api/sessions`：body 可带 `sessionId`；存在则**续接**（刷新 `lastSeen`，返回 `resumed: true`），否则新建。
- `GET /ws?sessionId=xxx`：升级成功后立即下发 `hello`（`sessionId`、`heartbeatIntervalMs`、`pollWaitMs`、`graceMs`）；携带有效 `sessionId` 时续接并复用订阅与队列。
- WS 断开：解绑连接，会话保留 `graceMs`（默认 30s）可续接。
- 巡检协程每 5s：`now-lastSeen > graceMs` 且无活跃 WS → 注销会话并丢弃残留队列。
- `DELETE /api/sessions/{id}`：客户端主动断开。

### 5.4 轮询端点语义

- `POST /api/sessions/{id}/messages`，body `{"messages":[...]}`：批量入站（与 WS 读泵同一处理路径），返回 `202 {"accepted":n}`。
- `GET /api/sessions/{id}/messages?waitMs=25000&lastSeq=0`：
  - 有消息立即返回 `{"messages":[...],"timeout":false}`
  - 挂起超时返回 `{"messages":[],"timeout":true}`（200）
  - `seq <= lastSeq` 的帧直接跳过（切换传输后防重复）
  - 若该会话已被 WS 接管，返回 `{"messages":[],"replacedBy":"ws"}` 供客户端停止轮询（仅作兜底；正常切换由客户端串行保证）

### 5.5 配置项（flag）

| flag | 默认 | 含义 |
|---|---|---|
| `-addr` | `:8080` | 监听地址 |
| `-grace` | `30s` | 会话宽限期 |
| `-hb` | `15s` | 下发客户端的应用层心跳间隔 |
| `-poll-wait` | `25s` | 长轮询最大挂起时长 |
| `-handler-timeout` | `10s` | 单请求处理器超时 |
| `-cors` | `*` | 允许的 Origin（逗号分隔） |

### 5.6 示例业务主题

| 主题 | 类型 | 说明 |
|---|---|---|
| `echo` | 请求 | 回显 payload |
| `system.info` | 请求 | 版本、运行时长、在线会话数 |
| `metrics.snapshot` | 请求 | 当前指标快照 |
| `slow.echo` | 请求 | 延迟 2s，演示超时与重试 |
| `boom` | 请求 | 返回 `HANDLER_ERROR`（`retryable:false`） |
| `metrics.cpu` / `metrics.mem` | 事件 | 1s / 2s 周期推送 |
| `news.notice` | 事件 | 5s 周期推送 |

---

## 6. 客户端 SDK（TS）设计

### 6.1 `packages/protocol`

`src/index.ts`：`Message`、`MessageType`、`MessageError`、`ErrorCode`、`MessageTypeConst`（`as const` 对象，不用 `enum`）、`isMessage`/`isEvent`/`isResponse` 守卫、`topicMatches`、`createMessage`。仅类型与纯函数，无运行时依赖。

### 6.2 `packages/client` 公共 API

```ts
export type ClientState = "idle" | "connecting" | "connected" | "degraded" | "reconnecting" | "closed";
export type TransportKind = "ws" | "poll";

export interface BaseStationOptions {
  url: string;                                  // 基站基地址，如 http://localhost:8080
  transport?: "auto" | "ws" | "poll";           // 默认 auto
  requestTimeoutMs?: number;                    // 默认 10000
  heartbeatIntervalMs?: number;                 // 默认 15000（hello 可覆盖）
  heartbeatTimeoutMs?: number;                  // 默认 5000
  pollWaitMs?: number;                          // 默认 25000
  wsUpgradeProbeMs?: number;                    // 默认 30000
  reconnect?: { baseDelayMs?: number; maxDelayMs?: number; factor?: number; jitterRatio?: number };
  sessionStorageKey?: string | false;           // 默认 "basestation.sessionId"
  transportFactory?: TransportFactory;          // 依赖注入（测试/自定义传输）
  logger?: (level: "debug" | "info" | "warn" | "error", event: string, meta?: unknown) => void;
}

// 组件只需依赖这个接口 —— 低耦合的关键
export interface IBaseStationClient {
  readonly state: ClientState;
  readonly transportKind: TransportKind | null;
  readonly sessionId: string | null;
  onStateChange(cb: (state: ClientState, info: StateChangeInfo) => void): () => void;
  onTraffic(cb: (msg: Message, dir: "in" | "out") => void): () => void;
  request<T = unknown>(topic: string, payload?: unknown, opts?: RequestOptions): Promise<T>;
  subscribe<T = unknown>(topic: string, handler: (payload: T, msg: Message<T>) => void,
                         opts?: SubscribeOptions): Subscription;
  unsubscribe(target: Subscription | string): Promise<void>;
  once<T = unknown>(topic: string, opts?: OnceOptions): Promise<Message<T>>;
}

export declare class BaseStationClient implements IBaseStationClient {
  constructor(options: BaseStationOptions);
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface RequestOptions { timeoutMs?: number; retries?: number; retryDelayMs?: number }
export interface SubscribeOptions {
  filter?: (payload: unknown, msg: Message) => boolean;   // 同主题内的二级隔离
  onError?: (err: Error) => void;                         // 本订阅自己的错误出口
}
export interface OnceOptions { timeoutMs?: number }

export declare class Subscription {
  readonly id: string;
  readonly topic: string;
  readonly active: boolean;
  unsubscribe(): Promise<void>;
}
```

### 6.3 页面单例（单一连接的唯一入口）

```ts
// packages/client/src/singleton.ts
export function initBaseStation(options: BaseStationOptions): IBaseStationClient;  // 幂等
export function getBaseStation(): IBaseStationClient;                              // 未初始化则抛错
export function isBaseStationReady(): boolean;
```

- `initBaseStation` 只在应用启动时调用一次；重复调用返回同一实例并 `logger.warn`；若第二次的 `url` 与首次不同则抛 `BaseStationError("ALREADY_INITIALIZED")`，从源头杜绝多连接。
- `BaseStationClient` 构造函数仍导出，但仅供测试与「确实需要多实例」的高级场景；文档明确不推荐组件直接 `new`。
- 组件只 `import { getBaseStation }`，拿 `IBaseStationClient` 接口，不感知 WS/轮询/重连。

### 6.4 单一连接与串行切换（需求 6）

`BaseStationClient` 内部持有一个 `switchLock: Promise` 串行锁，**同一时刻至多存在一个 Transport 实例**。切换流程：

```
switchTo(kind):
  1. 置 switching=true —— 期间 outbound 帧进入缓冲队列，不丢弃
  2. await 当前 transport.stop()  （轮询：AbortController 中止在途请求；WS：close 并等 onclose）
  3. 创建并 start() 目标 transport
  4. 成功 → 重放全部订阅 + flush 缓冲队列；失败 → 回到上一个可用传输，否则进入 reconnecting
  5. switching=false
```

| 阶段 | 行为 |
|---|---|
| 初始（`auto`） | 先试 WS，`3s` 内未收到 `hello` 视为失败 → 落到轮询，不向业务报错 |
| WS 正常 | 每 `heartbeatIntervalMs` 发 `ping`；`heartbeatTimeoutMs` 内无 `pong` → `onClose("heartbeat")` → 切轮询（`degraded`）并启动重连 |
| WS 异常断开 | 切轮询（`degraded`），`onStateChange` 通知业务 |
| 轮询中 | 每 `wsUpgradeProbeMs` 试一次 WS 升级；成功则先停轮询再换绑 WS，状态回 `connected`，重放订阅 |
| `transport: "ws" \| "poll"` | 强制指定，不做切换（排障用） |
| 重连 | 指数退避 `500ms ×2 → 上限 10s`，抖动 ±20%，直到 `disconnect()` |
| 服务端兜底 | 同一 `sessionId` 被新 WS 绑定时服务端关闭旧连接（`SESSION_REPLACED`）；正常路径下客户端不会并发建连 |

切换期间业务无感：订阅集合保存在客户端 `SubscriptionRegistry`，任一传输就绪后统一重放 `sub`（服务端幂等）。

### 6.5 统一入口与消息隔离（需求 1、2、8）

**统一管理**：客户端只有一个入站入口 `handleInbound(msg)`，按 `type` 分发：

| 入站 type | 去向 |
|---|---|
| `res` | `PendingTable`（按 `replyTo` 结算 Promise） |
| `event` | `MessageBus.dispatch(msg)` |
| `subok` / `unsubok` | 对应订阅的控制流转 |
| `pong` | 心跳计时器重置 |
| `error` | 有 `replyTo` → 结算对应 pending；否则 → 全局错误出口 |
| `hello` | 建立/续接会话，回填心跳参数 |

`onTraffic` 是**纯本地旁路观测**（不向服务端发任何订阅），用于日志面板与排障。

**四层隔离**：

1. 服务端过滤：`Publish` 只遍历已注册订阅模式，未订阅会话一帧都收不到。
2. 客户端总线过滤：`MessageBus` 以「订阅 id → 监听器」登记，派发时只命中 `topicMatches(订阅主题, 消息主题)` 的监听器，其余监听器完全无感。
3. 监听器异常隔离：每个 handler 独立 `try/catch`，异常交给该订阅的 `onError` 或全局 logger，绝不中断循环、不断连、不污染其他监听器。
4. 二级数据隔离：可选 `filter(payload, msg)` 让同主题不同组件各自筛出属于自己的数据（如 `order.updated` 中只关心自己 `orderId` 的部分）。

取消订阅按**订阅 id** 精确移除，同主题上的其他监听器不受影响；主题上最后一个监听器移除时才发送 `unsub` 帧。

### 6.6 请求-响应、重试与超时（需求 4、5）

1. `request()` 生成 `id` → 登记 `PendingTable` → 经当前传输发 `req`。
2. 收到 `res && replyTo === id`：`error === null` 返回 `payload`；否则抛 `RequestError`（带 `code`/`retryable`）。
3. 超时：若 `retries` 未耗尽且错误可重试（网络/超时/`retryable=true`）→ **相同 `id`** 重发，退避 `retryDelayMs`；否则抛 `TimeoutError`。
4. 传输不可用期间发出的请求进入出站缓冲，传输恢复后自动补发（同 `id`，服务端去重保证幂等）。
5. `once(topic, {timeoutMs})`：注册一次性监听 → 命中即清理并 resolve 完整 `Message`；超时清理并 reject。

### 6.7 内部文件职责

| 文件 | 职责 |
|---|---|
| `src/types.ts` | `Transport`、`TransportFactory`、`TransportInfo`、`CloseReason`、选项类型 |
| `src/errors.ts` | `BaseStationError`（`code`/`retryable`）、`TimeoutError`、`ConnectionError`、`RequestError` |
| `src/message-bus.ts` | 订阅 id → 监听器；`add`/`remove`/`dispatch`，通配符匹配 + 异常隔离 + `filter` |
| `src/pending.ts` | 请求挂起表：`id → {resolve, reject, timer}` |
| `src/singleton.ts` | `initBaseStation` / `getBaseStation` / `isBaseStationReady` 单例守卫 |
| `src/transports/websocket.ts` | 建 WS、等 `hello`、读写、`stop()`；只搬帧，不做重连 |
| `src/transports/polling.ts` | `POST /api/sessions` 取会话、长轮询循环、批量 POST 出站、`AbortController` 中止 |
| `src/client.ts` | 状态机、`switchLock` 切换、心跳、重连、订阅重放、重试超时、seq 去重、统一分发、`onTraffic` |
| `src/index.ts` | 公共导出 |

```ts
export interface Transport {
  readonly kind: TransportKind;
  start(): Promise<TransportInfo>;   // { sessionId, heartbeatIntervalMs, pollWaitMs, resumed }
  stop(): void;
  send(messages: Message[]): void;
  onMessage(cb: (msg: Message) => void): void;
  onClose(cb: (reason: CloseReason) => void): void;
}
export type CloseReason = "manual" | "heartbeat" | "network" | "server" | "switch";
```

---

## 7. 演示页（`examples/web`）

Vite + 原生 TS，无 UI 框架。**页面启动时只 `initBaseStation()` 一次**，之后所有组件共享同一连接，各自只处理自己的主题 —— 这本身就是隔离的活演示。

```
examples/web/src/
  main.ts                    # 仅 initBaseStation() + 挂载各组件容器
  components/connection-panel.ts  # connect/disconnect、state、transport、sessionId、强制降级按钮
  components/metrics-panel.ts     # subscribe('metrics.*')，只渲染 cpu/mem 卡片
  components/news-panel.ts        # subscribe('news.notice') + once 按钮，只渲染公告
  components/request-panel.ts     # echo / slow.echo / boom / system.info
  style.css
```

各组件内部形如：

```ts
const bs = getBaseStation();                       // 不建连、不感知传输
bs.subscribe<Cpu>('metrics.cpu', (cpu) => render(cpu));
panel.addEventListener('remove', () => sub.unsubscribe());
```

`connection-panel` 额外暴露「强制降级 WS」（主动关 WS 并屏蔽升级 15s）与 `onStateChange` 状态展示；`traffic-log` 组件用 `onTraffic` 展示全量收发帧（倒序卡片，颜色区分 `event`/`res`/`error`，显示 `type/topic/id/ts/seq`）。

Vite `server.proxy` 把 `/api` 与 `/ws`（`ws: true`）代理到 `http://localhost:8080`，浏览器同源；服务端仍保留 CORS 供独立接入。

---

## 8. 文档（需求 7）

- `README.md`：定位、架构图、目录结构、`npm run dev` 快速开始、脚本说明。
- `docs/usage.md`：
  1. 快速开始
  2. 协议规范（信封字段表、类型表、错误码表、主题匹配规则）
  3. 单一连接与页面单例（`initBaseStation` / `getBaseStation`，为什么不能组件内 `new`）
  4. 场景一：普通请求-响应（含超时/重试/错误处理）
  5. 场景二：订阅实时数据推送（`subscribe` + 通配符 `metrics.*`）
  6. 场景三：取消订阅（`Subscription.unsubscribe()` 与按主题批量取消）
  7. 场景四：一次性消息监听（`once`）
  8. 场景五：降级与自动恢复（状态回调、`transport` 强制项、排障建议）
  9. 消息隔离与低耦合集成：多组件共享一条连接、`filter` 二级隔离、只依赖 `IBaseStationClient`
  10. 服务端扩展：`Hub.HandleRequest` / `Hub.Publish`

---

## 9. 文件清单（新建）

```
package.json                     # npm workspaces: packages/*, examples/*
tsconfig.base.json
tsconfig.json                    # 项目引用
.gitignore                       # node_modules, dist, server/bin
scripts/dev.mjs                  # 并行拉起 go run 与 vite，退出级联关闭
README.md
docs/usage.md

packages/protocol/package.json
packages/protocol/tsconfig.json
packages/protocol/src/index.ts

packages/client/package.json
packages/client/tsconfig.json
packages/client/src/index.ts
packages/client/src/types.ts
packages/client/src/errors.ts
packages/client/src/message-bus.ts
packages/client/src/pending.ts
packages/client/src/singleton.ts
packages/client/src/client.ts
packages/client/src/transports/websocket.ts
packages/client/src/transports/polling.ts
packages/client/src/__tests__/message-bus.test.ts
packages/client/src/__tests__/client.test.ts    # MockTransport：请求/超时/重试/订阅/once/降级/重连重放/隔离

examples/web/package.json
examples/web/tsconfig.json
examples/web/vite.config.ts
examples/web/index.html
examples/web/src/main.ts
examples/web/src/style.css
examples/web/src/components/connection-panel.ts
examples/web/src/components/metrics-panel.ts
examples/web/src/components/news-panel.ts
examples/web/src/components/request-panel.ts
examples/web/src/components/traffic-log.ts

server/go.mod
server/cmd/basestation/main.go
server/internal/protocol/message.go
server/internal/protocol/message_test.go
server/internal/hub/session.go
server/internal/hub/hub.go
server/internal/hub/topic.go
server/internal/hub/hub_test.go
server/internal/transport/httpx/server.go
server/internal/transport/httpx/ws.go
server/internal/transport/httpx/poll.go
server/internal/biz/topics.go
```

根 `package.json` 脚本：

```json
{
  "dev": "node scripts/dev.mjs",
  "dev:server": "go run ./cmd/basestation",
  "dev:web": "npm -w examples/web run dev",
  "build": "tsc -b && npm -w examples/web run build",
  "test": "vitest run && npm run test:server",
  "test:server": "cd server && go test ./...",
  "typecheck": "tsc -b --pretty"
}
```

根 `devDependencies`：`typescript`、`vite`、`vitest`；`examples/web` 另需 `vite`。无 React 依赖。

---

## 10. Assumptions & Decisions

1. **Go 后端 + TS 前端 + npm workspaces**；Go 位于 `server/`（独立 module，不参与 workspace）。
2. **全页单连接**：对外只推荐 `initBaseStation()` / `getBaseStation()`；重复初始化同 URL 幂等、异 URL 抛错；组件不持有连接。
3. **传输互斥**：`switchLock` 串行化切换，同一时刻至多一个 `Transport`，不存在 WS 与轮询并存。
4. **订阅按主题单值**：一个 `sub` 帧一个主题，多主题由客户端循环发送，协议保持简单。
5. **`error` 字段恒存在**（成功为 `null`），严格满足「错误字段必填」。
6. **请求重试依赖服务端 `(sessionId, reqId)` 幂等缓存**，重试无副作用。
7. **会话是唯一状态载体**，WS/轮询是可替换读写端 —— 降级不丢订阅、不丢消息。
8. **不引入框架绑定**，SDK 为类 + 接口，组件只依赖 `IBaseStationClient`。
9. **不做鉴权**（超出范围）；CORS/Origin 仅按配置放开，README 标注为演示用途。
10. **不写浏览器 e2e**，采用 Go 单测 + Vitest（MockTransport）+ 手工演示清单验证。
11. **WS 库选 `gorilla/websocket`**：`SetReadDeadline` + `PongHandler` 直接对应心跳超时检测，无 cgo。

---

## 11. Verification

### 11.1 构建与自动化测试

```powershell
cd server; go vet ./...; go test ./...; go build ./...
cd ..; npm install; npm run build; npm test
```

预期覆盖：协议校验/主题匹配/`error` 必填；订阅扇出/取消订阅/请求去重；总线通配符与异常隔离；`filter` 二级隔离；请求超时与重试；`once`；降级切换；重连后订阅重放；`initBaseStation` 单例守卫。

### 11.2 手工演示清单（`npm run dev` → http://localhost:5173）

1. 连接 → 状态 `connected`、传输 `ws`、显示 `sessionId`；浏览器 Network 面板**只有 1 条 WS 连接**。
2. `echo` 返回 payload；`slow.echo` 超时后重试并最终成功（日志可证同 `id`）；`boom` 返回 `HANDLER_ERROR` 且不重试。
3. `metrics-panel` 订阅 `metrics.*`：每秒 cpu、每两秒 mem；`news-panel` 只显示公告，**不出现指标数据**（消息隔离可见）。
4. 取消订阅后对应组件停止更新，其他组件不受影响。
5. `once('news.notice')` 仅收到一条后自动注销。
6. 「强制降级 WS」→ 状态 `degraded`、传输 `poll`，两个面板推送不中断；约 30s 后自动升级回 `ws`，推送仍连续、无重复帧（`seq` 去重生效）；全程 Network 面板无并发双连接。
7. `traffic-log` 展示完整收发帧，`state` 变化有记录。

### 11.3 接口冒烟（PowerShell）

```powershell
$s = Invoke-RestMethod -Method Post http://localhost:8080/api/sessions -ContentType 'application/json' -Body '{}'
Invoke-RestMethod -Method Post "http://localhost:8080/api/sessions/$($s.sessionId)/messages" -ContentType 'application/json' `
  -Body '{"messages":[{"type":"sub","id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","ts":1,"payload":{},"error":null,"topic":"metrics.*"}]}'
Invoke-RestMethod "http://localhost:8080/api/sessions/$($s.sessionId)/messages?waitMs=5000"
Invoke-RestMethod http://localhost:8080/api/health
```

### 11.4 完成标准

- 8 条需求逐条有可运行演示或文档对应；
- 「全页单连接」「消息隔离」在演示中可直接观察；
- `go test` 与 `vitest` 全绿；`npm run build` 无类型错误；
- WS → 轮询 → 自动回 WS 全过程订阅不中断、无重复消息、无并发建连。
