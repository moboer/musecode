# 基站集成指南（把基站装进你自己的项目）

基站按“标准组件”交付：**后端是一个 Go module，前端是 5 个 npm 包**。
宿主项目不需要改结构、不需要理解基站内部实现。本文按步给出完整集成
流程，每步都带验证方法，照着做完即完成对接。

| 端 | 制品 | 获取方式 |
|---|---|---|
| 后端 | Go module `github.com/moboer/musecode/server`，集成面是其中的 `basestation` 包 | `go get`（go.mod require） |
| 前端协议 | `@basestation/protocol`（信封/错误码/主题类型，零依赖） | npm |
| 前端 SDK | `@basestation/client`（单连接多路复用、按需订阅、WS/长轮询切换、会话续接、SharedWorker） | npm |
| 前端组件 | `@basestation/component`（`<base-station>` / `<bs-subscribe>`，框架无关） | npm |
| 前端绑定 | `@basestation/react`、`@basestation/vue` | npm |

全景一张图：

```
你的后端进程 ──import──> basestation 包 ──> /ws、/api/* ──┐
                                                          │ WebSocket / 长轮询
你的前端应用 ──import──> @basestation/client ─────────────┘
业务代码只碰两件事：后端注册处理器/发布事件，前端订阅/请求。
```

---

## 第 0 步：前置条件

- 后端：Go 1.24+；能访问 GitHub 拉取模块（私有场景需 git 登录，见 1.1）。
- 前端：Node 20.19+ 构建环境；应用跑在现代浏览器（需 WebSocket；
  SharedWorker 多标签共享为可选增强，不支持时自动降级）。
- 想清楚两个选择（后面各步会用到）：
  - **后端形态**：独立进程（基站单独监听一个端口）还是嵌入现有服务
    （挂到你现有的 HTTP mux 上，共用端口）；
  - **鉴权**：内网/联调先用 `none`，上线前切 `jwt`（第 4 步）。

## 第 1 步：后端引入模块

```bash
cd 你的项目
go get github.com/moboer/musecode/server@basestaiton
go mod tidy
```

- `@basestaiton` 是项目所在分支名，go 会把它锁定为具体提交的伪版本写进
  go.mod，构建可复现；正式发版后改用 `@v1.x.y` 语义化版本。
- 仓库若为私有：确保本机 git 已登录对应 GitHub 账号，并设置
  `GOPRIVATE=github.com/moboer/*` 让 go 直连拉取。
- **验证**：`go list -m github.com/moboer/musecode/server` 能打印出版本号。

## 第 2 步：后端接线（二选一）

### 2A. 独立进程（推荐先用这个跑通）

在你的 `main` 里（或新建一个 `cmd/station` 小程序）写入：

```go
package main

import (
	"context"
	"log"
	"os"

	"github.com/moboer/musecode/server/basestation"
)

func main() {
	srv := basestation.New(basestation.Config{
		// 上线时换成 jwt，见第 4 步：
		// AuthMode: "jwt", AuthSecret: os.Getenv("BS_AUTH_SECRET"),
	})
	defer srv.Close()

	registerBusiness(srv) // 第 3 步实现

	if err := srv.Serve(context.Background(), ":8080"); err != nil {
		log.Fatal(err)
	}
	_ = os.Getenv // 示例占位，实际按你的配置方式来
}
```

### 2B. 嵌入现有 HTTP 服务（与宿主共用端口）

基站对外就是一个 `http.Handler`（提供 `/ws`、`/api/sessions`、
`/api/health`、`/api/auth/*`），挂到你现有的 mux 上：

```go
srv := basestation.New(basestation.Config{ /* 同上 */ })
registerBusiness(srv)

mux := http.NewServeMux()
mux.Handle("/", srv.Handler()) // 基站路由
// 你原有的路由照常注册……
```

注意：基站会占用 `/ws` 与 `/api/` 前缀，宿主不要在这些路径上再注册
自己的处理器；宿主自己的中间件（日志、panic 恢复等）照常包在外面即可。

### 验证（两种形态通用）

启动后：

```bash
curl http://localhost:8080/api/health
# {"ok":true,"sessions":0,"authMode":"none", ...} 即为基站已就绪
```

## 第 3 步：注册你的业务

业务面只有两个动作：**处理请求**、**发布事件**。主题（topic）用你自己的
命名（建议 `域.资源[.动作]`，如 `orders.create`、`device.42.telemetry`）；
未在注册表登记的主题自动放行，不需要任何额外配置。

