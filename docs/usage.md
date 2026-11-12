# 使用指南

本文覆盖协议规范与六类典型用法：请求-响应、订阅推送、取消订阅、一次性监听、降级恢复、低耦合集成，最后说明如何扩展服务端。

## 1. 快速开始

```powershell
npm install
npm run dev          # 基站 :8080 + 演示页 :5173
```

在自己的页面里接入 SDK：

```ts
// main.ts —— 应用启动时调用一次
import { initBaseStation, getBaseStation } from "@basestation/client";

const client = initBaseStation({
  url: window.location.origin, // 可直连 http://localhost:8080
  transport: "auto",           // 先 WS，失败自动降级轮询
  requestTimeoutMs: 5000,
});

const bs = getBaseStation();   // 组件里只拿这个接口
await client.connect();
```

`examples/web` 是一个可直接运行的完整示例：5 个组件共享同一条连接，各自订阅自己的主题。

## 2. 协议规范

### 2.1 信封字段

```ts
interface Message<T = unknown> {
  type: MessageType;            // 必填
  id: string;                   // 必填，32 位 hex
  ts: number;                   // 必填，毫秒时间戳
  payload: T;                   // 必填，无数据时为 {}
  error: MessageError | null;   // 必填，成功时为 null
  topic?: string;               // 路由主题
  sessionId?: string;           // 基站会话标识
  replyTo?: string;             // 响应/确认帧指向的原消息 id
  seq?: number;                 // 基站 → 客户端单调递增序号
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | 未知类型回 `error`（`BAD_MESSAGE`），不断连 |
| `id` | 是 | 客户端用 `newId()`，服务端用 `crypto/rand` |
| `ts` | 是 | `Date.now()` / `time.Now().UnixMilli()` |
| `payload` | 是 | 任意 JSON；缺省归一化为 `{}` |
| `error` | 是 | Go 侧无 `omitempty`，成功序列化为 `null` |
| `topic` | 否 | `req/sub/unsub` 必带；`res/event` 回填原主题 |
| `replyTo` | 否 | `res/subok/unsubok/pong/error` 必带 |
| `seq` | 否 | 仅基站出站帧填写，跨传输去重 |

### 2.2 消息类型

| type | 方向 | 用途 |
|---|---|---|
| `hello` | 基站 → 客户端 | WS 建连后下发会话参数（`sessionId`、心跳间隔、轮询挂起时长） |
| `ping` / `pong` | 客户端 → 基站 / 基站 → 客户端 | 应用层心跳 |
| `req` / `res` | 客户端 → 基站 / 基站 → 客户端 | 请求与响应，`res.replyTo = req.id` |
| `sub` / `subok` | 客户端 → 基站 / 基站 → 客户端 | 订阅主题与确认 |
| `unsub` / `unsubok` | 客户端 → 基站 / 基站 → 客户端 | 取消订阅与确认 |
| `event` | 基站 → 客户端 | 订阅主题的实时推送 |
| `error` | 基站 → 客户端 | 协议或处理错误 |

### 2.3 错误码

`BAD_MESSAGE`、`UNKNOWN_TOPIC`、`HANDLER_ERROR`、`TIMEOUT`、`SESSION_NOT_FOUND`、`SESSION_REPLACED`、`TRANSPORT_UNAVAILABLE`、`NOT_SUBSCRIBED`、`INTERNAL`。

错误对象：

```ts
{ code: "HANDLER_ERROR", message: "boom: deliberate business failure", retryable: false, details?: {...} }
```

### 2.4 主题匹配

| 订阅主题 | 命中 |
|---|---|
| `*` | 全部主题 |
| `metrics.*` | `metrics.cpu`、`metrics.mem`，以及任意深度前缀 |
| `news.notice` | 仅 `news.notice` |

前后端使用同一套实现（Go `TopicMatches` / TS `topicMatches`），不存在两端规则不一致的问题。

### 2.5 幂等与去重

- 请求重试沿用同一个 `id`。服务端按 `(sessionId, reqId)` 缓存已完成的响应 5 分钟，重试命中缓存不会重复返回新结果。
- 基站出站帧带 `seq`，客户端在切换传输后丢弃 `seq <= lastSeq` 的重复帧。
- `res` 的 `id` 每次新建，靠 `replyTo` 与原请求关联。

## 3. 单一连接与页面单例

**约束：一个页面只允许一条到基站的物理连接。**

```ts
// 启动层：只调用一次
const client = initBaseStation({ url, transport: "auto" });
await client.connect();

