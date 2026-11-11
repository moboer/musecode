# Base Station

基站模式 + 按需订阅的前后端通信机制：Go 基站作为统一通信入口，TypeScript 客户端 SDK 作为**整个页面唯一的通信出口**。

- **单一连接**：一个页面只允许一条到基站的物理连接（WebSocket *或* HTTP 轮询，互斥），由页面级单例持有，组件不建连。
- **按需订阅**：组件以业务主题注册监听器，服务端倒排索引 + 客户端消息总线双层过滤，只投递自己订阅的消息。
- **消息隔离**：每个监听器只拿到自己主题的 payload；单个监听器抛异常不影响其他监听器与连接；同主题可用 `filter` 谓词做二级隔离。
- **自动容错**：心跳检测、指数退避重连、请求超时重试（同 `id` 幂等）、WS 失败自动降级到长轮询、轮询期间定期尝试升级回 WS。

## 架构

```
 ┌──────────────────────────── 浏览器（一个页面） ────────────────────────────┐
 │ connection-panel   metrics-panel   news-panel   request-panel   traffic-log │
 │      │ connect        │ subscribe    │ subscribe     │ request      │ 旁路   │
 │      ▼                ▼ metrics.*    ▼ news.notice   ▼ echo         ▼        │
 │  ┌──────────── getBaseStation() → 同一个单例 ────────────────────────────┐  │
 │  │                  BaseStationClient（全页唯一连接）                     │  │
 │  │  统一入口 handleInbound：res→pending / event→MessageBus / 控制帧       │  │
 │  │  MessageBus：订阅 id → 监听器，主题精确投递 + 监听器异常隔离          │  │
 │  │  心跳 / 重连 / 请求重试超时 / seq 去重 / switchLock 串行切换          │  │
 │  │        ┌──────────────┐   互斥，同一时刻至多一个   ┌──────────────┐   │  │
 │  │        │ WS Transport │ ←──── 降级 / 升级 ────────→ │ Poll Transport│  │  │
 │  │        └──────────────┘   （先停旧的再起新的）     └──────────────┘   │  │
 │  └──────────────────────────────────────────────────────────────────────┘  │
 └──────────────────┬───────────────────────────────────┬──────────────────────┘
            GET /ws（升级）                    POST/GET /api/...（长轮询）
 ┌──────────────────▼───────────────────────────────────▼──────────────────────┐
 │                               Go Base Station                               │
 │  transport：ws.go / poll.go —— 同一 Session 的两个可替换读写端              │
 │  hub：Session 注册表、订阅倒排索引、请求处理器、幂等缓存、宽限期巡检         │
 │  biz：echo / metrics / news 示例主题                                        │
 └─────────────────────────────────────────────────────────────────────────────┘
```

**传输层可替换、会话有状态**：WS 与轮询共用同一个 `Session`（同一份订阅集合、同一个出站队列、同一个 `seq` 计数器）。WS 断开后会话保留 `grace` 宽限期，客户端改用轮询携带同一 `sessionId` 续接，订阅与队列都不丢。

## 目录结构

```
packages/protocol/      协议类型、错误码、主题匹配 + 注册表生成代码 topics.ts（前后端共享）
packages/client/        BaseStationClient、页面单例、消息总线、两种传输实现
  src/hosts/            SharedWorker 宿主：worker 路由器、页面 stub 客户端、worker 入口
packages/component/     Web Component 标准组件：<base-station> / <bs-subscribe>
packages/react/         React 薄绑定：BaseStationProvider + useSubscription 等 hooks
packages/vue/           Vue 3 薄绑定：插件 + useSubscription 等 composables
registry/topics.json    Topic 注册表（唯一事实来源，npm run gen:topics 生成双端代码）
server/                 Go 基站（独立 module，不参与 npm workspace）
  cmd/basestation/      启动入口与 flag
  internal/protocol/    消息信封与校验
  internal/hub/         会话、订阅倒排索引、路由、幂等缓存
  internal/auth/        JWT 令牌校验、订阅/发布 ACL、令牌桶限流
  internal/registry/    注册表运行时与 payload 结构校验
  internal/transport/   WS 与长轮询端点
  internal/biz/         示例业务主题
examples/web/           Vite + 原生 TS 演示页（5 个组件共享一条连接）
docs/usage.md           使用示例文档（请求、订阅、鉴权、标准组件、多标签等）
docs/learning-guide.md  初学者学习文档（概念、代码地图、动手练习）
scripts/dev.mjs         并行拉起基站与演示页
```

