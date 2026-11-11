// 宿主纪律检查（方案 v2 §4.1）：packages/client 的 core 代码不得直接引用宿主环境，
// 环境依赖必须经 CoreHost 注入（host.ts 是唯一例外，它就是宿主实现本身）。
// 守住这条，将来把 core 搬进 SharedWorker 才是换宿主而不是重写。
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../packages/client/src/", import.meta.url));
const FORBIDDEN = [
  { pattern: /\bwindow\s*\./, name: "window." },
  { pattern: /\bdocument\s*\./, name: "document." },
  { pattern: /globalThis\.(localStorage|sessionStorage|WebSocket|fetch)\b/, name: "globalThis 存储/网络全局量" },
];
const EXEMPT = new Set(["host.ts"]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      yield* walk(path);
    } else if (entry.name.endsWith(".ts")) {
      yield path;
    }
  }
}

let violations = 0;
for (const file of walk(root)) {
  const base = file.split("/").at(-1);
  if (EXEMPT.has(base)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const { pattern, name } of FORBIDDEN) {
      if (pattern.test(line)) {
        violations += 1;
        console.error(`${file}:${i + 1} 禁止直接引用 ${name}，请经 CoreHost 注入：${line.trim()}`);
      }
    }
  });
}

if (violations > 0) {
  console.error(`\n宿主纪律检查失败：${violations} 处违规`);
  process.exit(1);
}
console.log("宿主纪律检查通过：core 无宿主环境直接引用");
