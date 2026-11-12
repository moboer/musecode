// 把 5 个可发布包按依赖顺序构建并打包到 ./packs/（发布前的本地验证/离线分发用）。
// 正式发布到 npm 见 docs/integration.md 的“发布新版本”一节。
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packsDir = join(root, "packs");
const order = ["protocol", "client", "component", "react", "vue"];

rmSync(packsDir, { recursive: true, force: true });
mkdirSync(packsDir, { recursive: true });

execSync("npx tsc -b", { cwd: root, stdio: "inherit" });
for (const name of order) {
  const dir = join(root, "packages", name);
  const out = execSync(`npm pack --pack-destination "${packsDir}"`, { cwd: dir, encoding: "utf8" });
  console.log("packed:", out.trim().split("\n").pop());
}
console.log("done ->", packsDir);
