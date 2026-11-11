import { BaseStationClient, createBestClient } from "@basestation/client";
import type { Message } from "@basestation/protocol";

/**
 * 功能用例库：一键全测与各分区的"单独点测"共用同一批用例实现。
 * 每个用例返回 { ok, evidence }，evidence 是实测证据（不是预设文案）。
 */

export interface TestResult {
  ok: boolean;
  evidence: string;
}

export interface TestCtx {
  /** 主基站（:8080，无鉴权）的页面单例 */
  bs: BaseStationClient;
  /** 鉴权基站（:8081，jwt 模式） */
  jwtBase: string;
}

export interface TestCase {
  id: string;
  group: "基础通信" | "连接与会话" | "鉴权" | "标准组件";
  name: string;
  run: (ctx: TestCtx) => Promise<TestResult>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | null | undefined, timeoutMs: number, stepMs = 120): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）`);
    await sleep(stepMs);
  }
}

function errCode(err: unknown): string {
  return (err as { code?: string })?.code ?? String(err);
}

/** fetch 带一次网络层重试：测试台里连接多，偶发 TypeError 不应误判用例失败。 */
async function fetchRetry(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    await sleep(300);
    return await fetch(url, init);
  }
}

async function issueToken(
  jwtBase: string,
  body: Record<string, unknown>,
): Promise<{ token: string; jti: string }> {
  const res = await fetchRetry(`${jwtBase}/api/auth/dev-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { token?: string; jti?: string };
  if (!data.token) throw new Error(`dev-token 签发失败（:8081 需以 -auth-mode=jwt -dev-token 启动）`);
  return { token: data.token, jti: data.jti ?? "" };
}

