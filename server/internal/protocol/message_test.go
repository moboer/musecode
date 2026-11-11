package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTopicMatches(t *testing.T) {
	cases := []struct {
		pattern string
		topic   string
		want    bool
	}{
		{"*", "metrics.cpu", true},
		{"*", "anything", true},
		{"metrics.*", "metrics.cpu", true},
		{"metrics.*", "metrics.cpu.user", true},
		{"metrics.*", "news.notice", false},
		{"metrics.*", "metrics", false},
		{"metrics.cpu", "metrics.cpu", true},
		{"metrics.cpu", "metrics.mem", false},
	}
	for _, c := range cases {
		if got := TopicMatches(c.pattern, c.topic); got != c.want {
			t.Errorf("TopicMatches(%q,%q)=%v want %v", c.pattern, c.topic, got, c.want)
		}
	}
}

func TestValidate(t *testing.T) {
	valid := NewMessage(TypeReq, "echo")
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid message rejected: %v", err)
	}

	cases := []struct {
		name string
		msg  Message
		code string
	}{
		{"missing type", Message{ID: "a", TS: 1}, CodeBadMessage},
		{"unknown type", Message{Type: "nope", ID: "a", TS: 1}, CodeBadMessage},
		{"missing id", Message{Type: TypePing, TS: 1}, CodeBadMessage},
		{"missing ts", Message{Type: TypePing, ID: "a"}, CodeBadMessage},
		{"missing topic", Message{Type: TypeReq, ID: "a", TS: 1}, CodeBadMessage},
	}
	for _, c := range cases {
		mErr := c.msg.Validate()
		if mErr == nil || mErr.Code != c.code {
			t.Errorf("%s: got %+v want code %s", c.name, mErr, c.code)
		}
	}
}

func TestMarshalKeepsRequiredFields(t *testing.T) {
	msg := Message{Type: TypePing, ID: "abc", TS: 1}
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, `"payload":{}`) {
		t.Errorf("payload missing or not normalized: %s", text)
	}
	if !strings.Contains(text, `"error":null`) {
		t.Errorf("error field missing: %s", text)
	}
}

func TestMarshalNormalizesNullPayload(t *testing.T) {
	msg := Message{Type: TypeEvent, ID: "abc", TS: 1, Payload: json.RawMessage("null")}
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"payload":{}`) {
		t.Errorf("null payload not normalized: %s", string(raw))
	}
}

func TestMarshalPayload(t *testing.T) {
	if got := string(MarshalPayload(nil)); got != "{}" {
		t.Errorf("nil payload = %s", got)
	}
	if got := string(MarshalPayload(map[string]any{"n": 1})); !strings.Contains(got, `"n":1`) {
		t.Errorf("map payload = %s", got)
	}
}

func TestNewID(t *testing.T) {
	seen := make(map[string]struct{}, 1000)
	for i := 0; i < 1000; i++ {
		id := NewID()
		if len(id) != 32 {
			t.Fatalf("id length = %d", len(id))
		}
		if _, ok := seen[id]; ok {
			t.Fatalf("duplicate id: %s", id)
		}
		seen[id] = struct{}{}
	}
}
