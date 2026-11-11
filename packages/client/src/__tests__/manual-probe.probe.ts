// 活服务器探针（不属于默认测试套件）：需要先 `npm run dev` 起好基站与演示页，
// 再单独运行 `npm run test:probe`。文件名后缀 .probe.ts 使其不被默认 vitest 配置收录。
import { describe, it } from "vitest";

import { BaseStationClient } from "../client.js";

describe("manual probe", () => {
  it("force degrade against a live server", async () => {
    const logs: string[] = [];
    const client = new BaseStationClient({
      url: "http://localhost:5173",
      transport: "auto",
      sessionStorageKey: false,
      logger: (level, event, meta) => logs.push(`${level} ${event} ${JSON.stringify(meta ?? "")}`),
    });
    client.onStateChange((state, info) =>
      logs.push(`STATE ${info.previous}->${state} (${info.reason}) transport=${info.transport}`),
    );

    await client.connect();
    logs.push(`CONNECTED state=${client.state} kind=${client.transportKind} session=${client.sessionId}`);

    client.forceDegrade(15_000);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    logs.push(`FINAL state=${client.state} kind=${client.transportKind} session=${client.sessionId}`);

    console.log(logs.join("\n"));
    await client.disconnect();
  }, 30_000);
});