// 组件层：只取接口，绝不 new
const bs = getBaseStation(); // IBaseStationClient
```

- `initBaseStation` 重复调用同 URL 返回同一实例（`logger.warn`）；URL 不同直接抛 `BaseStationError(BAD_MESSAGE)`，从源头杜绝多连接。
- 组件只依赖 `IBaseStationClient`，不感知 WS、轮询、重连、心跳。
- `connect()` 幂等；内部 `switchLock` 串行化传输切换，同一时刻至多存在一个 `Transport`。
- `disconnect()` 会清空挂起请求并释放传输；再次 `connect()` 会复用本地保存的 `sessionId` 续接会话。

`BaseStationClient` 构造函数仍然导出，仅供测试或确实需要多实例的高级场景使用。

## 4. 场景一：普通请求-响应

```ts
const bs = getBaseStation();

// 基础用法：payload 必须是可序列化对象
const echoed = await bs.request<{ text: string }>("echo", { text: "hello" });

// 超时 / 重试：1s 超时后用同一个 id 重发一次
const slow = await bs.request("slow.echo", { text: "hi" }, {
  timeoutMs: 1000,
  retries: 1,
  retryDelayMs: 200,
});
```

错误处理：

```ts
import { RequestError, TimeoutError } from "@basestation/client";

try {
  await bs.request("boom", {});
} catch (err) {
  if (err instanceof RequestError) {
    console.log(err.code, err.message, err.retryable, err.details);
  } else if (err instanceof TimeoutError) {
    console.log("重试耗尽仍超时", err.topic, err.code);
  }
}
```

要点：

- `res.error === null` → resolve `payload`；否则 reject `RequestError`。
- 超时且 `retries` 未耗尽 → 相同 `id` 重发，服务端幂等缓存兜底。
- 传输不可用期间发出的请求进入客户端出站缓冲，传输恢复后自动补发。
- 响应只结算对应 Promise，不进入任何订阅监听器。

## 5. 场景二：订阅实时数据推送

```ts
const bs = getBaseStation();