## 快速开始

环境要求：Go 1.24+、Node 20.19+。

```powershell
npm install
npm run dev
```

`npm run dev` 会同时启动：

- Go 基站：http://localhost:8080
- 演示页：http://localhost:5173（Vite 把 `/api` 与 `/ws` 代理到基站）

也可以分开启动：

```powershell
npm run dev:server
npm run dev:web
```

## 脚本

| 脚本 | 作用 |
|---|---|
| `npm run dev` | 并行启动基站与演示页，任一退出级联关闭 |
| `npm run dev:server` | 只启动 Go 基站 |
| `npm run dev:web` | 只启动 Vite 演示页 |
| `npm run typecheck` | `tsc -b` + 演示页类型检查 |
| `npm run build` | 构建 SDK 与演示页 |
| `npm test` | Vitest 单元测试（39 个用例）+ `go test ./...`，克隆后开箱可跑、全绿 |
| `npm run test:server` | 仅 Go 测试 |
| `npm run test:probe` | 活服务器探针（需先 `npm run dev`）：真实基站上的降级/续接联调，不在默认套件内 |
| `npm run gen:topics` | 按 `registry/topics.json` 重新生成双端注册表代码（改主题后必跑） |
| `npm run check:host` | 宿主纪律检查：core 不得直接引用 window/document/全局存储（见方案 v2 宿主接口） |

## 协议速览

所有帧共用一个信封，5 个必填字段：

