package registry

import (
	"encoding/json"
	"testing"

	"basestation/internal/protocol"
)

func TestValidateRequestPayload(t *testing.T) {
	r := Default()

	// 未注册主题：开放模式放行
	if err := r.ValidateRequestPayload("unknown.topic", json.RawMessage(`{"x":1}`)); err != nil {
		t.Fatalf("unregistered topic should pass, got %v", err)
	}
	// 已注册但无字段约束（echo）：任意对象都行，非对象不行
	if err := r.ValidateRequestPayload("echo", json.RawMessage(`{"hello":"world"}`)); err != nil {
		t.Fatalf("echo object payload should pass, got %v", err)
	}
	if err := r.ValidateRequestPayload("echo", json.RawMessage(`[1,2]`)); err == nil || err.Code != protocol.CodeBadMessage {
		t.Fatalf("echo array payload should be BAD_MESSAGE, got %v", err)
	}
	// slow.echo 的可选字段类型错误要拦
	if err := r.ValidateRequestPayload("slow.echo", json.RawMessage(`{"delayMs":"soon"}`)); err == nil {
		t.Fatal("delayMs as string should be rejected")
	}
	if err := r.ValidateRequestPayload("slow.echo", json.RawMessage(`{"delayMs":200}`)); err != nil {
		t.Fatalf("delayMs number should pass, got %v", err)
	}
}

func TestGeneratedEntriesCoverBizTopics(t *testing.T) {
	r := Default()
	for _, name := range []string{"echo", "system.info", "metrics.snapshot", "slow.echo", "boom", "metrics.cpu", "metrics.mem", "news.notice"} {
		if _, ok := r.Lookup(name); !ok {
			t.Errorf("topic %s missing from registry", name)
		}
	}
	if e, _ := r.Lookup("metrics.cpu"); e.Direction != "event" {
		t.Errorf("metrics.cpu should be event, got %s", e.Direction)
	}
}
