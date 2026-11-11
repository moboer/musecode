package hub

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"basestation/internal/protocol"
)

func testHub() *Hub {
	return NewHub(Options{
		Grace:          time.Minute,
		HandlerTimeout: 200 * time.Millisecond,
		DedupeTTL:      time.Minute,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
}

func sub(h *Hub, sess *Session, topic string) {
	msg := protocol.NewMessage(protocol.TypeSub, topic)
	h.HandleInbound(sess, msg)
}

func req(h *Hub, sess *Session, id, topic string) {
	msg := protocol.NewMessage(protocol.TypeReq, topic)
	msg.ID = id
	msg.Payload = protocol.MarshalPayload(map[string]any{"echo": true})
	h.HandleInbound(sess, msg)
}

func collect(t *testing.T, sess *Session, want int, timeout time.Duration) []protocol.Message {
	t.Helper()
	out := make([]protocol.Message, 0, want)
	deadline := time.After(timeout)
	for len(out) < want {
		select {
		case msg := <-sess.Outbox():
			out = append(out, *msg)
		case <-deadline:
			t.Fatalf("timeout: got %d of %d messages", len(out), want)
		}
	}
	return out
}

func TestPublishOnlyReachesSubscribers(t *testing.T) {
	h := testHub()
	metricsSess, _ := h.CreateOrResume("")
	newsSess, _ := h.CreateOrResume("")

	sub(h, metricsSess, "metrics.*")
	sub(h, newsSess, "news.notice")

	if got := h.Publish("metrics.cpu", map[string]any{"value": 12}); got != 1 {
		t.Fatalf("publish to metrics: got %d sessions", got)
	}
	if got := h.Publish("news.notice", map[string]any{"id": 1}); got != 1 {
		t.Fatalf("publish to news: got %d sessions", got)
	}
	if got := h.Publish("nobody.listens", map[string]any{}); got != 0 {
		t.Fatalf("publish to nobody: got %d sessions", got)
	}

	metricsMsgs := collect(t, metricsSess, 2, time.Second) // subok + metrics.cpu
	if metricsMsgs[1].Type != protocol.TypeEvent || metricsMsgs[1].Topic != "metrics.cpu" {
		t.Fatalf("metrics session got %+v", metricsMsgs)
	}

	// news 会话只应该拿到自己的 subok + news.notice，绝不包含 metrics。
	if metricsSess.WSAttached() {
		t.Fatal("session should not have ws attached")
	}
	if extra := len(metricsSess.Outbox()); extra != 0 {
		t.Fatalf("metrics session received unexpected frames: %d", extra)
	}
}

func TestUnsubscribeStopsDelivery(t *testing.T) {
	h := testHub()
	sess, _ := h.CreateOrResume("")
	sub(h, sess, "metrics.cpu")
	collect(t, sess, 1, time.Second) // subok

	unsub := protocol.NewMessage(protocol.TypeUnsub, "metrics.cpu")
	h.HandleInbound(sess, unsub)
	collect(t, sess, 1, time.Second) // unsubok

	if got := h.Publish("metrics.cpu", map[string]any{}); got != 0 {
		t.Fatalf("publish after unsubscribe: got %d", got)
	}
	if extra := len(sess.Outbox()); extra != 0 {
		t.Fatalf("unexpected frames after unsubscribe: %d", extra)
	}
}

func TestRequestHandlerAndDedupe(t *testing.T) {
	h := testHub()
	sess, _ := h.CreateOrResume("")

	var calls atomic.Int64
	h.HandleRequest("echo", func(_ context.Context, _ *Session, r protocol.Message) (any, *protocol.MessageError) {
		calls.Add(1)
		return map[string]any{"received": string(r.Payload)}, nil
	})

	req(h, sess, "req-1", "echo")
	first := collect(t, sess, 1, time.Second)[0]
	if first.Type != protocol.TypeRes || first.ReplyTo != "req-1" || first.Error != nil {
		t.Fatalf("unexpected first response: %+v", first)
	}

	// 相同 id 重试：不会再执行处理器，但会拿到同一份缓存响应。
	req(h, sess, "req-1", "echo")
	second := collect(t, sess, 1, time.Second)[0]
	if second.ReplyTo != "req-1" || second.Error != nil {
		t.Fatalf("unexpected cached response: %+v", second)
	}
	if calls.Load() != 1 {
		t.Fatalf("handler executed %d times, want 1", calls.Load())
	}
	if h.DedupeSize() != 1 {
		t.Fatalf("dedupe size = %d", h.DedupeSize())
	}
}

func TestRequestInflightDedupe(t *testing.T) {
	h := testHub()
	sess, _ := h.CreateOrResume("")

	var calls atomic.Int64
	release := make(chan struct{})
	h.HandleRequest("slow.work", func(_ context.Context, _ *Session, _ protocol.Message) (any, *protocol.MessageError) {
		calls.Add(1)
		<-release // 阻塞住，让第二个同 id 请求在执行中途到达
		return map[string]any{"done": true}, nil
	})

	// 第一个请求进入处理器后，第二个同 id 请求并发到达。
	req(h, sess, "req-x", "slow.work")
	deadline := time.Now().Add(time.Second)
	for calls.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if calls.Load() != 1 {
		t.Fatalf("handler not started, calls = %d", calls.Load())
	}
	req(h, sess, "req-x", "slow.work")

	// 给在途等待者登记的时间，然后放行处理器。
	time.Sleep(100 * time.Millisecond)
	close(release)

	resps := collect(t, sess, 2, 2*time.Second)
	for _, r := range resps {
		if r.Type != protocol.TypeRes || r.ReplyTo != "req-x" || r.Error != nil {
			t.Fatalf("unexpected response: %+v", r)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("handler executed %d times, want 1 (inflight dedupe)", calls.Load())
	}
}

func TestUnknownTopic(t *testing.T) {
	h := testHub()
	sess, _ := h.CreateOrResume("")
	req(h, sess, "req-x", "does.not.exist")

	res := collect(t, sess, 1, time.Second)[0]
	if res.Type != protocol.TypeRes || res.Error == nil || res.Error.Code != protocol.CodeUnknownTopic {
		t.Fatalf("unexpected response: %+v", res)
	}
}

func TestHandlerTimeout(t *testing.T) {
	h := testHub() // HandlerTimeout = 200ms
	sess, _ := h.CreateOrResume("")
	h.HandleRequest("slow", func(ctx context.Context, _ *Session, _ protocol.Message) (any, *protocol.MessageError) {
		<-ctx.Done()
		return nil, &protocol.MessageError{Code: protocol.CodeTimeout, Message: "ctx done", Retryable: true}
	})

	req(h, sess, "req-slow", "slow")
	res := collect(t, sess, 1, time.Second)[0]
	if res.Error == nil || res.Error.Code != protocol.CodeTimeout {
		t.Fatalf("unexpected timeout response: %+v", res)
	}
}

func TestPingPongAndBadFrame(t *testing.T) {
	h := testHub()
	sess, _ := h.CreateOrResume("")

	ping := protocol.NewMessage(protocol.TypePing, "")
	ping.ID = "ping-1"
	h.HandleInbound(sess, ping)
	pong := collect(t, sess, 1, time.Second)[0]
	if pong.Type != protocol.TypePong || pong.ReplyTo != "ping-1" {
		t.Fatalf("unexpected pong: %+v", pong)
	}

	bad := protocol.Message{Type: "bogus", ID: "b1", TS: 1}
	h.HandleInbound(sess, bad)
	errMsg := collect(t, sess, 1, time.Second)[0]
	if errMsg.Type != protocol.TypeError || errMsg.Error == nil || errMsg.Error.Code != protocol.CodeBadMessage {
		t.Fatalf("unexpected error frame: %+v", errMsg)
	}
}

func TestSessionResumeKeepsSubscriptions(t *testing.T) {
	h := testHub()
	sess, resumed := h.CreateOrResume("")
	if resumed {
		t.Fatal("new session should not be resumed")
	}
	sub(h, sess, "metrics.cpu")

	again, resumed := h.CreateOrResume(sess.ID)
	if !resumed || again.ID != sess.ID {
		t.Fatalf("resume failed: resumed=%v id=%s", resumed, again.ID)
	}
	if got := h.Publish("metrics.cpu", map[string]any{}); got != 1 {
		t.Fatalf("subscription lost after resume: %d", got)
	}
}

func TestReapExpiredSessions(t *testing.T) {
	h := NewHub(Options{
		Grace:          10 * time.Millisecond,
		HandlerTimeout: time.Second,
		DedupeTTL:      time.Minute,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	sess, _ := h.CreateOrResume("")
	time.Sleep(20 * time.Millisecond)
	h.reapExpired()

	if _, ok := h.Get(sess.ID); ok {
		t.Fatal("expired session should be removed")
	}
	if h.Count() != 0 {
		t.Fatalf("session count = %d", h.Count())
	}
}
