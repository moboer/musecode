# 基站集成指南（把基站装进你自己的项目）

基站按“标准组件”交付：**后端是一个 Go module，前端是 5 个 npm 包**。
宿主项目不需要改结构、不需要理解基站内部实现，两边各加几行代码即可。

| 端 | 制品 | 获取方式 |
|---|---|---|
| 后端 | Go module `github.com/moboer/musecode/server`，集成面是其中的 `basestation` 包 | `go get`（go.mod require） |
| 前端协议 | `@basestation/protocol`（信封/错误码/主题类型，零依赖） | npm |
| 前端 SDK | `@basestation/client`（单连接多路复用、按需订阅、WS/长轮询切换、会话续接、SharedWorker） | npm |
| 前端组件 | `@basestation/component`（`<base-station>` / `<bs-subscribe>`，框架无关） | npm |
| 前端绑定 | `@basestation/react`、`@basestation/vue` | npm |

---

## 一、后端集成（Go）

### 1.1 引入

```bash
go get github.com/moboer/musecode/server@basestaiton
```

`@basestaiton` 是项目所在分支名（go 支持按分支/提交拉取并锁定为伪版本）；
正式发版后改用语义化版本 `@v1.x.y`。私有仓库时，确保本机 git 已登录对应
GitHub 账号，并设置 `GOPRIVATE=github.com/moboer/*`。

### 1.2 独立运行（零侵入：基站自己监听一个端口）

宿主 `main` 里加这些就够了——注册你自己的请求处理器、在任意 goroutine 里
发布事件、最后一行启动：

```go
package main

import (
	"context"
	"log"
	"time"

	"github.com/moboer/musecode/server/basestation"
)

func main() {
	srv := basestation.New(basestation.Config{
		// 生产环境打开全链路鉴权：
		// AuthMode: "jwt", AuthSecret: os.Getenv("BS_AUTH_SECRET"),
	})
	defer srv.Close()

	// 请求-响应：前端 client.request("orders.create", {...}) 会打到这里
	srv.HandleRequest("orders.create", func(ctx context.Context, req basestation.Request) (any, error) {
		var in struct {
			SKU string `json:"sku"`
		}
		if err := req.Decode(&in); err != nil || in.SKU == "" {
			return nil, basestation.NewError("BAD_MESSAGE", "sku required")
		}
		return map[string]any{"orderId": "o-1001", "sku": in.SKU}, nil
	})

	// 事件发布：采集/定时任务里直接调，订阅了 orders.created 的前端都会收到
	go func() {
		for range time.Tick(2 * time.Second) {
			srv.Publish("orders.created", map[string]any{"orderId": "o-1001"})
		}
	}()

	if err := srv.Serve(context.Background(), ":8080"); err != nil {
		log.Fatal(err)
	}
}
```

### 1.3 嵌入现有 HTTP 服务（与宿主共用端口）

基站对外就是一个 `http.Handler`（提供 `/ws`、`/api/sessions`、`/api/health`、
`/api/auth/*`），挂到你现有的 mux 上即可，不新开端口：

```go
mux := http.NewServeMux()
mux.Handle("/", srv.Handler()) // 基站路由
// 你原有的路由照常注册……
```

注意路径占用：基站会接管 `/ws` 与 `/api/` 前缀，宿主不要在这些路径上再注册
自己的处理器。

### 1.4 Config 要点

零值就是开发配置。生产至少改两处：

| 字段 | 说明 | 默认 |
|---|---|---|
| `AuthMode` / `AuthSecret` | `"none"` 开发免验；`"jwt"` 开启五关全链路验证（建连验、订阅 ACL、私人主题、请求盖章、限流踢线、吊销） | `none` |
| `DevToken` | 开发令牌签发端点，仅内网调试开 | `false` |
| `Grace` / `Heartbeat` / `PollWait` / `HandlerTimeout` | 会话宽限期 / 心跳 / 轮询挂起 / 处理器超时 | 30s / 15s / 25s / 10s |
| `MaxConnsPerUser`、`DefaultRatePerSec` | 单用户连接上限、默认限流（令牌自带 rate 时以令牌为准） | 10 / 不限 |
| `DisableRegistry` | 注册表只校验**已登记**主题的 payload 形状，未登记的自有主题自动放行，一般不用关 | 开启 |
| `DemoBusiness` | 内置演示业务（echo/metrics/news）。**真实项目保持关闭**，只注册自己的处理器 | 关闭 |

处理器约定：返回 `(结果, nil)`；业务错误用 `basestation.NewError("码", "说明")`，
码会原样下发到前端的错误对象；返回普通 `error` 统一变成 `HANDLER_ERROR`。
`Request` 里带 `SessionID` 以及 jwt 模式下服务端盖章的 `Tenant` / `Sender`
（可信，业务不要再自验令牌）。