const sub = bs.subscribe<{ value: number; series: string }>(
  "metrics.*",                       // 通配符：cpu / mem 都收
  (payload, msg) => {
    console.log(payload.series, payload.value, msg.seq, msg.ts);
  },
  {
    onError: (err) => console.warn("本订阅的监听器异常", err),
  },
);
```

- 第一个监听器注册时才发送 `sub` 帧；同一主题再加监听器只在本地区分订阅 id。
- 传输切换（降级/升级/重连）后，客户端自动重放所有订阅主题，服务端 `sub` 幂等。
- 服务端 `Publish` 只遍历已订阅的会话与主题，未订阅的会话一帧都收不到。

请求当前快照而不是等推送：

```ts
const snapshot = await bs.request<{ cpu: number; mem: number }>("metrics.snapshot", {});
```

## 6. 场景三：取消订阅

按订阅句柄取消（推荐，精确到这一次注册）：

```ts
const sub = bs.subscribe("metrics.cpu", renderCpu);
// ...
await sub.unsubscribe();
console.log(sub.active); // false
```

按主题批量取消（同一主题上的所有监听器）：

```ts
await bs.unsubscribe("metrics.cpu");
```

要点：

- 取消订阅按订阅 id 精确移除，同主题上的其他监听器不受影响。
- 主题上最后一个监听器移除时才向服务端发送 `unsub` 帧。
- 组件卸载、路由切换时调用 `unsubscribe()` 即可，无需关心当前是 WS 还是轮询。

## 7. 场景四：一次性消息监听

```ts
const msg = await bs.once<{ noticeId: number; title: string }>("news.notice", {
  timeoutMs: 12000,
});
console.log(msg.payload.noticeId, msg.payload.title);
```

- 命中第一条符合条件的消息后自动注销，返回完整 `Message`（含 `id/ts/topic/seq`）。
- 超时抛 `TimeoutError`，监听器同样被清理。
- 与常驻订阅互不影响：`once` 是同一主题上的另一个订阅 id。

## 8. 场景五：降级与自动恢复

### 8.1 传输模式

```ts
initBaseStation({
  url,
  transport: "auto", // 默认：先 WS，失败降级轮询，并定期尝试升级回 WS
  // transport: "ws"   // 强制 WS，不降级（排障用）
  // transport: "poll" // 强制轮询
  wsUpgradeProbeMs: 30000,
});
```

### 8.2 状态机

| state | 含义 |
|---|---|
| `idle` | 未连接 |
| `connecting` | 首次建连 |
| `connected` | WS 长连接正常 |
| `degraded` | 正在使用 HTTP 长轮询 |
| `reconnecting` | 两种传输都不可用，指数退避重试中 |
| `closed` | 已主动断开 |

```ts
bs.onStateChange((state, info) => {
  console.log(state, info.previous, info.transport, info.reason);
});
```

容错参数：

| 选项 | 默认 | 说明 |
|---|---|---|
| `heartbeatIntervalMs` | `15000` | 应用层 ping 间隔，`hello` 可覆盖 |
| `heartbeatTimeoutMs` | `5000` | 超过该时长无 `pong` 视为断线 |
| `pollWaitMs` | `25000` | 长轮询挂起时长 |
| `wsUpgradeProbeMs` | `30000` | 降级后尝试升级回 WS 的间隔 |
| `reconnect` | `500ms ×2 → 10s，抖动 ±20%` | 指数退避重连 |
| `networkProbeTimeoutMs` | `2000` | 重连前的网络试探超时；`0` 表示禁用试探 |
| `networkProbe` | 默认探基站 `/api/health` | 自定义可达性试探（如改探业务网关） |

**先探网络、再探服务**：WS 断连后，无论是立即降级还是退避重连，每一步先做
网络试探（对 `/api/health` 的轻量 GET，拿到任何 HTTP 响应即算可达）。不可达
（本机断网或服务端进程不在）时跳过本轮 WS/轮询尝试——网络全断时降级没有
意义、只会白建会话——保持 `reconnecting` 按退避节奏继续试探；一旦可达，
先试 WS，WS 被挡（代理等）才降级轮询，轮询通了再按 `wsUpgradeProbeMs`
探测升回 WS。

### 8.3 排障：强制降级

```ts
bs.forceDegrade(15_000); // 主动断开 WS，降级到轮询，15s 内不尝试升级
```

演示页的「强制降级 WS」按钮即调用该方法：推送不中断，随后自动升级回 WS，`seq` 去重保证无重复帧。

### 8.4 会话被接管

若同一 `sessionId` 被另一条 WS 绑定（例如另一个标签页），当前轮询会收到 `replacedBy: "ws"`。客户端丢弃旧会话并自动新建一条连接，不会陷入循环。

## 9. 消息隔离与低耦合集成

### 9.1 四层隔离

1. **服务端过滤**：`Publish` 只遍历已注册的订阅模式。
2. **客户端总线过滤**：`MessageBus` 按订阅 id 登记，只命中 `topicMatches(订阅主题, 消息主题)` 的监听器。
3. **监听器异常隔离**：每个 handler 独立 `try/catch`，异常交给该订阅的 `onError` 或全局 logger，不中断派发、不断连。
4. **二级数据隔离**：`filter(payload, msg)` 让同主题的不同组件只处理属于自己的数据。

```ts
// 同主题 order.updated，两个组件各自只关心自己的订单
bs.subscribe("order.updated", renderMyOrder, {
  filter: (payload) => (payload as { orderId: string }).orderId === "A-1001",
});

bs.subscribe("order.updated", renderOtherOrder, {
  filter: (payload) => (payload as { orderId: string }).orderId === "A-1002",
});
```

### 9.2 多组件共享一条连接

```ts
// metrics-panel.ts
const bs = getBaseStation();
const sub = bs.subscribe<Metric>("metrics.*", renderMetric);