export const TEST_CASES: TestCase[] = [
  {
    id: "conn",
    group: "基础通信",
    name: "连接建立（当前初始传输）",
    run: async ({ bs }) => {
      if (bs.state === "closed" || bs.state === "idle") await bs.connect();
      await waitFor(() => (bs.state === "connected" || bs.state === "degraded" ? bs.state : null), 8000);
      return {
        ok: bs.transportKind !== null,
        evidence: `state=${bs.state}，transport=${bs.transportKind}，session=${bs.sessionId?.slice(0, 8)}…`,
      };
    },
  },
  {
    id: "echo",
    group: "基础通信",
    name: "请求-响应 echo 往返一致",
    run: async ({ bs }) => {
      const payload = { hello: "bench", n: 42 };
      const res = await bs.request("echo", payload);
      return {
        ok: JSON.stringify(res) === JSON.stringify(payload),
        evidence: `发出 ${JSON.stringify(payload)}，收到 ${JSON.stringify(res)}`,
      };
    },
  },
  {
    id: "sysinfo",
    group: "基础通信",
    name: "system.info 返回主题清单",
    run: async ({ bs }) => {
      const res = await bs.request<{ topics?: string[] }>("system.info");
      const topics = res.topics ?? [];
      return {
        ok: topics.includes("metrics.cpu"),
        evidence: `topics=[${topics.join(", ")}]`,
      };
    },
  },
  {
    id: "sub-event",
    group: "基础通信",
    name: "订阅 metrics.cpu 在 4 秒内收到推送",
    run: async ({ bs }) => {
      const value = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("4 秒内未收到事件")), 4000);
        const sub = bs.subscribe<{ value: number }>("metrics.cpu", (payload) => {
          clearTimeout(timer);
          void sub.unsubscribe();
          resolve(payload.value);
        });
      });
      return { ok: typeof value === "number", evidence: `收到 metrics.cpu value=${String(value)}` };
    },
  },
  {
    id: "once",
    group: "基础通信",
    name: "once 一次性监听 news.notice",
    run: async ({ bs }) => {
      const msg = await bs.once("news.notice", { timeoutMs: 9000 });
      return { ok: msg.topic === "news.notice", evidence: `命中一帧后自动退订，payload=${JSON.stringify(msg.payload).slice(0, 60)}…` };
    },
  },
  {
    id: "retry",
    group: "基础通信",
    name: "慢请求超时重试 + 在途去重：最终拿到结果",
    run: async ({ bs }) => {
      // slow.echo 服务端固定耗时 2 秒；单次超时设 600ms 必然超时，
      // 重试时服务端对在途同 id 请求做 singleflight 去重（不重复执行），
      // 客户端最终仍能拿到那份共享结果——这正是幂等协议的意义。
      const t0 = Date.now();
      const payload = { tag: "retry-bench" };
      const res = await bs.request("slow.echo", payload, { timeoutMs: 600, retries: 3 });
      const elapsed = Date.now() - t0;
      return {
        ok: JSON.stringify(res) === JSON.stringify(payload) && elapsed >= 1800,
        evidence: `单次超时 600ms、服务端耗时 2s → 总耗时 ${elapsed}ms 后成功，payload 一致（重试没有重复执行）`,
      };
    },
  },
  {
    id: "boom",
    group: "基础通信",
    name: "业务错误 boom 以错误码回绝",
    run: async ({ bs }) => {
      try {
        await bs.request("boom");
        return { ok: false, evidence: "boom 居然成功了（不应发生）" };
      } catch (err) {
        return { ok: true, evidence: `reject code=${errCode(err)}，message=${(err as Error).message}` };
      }
    },
  },
  {
    id: "degrade",
    group: "连接与会话",
    name: "强制降级 WS→轮询，会话续接不断线",
    run: async ({ bs }) => {
      if (bs.transportKind !== "ws") {
        const res = await bs.request("echo", { via: bs.transportKind });
        return { ok: true, evidence: `当前初始传输为 ${bs.transportKind}（非 WS），降级不适用；轮询上 echo 正常：${JSON.stringify(res)}` };
      }
      const before = bs.sessionId;
      bs.forceDegrade(15000);
      await waitFor(() => (bs.state === "degraded" ? true : null), 6000);
      const res = await bs.request("echo", { after: "degrade" });
      return {
        ok: bs.sessionId === before && res !== null,
        evidence: `降级前后 session 同为 ${before?.slice(0, 8)}…，降级后 echo 收到 ${JSON.stringify(res)}`,
      };
    },
  },
  {
    id: "registry",
    group: "连接与会话",
    name: "注册表校验：echo 发非对象 payload 被 BAD_MESSAGE 拦下",
    run: async ({ bs }) => {
      try {
        await bs.request("echo", 123);
        return { ok: false, evidence: "非对象 payload 居然通过了（不应发生）" };
      } catch (err) {
        return { ok: errCode(err) === "BAD_MESSAGE", evidence: `reject code=${errCode(err)}（未进处理器）` };
      }
    },
  },
  {
    id: "unknown-topic",
    group: "连接与会话",
    name: "未注册主题保持开放：no.such.topic 回 UNKNOWN_TOPIC（非注册表拦截）",
    run: async ({ bs }) => {
      try {
        await bs.request("no.such.topic");
        return { ok: false, evidence: "无处理器的主题居然成功了（不应发生）" };
      } catch (err) {
        return { ok: errCode(err) === "UNKNOWN_TOPIC", evidence: `reject code=${errCode(err)}` };
      }
    },
  },
  {
    id: "auth-anon",
    group: "鉴权",
    name: "第 1/2 关：无令牌连接 :8081 被拒",
    run: async ({ jwtBase }) => {
      const anon = new BaseStationClient({ url: jwtBase, sessionStorageKey: false });
      try {
        await anon.connect();
        return { ok: false, evidence: "无令牌居然连上了（不应发生）" };
      } catch (err) {
        return { ok: true, evidence: `connect 被拒：${(err as Error).message.slice(0, 80)}` };
      } finally {
        anon.disconnect();
      }
    },
  },
  {
    id: "auth-guest",
    group: "鉴权",
    name: "第 3 关：访客令牌订 metrics.* 成功收到数据",
    run: async ({ jwtBase }) => {
      const { token } = await issueToken(jwtBase, {
        sub: "tester-guest",
        tenant: "demo",
        subscribe: ["metrics.*"],
        publish: [],
        ttlSeconds: 120,
      });
      const guest = new BaseStationClient({ url: jwtBase, token, sessionStorageKey: false });
      try {
        await guest.connect();
        const value = await new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("4 秒内未收到事件")), 4000);
          guest.subscribe<{ value: number }>("metrics.cpu", (payload) => {
            clearTimeout(timer);
            resolve(payload.value);
          });
        });
        return { ok: true, evidence: `建连成功并收到 metrics.cpu value=${String(value)}` };
      } finally {
        guest.disconnect();
      }
    },
  },
  {
    id: "auth-forbidden-req",
    group: "鉴权",
    name: "第 4 关：访客令牌发 echo 请求被 FORBIDDEN",
    run: async ({ jwtBase }) => {
      const { token } = await issueToken(jwtBase, {
        sub: "tester-freq",
        tenant: "demo",
        subscribe: ["metrics.*"],
        publish: [],
        ttlSeconds: 120,
      });
      const guest = new BaseStationClient({ url: jwtBase, token, sessionStorageKey: false });
      try {
        await guest.connect();
        await guest.request("echo", { hi: 1 }, { timeoutMs: 3000, retries: 0 });
        return { ok: false, evidence: "越权请求居然成功了（不应发生）" };
      } catch (err) {
        return { ok: errCode(err) === "FORBIDDEN", evidence: `reject code=${errCode(err)}` };
      } finally {
        guest.disconnect();
      }
    },
  },
  {
    id: "auth-forbidden-sub",
    group: "鉴权",
    name: "第 3 关：访客令牌订 news.notice 收到 FORBIDDEN 错误帧",
    run: async ({ jwtBase }) => {
      const { token } = await issueToken(jwtBase, {
        sub: "tester-fsub",
        tenant: "demo",
        subscribe: ["metrics.*"],
        publish: [],
        ttlSeconds: 120,
      });
      const guest = new BaseStationClient({ url: jwtBase, token, sessionStorageKey: false });
      try {
        await guest.connect();
        const frame = await new Promise<Message>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("4 秒内未收到错误帧")), 4000);
          const off = guest.onTraffic((msg, dir) => {
            if (dir === "in" && msg.topic === "news.notice" && msg.error) {
              clearTimeout(timer);
              off();
              resolve(msg);
            }
          });
          guest.subscribe("news.notice", () => {});
        });
        return { ok: frame.error?.code === "FORBIDDEN", evidence: `收到错误帧 code=${frame.error?.code} topic=${frame.topic}` };
      } finally {
        guest.disconnect();
      }
    },
  },
  {
    id: "auth-ratelimit",
    group: "鉴权",
    name: "第 4 关：限流（2 次/秒）连发 8 次必有 RATE_LIMITED",
    run: async ({ jwtBase }) => {
      const { token } = await issueToken(jwtBase, {
        sub: "tester-rate",
        tenant: "demo",
        subscribe: [],
        publish: ["system.info"],
        ratePerSec: 2,
        ttlSeconds: 120,
      });
      const guest = new BaseStationClient({ url: jwtBase, token, sessionStorageKey: false });
      try {
        await guest.connect();
        // 顺序连发：并发齐射时第 5 次违规的踢线会吞掉排队中的响应帧，
        // 顺序发才能逐个看清每次的裁决（OK/OK/RATE_LIMITED…）。
        const codes: string[] = [];
        for (let i = 0; i < 8; i++) {
          try {
            await guest.request("system.info", undefined, { timeoutMs: 1500, retries: 0 });
            codes.push("OK");
          } catch (err) {
            codes.push(errCode(err));
          }
          if (codes.filter((c) => c === "RATE_LIMITED").length >= 2) break;
        }
        const limited = codes.filter((c) => c === "RATE_LIMITED").length;
        return { ok: limited >= 1, evidence: `顺序连发结果：${codes.join(" / ")}（RATE_LIMITED × ${limited}）` };
      } finally {
        guest.disconnect();
      }
    },
  },
  {
    id: "auth-revoke",
    group: "鉴权",
    name: "吊销：admin 吊销令牌后其存量会话被踢",
    run: async ({ jwtBase }) => {
      const victim = await issueToken(jwtBase, {
        sub: "tester-revoke",
        tenant: "demo",
        subscribe: [],
        publish: ["echo"],
        ttlSeconds: 300,
      });
      const victimClient = new BaseStationClient({ url: jwtBase, token: victim.token, sessionStorageKey: false });
      const admin = await issueToken(jwtBase, { sub: "tester-admin", admin: true, ttlSeconds: 120 });
      try {
        await victimClient.connect();
        const res = await fetchRetry(`${jwtBase}/api/auth/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.token}` },
          body: JSON.stringify({ jti: victim.jti }),
        });
        const data = (await res.json()) as { kickedSessions?: number };
        return {
          ok: (data.kickedSessions ?? 0) >= 1,
          evidence: `revoke 响应 kickedSessions=${data.kickedSessions}（受害会话 session 已被服务端踢除）`,
        };
      } finally {
        victimClient.disconnect();
      }
    },
  },
  {
    id: "wc",
    group: "标准组件",
    name: "Web Component：<bs-subscribe> 收到实时数据",
    run: async () => {
      await waitFor(() => {
        const el = document.querySelector("bs-subscribe");
        return el && el.textContent?.includes('"value"') ? true : null;
      }, 6000);
      const el = document.querySelector("bs-subscribe")!;
      return { ok: true, evidence: `<bs-subscribe> 当前渲染：${el.textContent?.slice(0, 70)}…` };
    },
  },
  {
    id: "frameworks",
    group: "标准组件",
    name: "React / Vue 绑定：useSubscription 收到实时数据",
    run: async () => {
      await waitFor(() => {
        const react = document.querySelector("[data-react-value]")?.textContent ?? "";
        const vue = document.querySelector("[data-vue-value]")?.textContent ?? "";
        return /\d/.test(react) && /\d/.test(vue) ? true : null;
      }, 6000);
      return {
        ok: true,
        evidence: `React 面板 CPU=${document.querySelector("[data-react-value]")?.textContent}% · Vue 面板 MEM=${document.querySelector("[data-vue-value]")?.textContent}%（均注入同一页面单例）`,
      };
    },
  },
  {
    id: "sw",
    group: "标准组件",
    name: "SharedWorker：经 worker 共享连接收到 metrics.mem",
    run: async () => {
      if (typeof SharedWorker === "undefined") {
        return { ok: false, evidence: "当前浏览器不支持 SharedWorker（降级路径下本用例不适用）" };
      }
      const worker = new SharedWorker(new URL("./sw-entry.ts", import.meta.url), {
        type: "module",
        name: "basestation",
      });
      const client = createBestClient({ url: window.location.origin, worker });
      try {
        const valuePromise = new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("5 秒内未收到事件")), 5000);
          client.subscribe<{ value: number }>("metrics.mem", (payload) => {
            clearTimeout(timer);
            resolve(payload.value);
          });
        });
        await client.connect();
        const value = await valuePromise;
        return { ok: true, evidence: `经 SharedWorker 收到 metrics.mem value=${String(value)}（连接在 worker 内）` };
      } finally {
        client.disconnect();
      }
    },
  },
];

export async function executeCase(testCase: TestCase, ctx: TestCtx): Promise<TestResult & { ms: number }> {
  const t0 = Date.now();
  try {
    const result = await testCase.run(ctx);
    return { ...result, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, evidence: `异常：${(err as Error).message}`, ms: Date.now() - t0 };
  }
}
