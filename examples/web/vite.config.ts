import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const clientSrc = fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url));
const protocolSrc = fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@basestation/client": clientSrc,
      "@basestation/protocol": protocolSrc,
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8080", changeOrigin: true },
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
