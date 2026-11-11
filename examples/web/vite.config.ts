import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const clientSrc = fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url));
const workerEntrySrc = fileURLToPath(
  new URL("../../packages/client/src/hosts/worker-entry.ts", import.meta.url),
);
const protocolSrc = fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url));
const componentSrc = fileURLToPath(new URL("../../packages/component/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    // 数组形式按序匹配：worker-entry 子路径必须排在 @basestation/client 之前
    alias: [
      { find: "@basestation/client/hosts/worker-entry", replacement: workerEntrySrc },
      { find: "@basestation/client", replacement: clientSrc },
      { find: "@basestation/protocol", replacement: protocolSrc },
      { find: "@basestation/component", replacement: componentSrc },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true },
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
