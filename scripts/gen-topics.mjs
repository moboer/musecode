// 代码生成：registry/topics.json → 双端生成代码（方案 v2 §5 注册表单一事实来源）。
// 产物：packages/protocol/src/topics.ts（常量/元数据/payload 类型）
//       server/internal/registry/topics_gen.go（服务端校验表）
// 生成文件禁止手改；改注册表后重跑 npm run gen:topics。
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const registry = JSON.parse(readFileSync(`${root}registry/topics.json`, "utf8"));
const topics = [...registry.topics].sort((a, b) => a.name.localeCompare(b.name));

const pascal = (name) =>
  name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");

const TS_TYPE = { string: "string", number: "number", boolean: "boolean", object: "Record<string, unknown>", array: "unknown[]" };

// ---------- TS ----------
let ts = `/**
 * GENERATED from registry/topics.json —— 禁止手改，改注册表后运行 npm run gen:topics。
 * Topic 注册表的前端镜像：常量、元数据与 payload 类型与服务端校验表同源生成。
 */

export const Topics = {
`;
for (const t of topics) ts += `  ${pascal(t.name)}: "${t.name}",\n`;
ts += `} as const;

export type TopicName = (typeof Topics)[keyof typeof Topics];

export interface TopicMeta {
  direction: "request" | "event";
  /** 投递意图（声明语义，不写协议参数） */
  delivery: "at-least-once" | "latest-only";
  retention: "none" | "last";
  since: string;
}

export const TOPIC_META: Record<string, TopicMeta> = {
`;
for (const t of topics) {
  ts += `  "${t.name}": { direction: "${t.direction}", delivery: "${t.delivery}", retention: "${t.retention}", since: "${t.since}" },\n`;
}
ts += `};
`;
for (const t of topics) {
  const props = t.schema?.properties;
  if (!props) continue;
  const required = new Set(t.schema.required ?? []);
  ts += `\nexport interface ${pascal(t.name)}Payload {\n`;
  for (const [field, spec] of Object.entries(props)) {
    ts += `  ${field}${required.has(field) ? "" : "?"}: ${TS_TYPE[spec.type] ?? "unknown"};\n`;
  }
  ts += `}\n`;
}

// ---------- Go ----------
let go = `// Code generated from registry/topics.json. DO NOT EDIT.\n// 改注册表后运行 npm run gen:topics 重新生成。\n\npackage registry\n\n// Entries 是注册表的编译期镜像（由 scripts/gen-topics.mjs 生成）。\nvar Entries = []Entry{\n`;
for (const t of topics) {
  const props = t.schema?.properties ?? {};
  const required = new Set(t.schema?.required ?? []);
  const fields = Object.entries(props)
    .map(([field, spec]) => `{Name: "${field}", Type: "${spec.type}", Required: ${required.has(field)}}`)
    .join(", ");
  go += `\t{Name: "${t.name}", Direction: "${t.direction}", Fields: []FieldSpec{${fields}}},\n`;
}
go += `}\n`;

writeFileSync(`${root}packages/protocol/src/topics.ts`, ts);
writeFileSync(`${root}server/internal/registry/topics_gen.go`, go);
console.log(`gen:topics 完成：${topics.length} 个主题 → packages/protocol/src/topics.ts, server/internal/registry/topics_gen.go`);
