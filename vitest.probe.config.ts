import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// 活服务器探针专用配置：只收录 *.probe.ts，需要先起好基站与演示页（npm run dev）。
export default defineConfig({
  resolve: {
    alias: {
      "@basestation/protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
      "@basestation/client": fileURLToPath(new URL("./packages/client/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["packages/*/src/**/*.probe.ts"],
    environment: "node",
  },
});