// news-panel.ts
const bs = getBaseStation(); // 同一实例
const sub = bs.subscribe<News>("news.notice", renderNews);
```

两个组件都只写自己的渲染逻辑，不 import 任何传输实现。`examples/web` 中的 5 个组件就是这么做的。

### 9.3 旁路观测

```ts
const off = bs.onTraffic((msg, dir) => {
  console.log(dir, msg.type, msg.topic, msg.id, msg.seq);
});
// off() 取消观测
```

`onTraffic` 是纯本地观测，不会向服务端额外订阅任何主题，适合日志面板与排障。

### 9.4 依赖边界

组件只应 import：

```ts
import type { IBaseStationClient, Subscription } from "@basestation/client";
import { getBaseStation } from "@basestation/client";
```

不要直接实例化 `BaseStationClient`，也不要自己 `new WebSocket`。

## 10. 服务端扩展

业务模块只依赖 `hub.Hub` 两个入口：

```go
// 请求处理器：返回 (payload, 错误)
h.HandleRequest("order.status", func(ctx context.Context, sess *hub.Session, req protocol.Message) (any, *protocol.MessageError) {
    return map[string]any{"sessionId": sess.ID, "echo": req.Payload}, nil
})

// 事件推送：只投递给订阅了匹配主题的会话，返回投递会话数
go func() {
    ticker := time.NewTicker(3 * time.Second)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            n := h.Publish("order.updated", map[string]any{
                "orderId": "A-1001",
                "status":  "paid",
            })
            _ = n
        }
    }
}()
```

注册位置在 `server/internal/biz/topics.go` 的 `Register`，或新建自己的业务包并在 `main.go` 中调用。

处理器注意事项：

- 处理器在独立 goroutine 中执行，受 `-handler-timeout` 约束；阻塞不会影响心跳读取。
- 返回值必须可 JSON 序列化；`nil` 会被归一化为 `{}`。
- 返回 `MessageError` 时，`retryable` 决定客户端是否值得重试。
- 同一 `(sessionId, reqId)` 的已完成响应会被缓存 5 分钟，处理器不会因为客户端重试而重复执行。

前端对应的订阅：

```ts
bs.subscribe("order.*", (payload) => renderOrder(payload));
```

## 11. 安全与鉴权（jwt 模式）

服务端以 `-auth-mode=jwt -auth-secret=<密钥>` 启动后，前端不带令牌连不上、验过前端也不算数，一切以服务端复核为准。

### 11.1 拿令牌（第 1 关）

开发环境用签发端点换令牌（启动需带 `-dev-token`；生产环境替换为校验 IdP 登录令牌的交换端点，客户端用法不变）：

```bash
curl -X POST localhost:8080/api/auth/dev-token -d '{
  "sub": "alice", "tenant": "t1",
  "subscribe": ["metrics.*", "user.alice.*"],
  "publish": ["echo"],
  "ratePerSec": 20,
  "ttlSeconds": 600
}'
# → { "token": "...", "jti": "...", "expiresAt": ... }
```

### 11.2 客户端带令牌

```ts
const bs = new BaseStationClient({
  url: "http://localhost:8080",
  // 静态令牌，或用 tokenProvider 在每次（重）连时取最新令牌（推荐，便于刷新）
  tokenProvider: () => authStore.messageToken,
});
```

WS 经 `?token=` 传递，轮询经 `Authorization: Bearer` 头，客户端自动处理，业务代码无感。

### 11.3 会被拒的情形（均有服务端审计日志）

| 情形 | 结果 |
|---|---|
| 无令牌 / 过期 / 被吊销的令牌建连 | HTTP 401 |
| 拿别人的 `sessionId` + 自己的令牌续接 | HTTP 403，会话不被接管 |
| 订阅超出 `sub_acl`（如受限令牌订 `*`） | `error` 帧 `FORBIDDEN`，订阅不生效 |
| 订阅 `user.{他人}.*` 私人主题 | `error` 帧 `FORBIDDEN`（与 ACL 无关，强制校验） |
| 请求不在 `pub_acl` 的主题 | `res` 帧 `FORBIDDEN`，不进处理器 |
| 信封里伪造 `tenant/sender` | 被服务端按令牌盖章覆写，处理器只看到真实主体 |
| 超过 `rate` 狂发 | `res` 帧 `RATE_LIMITED`；累计违规 5 次断开会话 |
| 令牌被 admin 吊销（`POST /api/auth/revoke`） | 存量会话立即踢除，新连接 401 |

## 12. 标准组件与多标签

### 12.1 Topic 注册表与代码生成

主题的契约只写一处：`registry/topics.json`。每条包含主题名、方向（`request` 事件型为 `event`）、投递意图（`delivery`）、保留策略（`retention`）、payload 的 JSON Schema（简化版：properties/required）。

改完运行：

```bash
npm run gen:topics
```

生成两份代码（禁止手改）：

- `packages/protocol/src/topics.ts`：`Topics` 常量、`TOPIC_META`、各主题的 payload TS 接口（如 `MetricsCpuPayload`）
- `server/internal/registry/topics_gen.go`：服务端校验表

服务端启动时自动挂载注册表：第 4 关会对**已注册**主题的请求做 payload 结构校验（必填缺失/类型错误回 `BAD_MESSAGE` 且不进处理器）；未注册主题保持开放（注册表只约束已声明契约的主题）。

### 12.2 Web Component（框架无关）

```html
<script type="module">
  import { defineBaseStationComponents } from "@basestation/component";
  defineBaseStationComponents();