```go
func registerBusiness(srv *basestation.Server) {
	// 请求-响应：前端 client.request("orders.create", {...}) 打到这里
	srv.HandleRequest("orders.create", func(ctx context.Context, req basestation.Request) (any, error) {
		var in struct {
			SKU string `json:"sku"`
		}
		if err := req.Decode(&in); err != nil || in.SKU == "" {
			// 业务错误用 NewError，码会原样下发到前端的错误对象
			return nil, basestation.NewError("BAD_MESSAGE", "sku required")
		}
		// req.Tenant / req.Sender 是 jwt 模式下服务端盖章的主体（可信，勿再自验）
		id := createOrder(in.SKU) // 你的业务逻辑
		return map[string]any{"orderId": id}, nil
	})

	// 事件发布：在任意 goroutine 里调（采集循环、定时任务、别的服务回调……）
	go func() {
		for range time.Tick(2 * time.Second) {
			srv.Publish("orders.created", map[string]any{"orderId": "o-1001"})
		}
	}()
}
```

约定：

- 处理器返回 `(结果, nil)`；返回普通 `error` 统一映射为 `HANDLER_ERROR`；
  处理器 panic 会被捕获并回 `INTERNAL`，不会打挂基站。
- 请求自带超时（默认 10s，可在 Config 调 `HandlerTimeout`）；同 id 重试
  有在途去重与完成缓存，业务不必自己做幂等。

## 第 4 步：（上线前）开启 jwt 鉴权

1. 服务端配置：`AuthMode: "jwt"`，`AuthSecret` 从环境变量注入
   （`BS_AUTH_SECRET`），不要写死在代码里。`DevToken` 仅联调时开。
2. 令牌从哪来：由你的业务登录态向基站令牌端点交换（联调可用开发端点）：

   ```bash
   curl -X POST http://localhost:8080/api/auth/dev-token \
     -d '{"sub":"user-42","tenant":"t1","subscribe":["orders.*"],"publish":[],"ratePerSec":50,"ttlSeconds":3600}'
   # -> {"token":"...","jti":"...","expiresAt":...}
   ```

   `subscribe` 决定可订阅范围（支持 `*` 与 `前缀.*` 与私人主题
   `user.{自己的 sub}`），越权订阅/请求会被后端拒绝并审计；令牌可按
   `jti` 吊销（`POST /api/auth/revoke`，需 admin 令牌），吊销即踢线。
3. 前端带令牌：见 5.6。验证都在后端全链路执行，前端那份只是镜像。

## 第 5 步：前端安装与接线

### 5.1 安装

发布到 npm 后（维护者发布，当前版本 1.0.0）：

```bash
npm install @basestation/client        # 会自动带上 @basestation/protocol
npm install @basestation/component     # 可选：Web Component
npm install @basestation/react         # 可选：React
npm install @basestation/vue           # 可选：Vue
```

**尚未发布到公共 npm 时**的等价装法（产物内容与发布版一致）：在基站仓库
根目录执行 `npm run pack:packages` 得到 5 个 tarball，把它们放进你的
项目（如 `vendor/`），然后：

```bash
npm install ./vendor/basestation-protocol-1.0.0.tgz ./vendor/basestation-client-1.0.0.tgz
# 其余包同理
```

### 5.2 原生 / 任意框架（SDK 直用）

```ts
import { BaseStationClient } from "@basestation/client";
import { Topics } from "@basestation/protocol"; // 内置主题常量；自有主题直接写字符串

const bs = new BaseStationClient({ url: "http://localhost:8080" });
await bs.connect();

// 订阅事件（返回的句柄可 unsubscribe，或用返回的 Subscription 管理）
bs.subscribe("orders.created", (p) => console.log("新订单", p));

// 请求-响应
const info = await bs.request("orders.create", { sku: "A-1" });

// 连接状态（做断网提示 UI 用）：connected / degraded / reconnecting / closed
bs.onStateChange((state, info) => {
  console.log(state, info.reason); // reason 可区分 probe:network / probe:service
});
```

注意：同一页面只建**一个**客户端实例（模块单例或 DI 注入），不要每个
组件各连一条——全页共享一条连接是基站的基本用法。

### 5.3 Web Component（零框架代码）

```html
<script type="module">
  import "@basestation/component";
</script>

<base-station url="http://localhost:8080">
  <bs-subscribe topic="orders.created"></bs-subscribe>
</base-station>
```

`<bs-subscribe>` 收到消息会派发 `bs-message` 事件并渲染 payload；
也可以给 `<base-station>` 注入 5.2 的页面单例（`client` 属性），避免
多开连接。

### 5.4 React

```tsx
import { BaseStationProvider, useSubscription } from "@basestation/react";

export const App = () => (
  <BaseStationProvider url="http://localhost:8080">
    <OrderFeed />
  </BaseStationProvider>
);

function OrderFeed() {
  useSubscription("orders.created", (p) => console.log("新订单", p));
  return null;
}
```

### 5.5 Vue 3

```ts
import { createBaseStationPlugin, useSubscription } from "@basestation/vue";

app.use(createBaseStationPlugin({ url: "http://localhost:8080" }));

// 组件内：
useSubscription("orders.created", (p) => console.log("新订单", p));
```

### 5.6 前端带令牌（后端 jwt 模式时）