```json
{
  "type": "event",
  "id": "8f14e45fceea167a5a36dedd4bea2543",
  "ts": 1761532800000,
  "payload": { "value": 42.5, "series": "cpu" },
  "error": null,
  "topic": "metrics.cpu",
  "seq": 128
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | 是 | `hello`/`ping`/`pong`/`req`/`res`/`sub`/`subok`/`unsub`/`unsubok`/`event`/`error` |
| `id` | 是 | 32 位 hex 唯一标识 |
| `ts` | 是 | 毫秒时间戳 |
| `payload` | 是 | 任意 JSON，缺省为 `{}` |
| `error` | 是 | 错误对象，成功时为 `null` |

主题匹配规则（前后端同一实现）：`*` 匹配全部；`prefix.*` 匹配前缀；其他精确匹配。

完整字段表、类型表、错误码与各场景示例见 [docs/usage.md](docs/usage.md)。

## 演示清单

打开 http://localhost:5173：

1. 状态 `已连接`、传输 `WebSocket`；浏览器 Network 面板只有 1 条 WS 连接。
2. `echo` 返回请求 payload；`slow.echo` 客户端 1s 超时后用同一个 `id` 重试并成功；`boom` 返回 `HANDLER_ERROR`。
3. 指标卡片每秒/每两秒更新；公告面板只出现公告，指标帧不会进入公告组件。
4. 任一组件「取消订阅」后停止更新，其他组件不受影响。
5. 「一次性监听」命中一条公告后自动注销。
6. 「强制降级 WS」→ 传输切到 `HTTP 轮询`，推送不中断；约 30s 后自动升级回 WebSocket，`seq` 去重保证无重复帧。
7. 底部流量日志展示整条连接的全部收发帧（`type/topic/id/ts/seq`）。

## 服务端配置

```powershell
go -C server run ./cmd/basestation -addr :8080 -grace 30s -hb 15s -poll-wait 25s -handler-timeout 10s -cors *
```

| flag | 默认 | 含义 |
|---|---|---|
| `-addr` | `:8080` | 监听地址 |
| `-grace` | `30s` | 会话宽限期（WS 断开后保留订阅与队列） |
| `-hb` | `15s` | 下发客户端的应用层心跳间隔 |
| `-poll-wait` | `25s` | 长轮询最大挂起时长 |
| `-handler-timeout` | `10s` | 单请求处理器超时 |
| `-cors` | `*` | 允许的 Origin，逗号分隔 |
| `-auth-mode` | `none` | 鉴权模式：`none`（开发，不验令牌）/ `jwt`（全链路验证） |
| `-auth-secret` | （环境变量 `BS_AUTH_SECRET`） | JWT 签名密钥，jwt 模式必填 |
| `-dev-token` | `false` | 开启开发用令牌签发端点 `POST /api/auth/dev-token` |
| `-max-conns-per-user` | `10` | 单用户最大会话数（jwt 模式），0 不限 |
| `-rate-per-sec` | `0` | 默认发布/请求速率上限（条/秒/主题），令牌自带 `rate` 时以令牌为准 |

## 安全与鉴权（jwt 模式）

后端全链路验证，前端验过不算数（方案 v2 §6）：

1. **令牌交换**：业务登录后向 `POST /api/auth/dev-token`（开发实现；生产替换为 IdP 令牌交换）换取短期 JWT，内含 `sub/tenant`、可订 `sub_acl`、可发 `pub_acl`、速率 `rate`。
2. **建连验**：WS 经 `?token=`、轮询经 `Authorization: Bearer` 验签/有效期/吊销名单；续接必须**令牌主体与会话原主一致**，光有 `sessionId` 接管不了别人的会话；单用户连接数有上限。
3. **订阅验**：每个 `sub` 做 ACL 子集判定（受限令牌订 `*` 会被拒）+ 私人命名空间 `user.{id}.*` 归属强制校验。
4. **发布验**：每个 `req` 做 ACL 校验；信封 `tenant/sender` 由服务端按令牌**盖章覆写**，前端伪造无效；按用户×主题令牌桶限流，违规累计 5 次踢线。
5. **吊销贯穿**：`POST /api/auth/revoke`（需 admin 令牌）吊销 jti 后，新连接被拒、存量会话立即踢除；令牌过期会话由回收器踢除。全程审计日志（`audit:` 前缀）。

客户端：`new BaseStationClient({ url, token })` 或 `tokenProvider: () => currentToken()`（重连时自动取新令牌）。

## 标准组件与多标签（v2.0-c）

同一套 core，四种用法（细节见 `docs/usage.md` §12）：

- **注册表**：主题只在 `registry/topics.json` 定义一次（方向、投递意图、payload 结构），`npm run gen:topics` 生成前端类型与服务端校验表；服务端对已注册主题的请求做 payload 结构校验。
- **Web Component**（框架无关）：`<base-station url token>` + `<bs-subscribe topic show>`，消息以 `bs-message` 事件冒泡出来。
- **React / Vue 薄绑定**：`@basestation/react` 的 Provider + `useSubscription`、`@basestation/vue` 的插件 + `useSubscription`，只桥接生命周期，不复制机制。
- **SharedWorker 多标签单连接**：`createBestClient({ url, workerUrl })` 在支持的浏览器让同源全部标签共享 worker 里的一条连接（订阅引用计数、关标签自动清理），不支持时自动降级为页面内客户端。

## 范围说明

默认 `none` 模式仅供本地开发演示（启动时有警告日志）；生产请开启 `-auth-mode=jwt` 并自行补充 TLS。事件扇出（`Publish`）的跨租户隔离目前靠订阅 ACL 在入口收口，注册表/字段级校验随标准组件阶段补齐。
