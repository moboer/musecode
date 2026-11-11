// Code generated from registry/topics.json. DO NOT EDIT.
// 改注册表后运行 npm run gen:topics 重新生成。

package registry

// Entries 是注册表的编译期镜像（由 scripts/gen-topics.mjs 生成）。
var Entries = []Entry{
	{Name: "boom", Direction: "request", Fields: []FieldSpec{}},
	{Name: "echo", Direction: "request", Fields: []FieldSpec{}},
	{Name: "metrics.cpu", Direction: "event", Fields: []FieldSpec{{Name: "series", Type: "string", Required: false}, {Name: "serverTs", Type: "number", Required: false}, {Name: "unit", Type: "string", Required: false}, {Name: "value", Type: "number", Required: true}}},
	{Name: "metrics.mem", Direction: "event", Fields: []FieldSpec{{Name: "series", Type: "string", Required: false}, {Name: "serverTs", Type: "number", Required: false}, {Name: "unit", Type: "string", Required: false}, {Name: "value", Type: "number", Required: true}}},
	{Name: "metrics.snapshot", Direction: "request", Fields: []FieldSpec{}},
	{Name: "news.notice", Direction: "event", Fields: []FieldSpec{{Name: "level", Type: "string", Required: false}, {Name: "noticeId", Type: "number", Required: true}, {Name: "publishedAt", Type: "number", Required: false}, {Name: "title", Type: "string", Required: true}}},
	{Name: "slow.echo", Direction: "request", Fields: []FieldSpec{{Name: "delayMs", Type: "number", Required: false}}},
	{Name: "system.info", Direction: "request", Fields: []FieldSpec{}},
}