---

## 二、前端集成（npm）

```bash
npm install @basestation/client        # SDK（会自动带上 @basestation/protocol）
npm install @basestation/component     # 可选：Web Component
npm install @basestation/react         # 可选：React 项目
npm install @basestation/vue           # 可选：Vue 项目
```

四种用法任选其一，都是几行：

### 2.1 原生 / 任意框架：SDK

```ts
import { BaseStationClient } from "@basestation/client";
import { Topics } from "@basestation/protocol";

const client = new BaseStationClient({ url: "http://localhost:8080" });
await client.connect();

client.subscribe(Topics.MetricsCpu, (p) => console.log("cpu", p.value));
const info = await client.request(Topics.SystemInfo, {});
```

多标签页共享一条连接（标准版默认能力）：把构造换成
`createBestClient({ url })`——支持 SharedWorker 的浏览器下全标签共用一条 WS，
不支持时自动降级为每页一条。

### 2.2 Web Component（零框架代码）

```html
<script type="module">
  import "@basestation/component";
</script>

<base-station url="http://localhost:8080">
  <bs-subscribe topic="metrics.cpu"></bs-subscribe>
</base-station>
```

`<bs-subscribe>` 收到消息会派发 `bs-message` 事件并渲染 payload；
也可以用它自己的 `client` 或注入页面单例（见包内类型说明）。

### 2.3 React

```tsx
import { BaseStationProvider, useSubscription } from "@basestation/react";
import { Topics } from "@basestation/protocol";

export const App = () => (
  <BaseStationProvider url="http://localhost:8080">
    <CpuMeter />
  </BaseStationProvider>
);

function CpuMeter() {
  useSubscription(Topics.MetricsCpu, (p) => console.log("cpu", p.value));
  return null;
}
```

### 2.4 Vue 3

```ts
import { createBaseStationPlugin, useSubscription } from "@basestation/vue";

app.use(createBaseStationPlugin({ url: "http://localhost:8080" }));

// 组件内：
useSubscription("metrics.cpu", (p) => console.log("cpu", p.value));
```

### 2.5 弱网与重连（自动，两个选项可调）

断线后的恢复顺序是**先探网络、再探服务**：每轮先对基站 `/api/health` 做
一次轻量试探（2 秒超时），不通就保持重连退避、**不白试 WS、也不降级轮询**
（网络全断时降级没有意义）；通了才走 WS → 轮询阶梯，WS 只是被代理挡住时
降级轮询并持续探测升回。会话在服务端保留 30 秒，断线期间的消息排队待发、
重连后自动续接，订阅自动重放，业务代码什么都不用管。可调项：

```ts
new BaseStationClient({
  url,
  networkProbeTimeoutMs: 2000,          // 试探超时；0 = 禁用试探（旧行为）
  // networkProbe: async () => true,    // 自定义试探（如改探业务网关）
  reconnect: { baseDelayMs: 500, maxDelayMs: 10_000 },  // 退避节奏
});
```

### 2.6 鉴权（后端 jwt 模式时）

前端只需带上令牌，其余验证都在后端：

```ts
new BaseStationClient({
  url,
  tokenProvider: async () => (await myAuthApi.exchange()).token, // 或固定 token: "..."
});
```

---

## 三、版本与发布（维护者）

- 五个 npm 包与 Go module 同仓同版本节奏，当前 **1.0.0**。
- 本地打包验证：`npm run pack:packages`（构建并打包 5 个 tarball 到 `packs/`，
  与 registry 发布物内容一致，可用 `file:` 方式先装进目标项目验证）。
- 正式发布到 npm（需维护者的 npm 账号拥有 `@basestation` scope）：
  在各包目录按依赖顺序执行 `npm publish`（protocol → client → component →
  react → vue），每个包的 `prepublishOnly` 会自动重新构建。
- Go 侧无单独发布动作：推送到 GitHub 分支即是分发；消费者用
  `go get github.com/moboer/musecode/server@<分支或版本>` 拉取锁定。

## 四、边界（集成前先确认）

- 单帧上限 1MB（整帧计）。大文件不要塞进消息体，传引用。
- 每会话出站队列 512 帧：持续速率远超消费速度时，慢订阅者会被丢帧并计数
  （`DroppedTotal` 可观测、事件有 seq 可查缺口）。高频业务请在源头攒批/限速。
- 性能量级（1.5 vCPU 小机器实测）：请求-响应聚合约 1.9 万次/秒、单订阅者
  事件无损约 4 万条/秒（256B）。详见《基站性能上限与工业适用性报告》。
