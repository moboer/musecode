// Package protocol 定义基站与客户端之间唯一的消息信封，是前后端的共同契约。
package protocol

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
)

// 消息类型。与 packages/protocol 中的 MessageType 保持一致。
const (
	TypeHello   = "hello"
	TypePing    = "ping"
	TypePong    = "pong"
	TypeReq     = "req"
	TypeRes     = "res"
	TypeSub     = "sub"
	TypeSubOK   = "subok"
	TypeUnsub   = "unsub"
	TypeUnsubOK = "unsubok"
	TypeEvent   = "event"
	TypeError   = "error"
)

// 错误码。与 packages/protocol 中的 ErrorCode 保持一致。
const (
	CodeBadMessage           = "BAD_MESSAGE"
	CodeUnknownTopic         = "UNKNOWN_TOPIC"
	CodeHandlerError         = "HANDLER_ERROR"
	CodeTimeout              = "TIMEOUT"
	CodeSessionNotFound      = "SESSION_NOT_FOUND"
	CodeSessionReplaced      = "SESSION_REPLACED"
	CodeTransportUnavailable = "TRANSPORT_UNAVAILABLE"
	CodeNotSubscribed        = "NOT_SUBSCRIBED"
	CodeInternal             = "INTERNAL"
)

// MessageError 是信封中的错误字段。无论成功与否该字段都必须存在，成功时为 null。
type MessageError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
	Details   any    `json:"details,omitempty"`
}

// Message 是所有通信帧的统一信封。
//
// 必填字段：type、id、ts、payload、error。其中 payload 缺省为 {}，
// error 恒序列化（成功为 null）。
type Message struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	TS      int64           `json:"ts"`
	Payload json.RawMessage `json:"payload"`
	Error   *MessageError   `json:"error"`

	Topic     string `json:"topic,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	ReplyTo   string `json:"replyTo,omitempty"`
	Seq       int64  `json:"seq,omitempty"`
}

// NewMessage 构造一个信封，自动填充 id、ts 与空 payload。
func NewMessage(typ, topic string) Message {
	return Message{
		Type:    typ,
		ID:      NewID(),
		TS:      time.Now().UnixMilli(),
		Payload: json.RawMessage("{}"),
		Topic:   topic,
	}
}

// NewID 生成 32 位十六进制唯一标识。
func NewID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand 不可用时退化为时间戳，保证不 panic。
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(buf)
}

// MarshalPayload 将任意业务数据编码为 RawMessage，nil 归一化为 {}。
func MarshalPayload(v any) json.RawMessage {
	if v == nil {
		return json.RawMessage("{}")
	}
	if raw, ok := v.(json.RawMessage); ok {
		if len(raw) == 0 || string(raw) == "null" {
			return json.RawMessage("{}")
		}
		return raw
	}
	buf, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("{}")
	}
	if string(buf) == "null" {
		return json.RawMessage("{}")
	}
	return buf
}

// Normalize 补齐 payload 与 ts，用于入站帧。
func (m *Message) Normalize() {
	if len(m.Payload) == 0 || string(m.Payload) == "null" {
		m.Payload = json.RawMessage("{}")
	}
	if m.TS <= 0 {
		m.TS = time.Now().UnixMilli()
	}
}

// Validate 校验必填字段，返回 nil 表示合法。
func (m *Message) Validate() *MessageError {
	switch {
	case m.Type == "":
		return &MessageError{Code: CodeBadMessage, Message: "missing field: type", Retryable: false}
	case !IsKnownType(m.Type):
		return &MessageError{Code: CodeBadMessage, Message: "unknown message type: " + m.Type, Retryable: false}
	case m.ID == "":
		return &MessageError{Code: CodeBadMessage, Message: "missing field: id", Retryable: false}
	case m.TS <= 0:
		return &MessageError{Code: CodeBadMessage, Message: "missing field: ts", Retryable: false}
	case len(m.Payload) > 0 && !json.Valid(m.Payload):
		return &MessageError{Code: CodeBadMessage, Message: "payload is not valid JSON", Retryable: false}
	}
	if requiresTopic(m.Type) && m.Topic == "" {
		return &MessageError{Code: CodeBadMessage, Message: "missing field: topic", Retryable: false}
	}
	return nil
}

func requiresTopic(typ string) bool {
	switch typ {
	case TypeReq, TypeSub, TypeUnsub:
		return true
	default:
		return false
	}
}

// IsKnownType 判断是否为协议内定义的消息类型。
func IsKnownType(typ string) bool {
	switch typ {
	case TypeHello, TypePing, TypePong, TypeReq, TypeRes,
		TypeSub, TypeSubOK, TypeUnsub, TypeUnsubOK, TypeEvent, TypeError:
		return true
	default:
		return false
	}
}

// MarshalJSON 保证 payload 与 error 两个必填字段一定出现在输出中。
func (m Message) MarshalJSON() ([]byte, error) {
	type alias struct {
		Type      string          `json:"type"`
		ID        string          `json:"id"`
		TS        int64           `json:"ts"`
		Payload   json.RawMessage `json:"payload"`
		Error     *MessageError   `json:"error"`
		Topic     string          `json:"topic,omitempty"`
		SessionID string          `json:"sessionId,omitempty"`
		ReplyTo   string          `json:"replyTo,omitempty"`
		Seq       int64           `json:"seq,omitempty"`
	}
	payload := m.Payload
	if len(payload) == 0 || string(payload) == "null" {
		payload = json.RawMessage("{}")
	}
	return json.Marshal(alias{
		Type:      m.Type,
		ID:        m.ID,
		TS:        m.TS,
		Payload:   payload,
		Error:     m.Error,
		Topic:     m.Topic,
		SessionID: m.SessionID,
		ReplyTo:   m.ReplyTo,
		Seq:       m.Seq,
	})
}

// TopicMatches 判断主题是否命中订阅模式。
//
//	"*"       → 全部主题
//	"prefix.*"→ 以 "prefix." 开头的全部主题
//	其他       → 精确匹配
func TopicMatches(pattern, topic string) bool {
	if pattern == "*" {
		return true
	}
	if strings.HasSuffix(pattern, ".*") {
		prefix := pattern[:len(pattern)-1] // 形如 "metrics."
		return len(topic) > len(prefix) && strings.HasPrefix(topic, prefix)
	}
	return pattern == topic
}