</script>

<base-station url="http://localhost:8080" token="...">
  <bs-subscribe topic="metrics.cpu" show></bs-subscribe>
</base-station>
<script>
  document.querySelector("bs-subscribe").addEventListener("bs-message", (e) => {
    console.log(e.detail.topic, e.detail.payload);
  });
</script>
```

- `<base-station>`：挂载建连、卸载断开，`url`/`token` 属性变化重建连接；状态变化派发冒泡的 `bs-state` 事件，错误派发 `bs-error`。
- `<bs-subscribe>`：订阅 `topic` 属性指定的主题；带 `show` 时把最新 payload 以 JSON 渲染进自身文本。必须放在 `<base-station>` 里面。

### 12.3 React 绑定

```tsx
import { BaseStationProvider, useSubscription } from "@basestation/react";

function CpuMeter() {
  const [cpu, setCpu] = useState<MetricsCpuPayload | null>(null);
  useSubscription<MetricsCpuPayload>(Topics.MetricsCpu, setCpu);
  return <div>{cpu?.value ?? "—"}%</div>;
}

export const App = () => (
  <BaseStationProvider url="http://localhost:8080" token={token}>
    <CpuMeter />
  </BaseStationProvider>
);
```

`useSubscription` 挂载订阅、卸载退订、topic 变化换订；handler 换新函数不会导致重订阅。另有 `useBaseStation()`（取客户端发请求）与 `useBaseStationState()`（观察连接状态）。

### 12.4 Vue 绑定

```ts
// main.ts
import { createBaseStationPlugin } from "@basestation/vue";
app.use(createBaseStationPlugin({ url: "http://localhost:8080", token }));

// 组件 setup 内
import { useSubscription } from "@basestation/vue";
useSubscription<MetricsCpuPayload>(Topics.MetricsCpu, (payload) => {
  cpu.value = payload.value;
});
```

`useSubscription` 的 topic 传 `Ref<string>` 时，值变化会自动换订。

### 12.5 SharedWorker 多标签单连接

同源打开多个标签页时，让它们共享 worker 里的一条连接：

```ts
import { createBestClient } from "@basestation/client";

// 推荐：用打包器的标准写法先构造 SharedWorker（脚本打包/转译归 Vite/webpack 管），再把实例传进来。
// worker 入口已声明为包的子路径导出：@basestation/client/hosts/worker-entry
const worker = new SharedWorker(
  new URL("@basestation/client/hosts/worker-entry", import.meta.url),
  { type: "module", name: "basestation" },
);
const bs = createBestClient({ url: "http://localhost:8080", token, worker });
await bs.connect();

// 或者直接给脚本地址（适合无打包器、直接引用构建产物的场景）：
// const bs = createBestClient({ url, token, workerUrl: "/assets/worker-entry.js" });
```

注意：`SharedWorkerClient` 的订阅可以在 `connect()` 之前注册（组件先挂载很常见），连接时会统一补发给 worker；连接等待带 10 秒超时，worker 脚本加载失败会明确报错而不是一直卡在 connecting。

- 支持 SharedWorker 的浏览器：真实客户端跑在 worker 里，页面只是 stub；订阅按主题做引用计数（多标签订同一主题只占一份真实订阅、事件扇出），标签关闭（bye 或 15 秒心跳超时）后其订阅自动清理，无残留。
- 不支持时（或没传 `workerUrl`）：`createBestClient` 自动降级为普通 `BaseStationClient`（每标签一条连接），业务代码无感。
- 注意：worker 里的会话不落盘（Worker 无 localStorage），worker 重启会新建会话，靠服务端宽限续接兜底。
