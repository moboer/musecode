// Package registry 是 topic 注册表的服务端运行时（方案 v2 §5）：
// 注册表 JSON 是唯一事实来源，经 scripts/gen-topics.mjs 生成本包的校验表与前端类型。
// 本包负责第 4 关的 payload 结构校验：已注册主题的请求必须符合其 schema（字段/类型/必填）。
package registry

import (
	"encoding/json"

	"github.com/moboer/musecode/server/internal/protocol"
)

// FieldSpec 是 payload 的一个字段约束（由 JSON Schema 的 properties 简化生成）。
type FieldSpec struct {
	Name     string
	Type     string // string | number | boolean | object | array
	Required bool
}

// Entry 是一个已注册主题。
type Entry struct {
	Name      string
	Direction string // request | event
	Fields    []FieldSpec
}

// Registry 是可查询的注册表。
type Registry struct {
	byName map[string]Entry
}

// Default 返回由生成表构建的注册表。
func Default() *Registry {
	r := &Registry{byName: make(map[string]Entry, len(Entries))}
	for _, e := range Entries {
		r.byName[e.Name] = e
	}
	return r
}

// Lookup 查询主题是否已注册。
func (r *Registry) Lookup(topic string) (Entry, bool) {
	e, ok := r.byName[topic]
	return e, ok
}

// ValidateRequestPayload 校验已注册主题的请求 payload：
//   - 未注册主题：放行（开放模式，注册表只约束已声明契约的主题）
//   - 已注册主题：payload 必须是 JSON 对象；必填字段必须存在且类型正确；
//     可选字段若出现也必须类型正确。多余字段不拦（向前兼容）。
func (r *Registry) ValidateRequestPayload(topic string, payload json.RawMessage) *protocol.MessageError {
	entry, ok := r.byName[topic]
	if !ok {
		return nil
	}
	var body map[string]any
	if err := json.Unmarshal(payload, &body); err != nil || body == nil {
		return &protocol.MessageError{
			Code:      protocol.CodeBadMessage,
			Message:   "payload for " + topic + " must be a JSON object",
			Retryable: false,
		}
	}
	for _, field := range entry.Fields {
		value, present := body[field.Name]
		if !present {
			if field.Required {
				return &protocol.MessageError{
					Code:      protocol.CodeBadMessage,
					Message:   "payload for " + topic + " is missing required field: " + field.Name,
					Retryable: false,
				}
			}
			continue
		}
		if !typeMatches(field.Type, value) {
			return &protocol.MessageError{
				Code:      protocol.CodeBadMessage,
				Message:   "payload field " + field.Name + " for " + topic + " must be " + field.Type,
				Retryable: false,
			}
		}
	}
	return nil
}

func typeMatches(want string, value any) bool {
	switch want {
	case "string":
		_, ok := value.(string)
		return ok
	case "number":
		_, ok := value.(float64)
		return ok
	case "boolean":
		_, ok := value.(bool)
		return ok
	case "object":
		_, ok := value.(map[string]any)
		return ok
	case "array":
		_, ok := value.([]any)
		return ok
	default:
		return true
	}
}
