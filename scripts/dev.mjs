#!/usr/bin/env node
// 并行启动 Go 基站与 Vite 演示页，任一退出时级联关闭另一个。
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";
const npmCmd = isWindows ? "npm.cmd" : "npm";
const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      child.kill(isWindows ? undefined : "SIGTERM");
    }
  }
  setTimeout(() => process.exit(code), 200).unref();
}

function run(label, command, args) {
  const child = spawn(command, args, { stdio: "inherit", shell: isWindows });
  child.on("exit", (code) => {
    console.log(`[dev] ${label} exited with code ${code ?? 0}`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

console.log("[dev] starting Go base station on :8080 and Vite demo on :5173 ...");
run("server", "go", ["-C", "server", "run", "./cmd/basestation"]);
run("web", npmCmd, ["-w", "examples/web", "run", "dev"]);

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
