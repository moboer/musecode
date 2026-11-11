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