```ts
new BaseStationClient({
  url,
  // 固定令牌：token: "..."
  // 或动态换取（过期自动重取）：tokenProvider: async () => (await myAuth.exchange()).token,
});
```

### 5.7（可选）多标签共享一条连接

```ts
import { createBestClient } from "@basestation/client";

// 用打包器标准写法构造 worker（入口是包的子路径导出），再传入
const worker = new SharedWorker(
  new URL("@basestation/client/hosts/worker-entry", import.meta.url),
  { type: "module" },
);
const bs = createBestClient({ url: "http://localhost:8080", worker });
```

支持 SharedWorker 的浏览器下，所有标签共用 worker 里的一条真实连接；
不支持时自动退回普通客户端。订阅可在 `connect()` 前注册，连上后统一补发。

## 第 6 步：联调验收清单

按顺序逐项确认（全过即集成完成）：

1. `curl /api/health` 返回 `ok:true`；
2. 前端 `connect()` 后状态为 `connected`，DevTools 网络面板里有**一条**
   WS 连接（多组件/多标签时结合 5.7 核对会话数：服务端 health 的
   `sessions` 与预期一致）；
3. 发一个你注册的请求主题，拿到业务响应；发一个不存在的主题，应回
   `UNKNOWN_TOPIC`（证明链路与错误通道都通）；
4. 后端 `Publish` 一个事件，前端订阅回调被触发；
5. 杀掉后端进程再拉起：前端先报 `reconnecting`（原因区分
   `probe:service`），恢复后自动回到 `connected`，订阅继续收消息；
6. （jwt 时）不带令牌连接应被拒；带访客令牌订阅越权主题应收
   `FORBIDDEN` 错误帧。

## 第 7 步：上线清单

- [ ] `AuthMode: "jwt"` 且密钥走环境变量；`DevToken: false`；
- [ ] `CORSOrigins` 从 `*` 收紧为你的实际域名；
- [ ] 前面挂 TLS（反向代理终结或网关），前端 url 用 `https/wss` 同源地址；
- [ ] 高频发布在源头攒批/限速：单帧 ≤1MB（整帧计），每会话出站队列
      512 帧，持续速率远超消费速度时慢订阅者会被丢帧（有计数可查）；
- [ ] 监控接入两个点：服务端 `/api/health`（含 `droppedTotal`）与前端
      `onSeqGap` 回调（消息缺口告警，业务据此做全量刷新）；
- [ ] 同源多应用共存时，给每个应用设不同的 `sessionStorageKey`，
      避免会话 id 串用；
- [ ] 性能预期：100ms 级业务（10 次/秒）余量约 4000 倍；量级评估与
      工业适用性见《基站性能上限与工业适用性报告》。

## 附：常见问题排查

| 症状 | 多半是 | 处理 |
|---|---|---|
| 请求回 `UNKNOWN_TOPIC` | 后端没注册这个主题的处理器 | 检查 `HandleRequest` 的主题名拼写与注册时机（须在 Serve/Handler 前） |
| 请求回 `BAD_MESSAGE` | 内置主题的 payload 不合注册表形状，或 payload 不是 JSON 对象 | 对照注册表字段；自有主题只要是 JSON 对象即放行 |
| 连接被拒 / 401 | jwt 模式没带令牌或令牌过期 | 检查 `token`/`tokenProvider` 与令牌 `ttlSeconds` |
| 订阅回 `FORBIDDEN` | 令牌的 subscribe 范围不含该主题，或订了别人的 `user.{id}` 私人主题 | 调令牌签发的 `subscribe` 列表 |
| 浏览器报 CORS 错误 | 跨域且 Origin 不在允许列表（或预检被代理拦） | 服务端 `CORSOrigins` 加上前端域名 |
| 一直是长轮询、升不回 WS | WS 被代理/网关挡了（长轮询是降级态，能通是正常的） | 查代理对 Upgrade 头的支持；排障可强制 `transport: "poll"` 对照 |
| 断网后状态分不清网络还是服务 | 看状态事件的 `info.reason` | `probe:network` = 网络段不通；`probe:service` = 基站服务不通 |
| 偶发消息缺口 | 断线超 30 秒宽限期或队列溢出（>512） | `onSeqGap` 里做全量刷新；高频源攒批 |
| 两个标签页互相顶掉会话 | 同一浏览器里两个独立客户端实例用了同一持久化会话 | 页面内只保留一个单例；多标签用 5.7 的 SharedWorker 形态 |
| go get 拉不到模块 | 私有仓库未登录或未设 GOPRIVATE | 按 1.1 处理；或改走 vendor 目录 vendoring |

## 版本与维护

- 五个 npm 包与 Go module 同仓同版本节奏，当前 **1.0.0**。
- 本地打包验证：`npm run pack:packages`（产物在 `packs/`）。
- Go 侧无单独发布动作：推送到 GitHub 分支即分发，消费者用
  `go get github.com/moboer/musecode/server@<分支或版本>` 锁定。
