package hub

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"basestation/internal/auth"
	"basestation/internal/protocol"
	"basestation/internal/registry"
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
	metricsSess, _, _ := h.CreateOrResume("", nil)
	newsSess, _, _ := h.CreateOrResume("", nil)

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
	sess, _, _ := h.CreateOrResume("", nil)
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
	sess, _, _ := h.CreateOrResume("", nil)

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
	sess, _, _ := h.CreateOrResume("", nil)

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
	sess, _, _ := h.CreateOrResume("", nil)
	req(h, sess, "req-x", "does.not.exist")

	res := collect(t, sess, 1, time.Second)[0]
	if res.Type != protocol.TypeRes || res.Error == nil || res.Error.Code != protocol.CodeUnknownTopic {
		t.Fatalf("unexpected response: %+v", res)
	}
}

func TestHandlerTimeout(t *testing.T) {
	h := testHub() // HandlerTimeout = 200ms
	sess, _, _ := h.CreateOrResume("", nil)
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
	sess, _, _ := h.CreateOrResume("", nil)

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
	sess, resumed, _ := h.CreateOrResume("", nil)
	if resumed {
		t.Fatal("new session should not be resumed")
	}
	sub(h, sess, "metrics.cpu")

	again, resumed, _ := h.CreateOrResume(sess.ID, nil)
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
	sess, _, _ := h.CreateOrResume("", nil)
	time.Sleep(20 * time.Millisecond)
	h.reapExpired()

	if _, ok := h.Get(sess.ID); ok {
		t.Fatal("expired session should be removed")
	}
	if h.Count() != 0 {
		t.Fatalf("session count = %d", h.Count())
	}
}

func ownerSession(t *testing.T, h *Hub, claims *auth.Claims) *Session {
	t.Helper()
	sess, _, err := h.CreateOrResume("", claims)
	if err != nil {
		t.Fatalf("create session with owner: %v", err)
	}
	return sess
}

func TestSubscribeACLAndPrivateTopic(t *testing.T) {
	h := testHub()
	alice := &auth.Claims{Sub: "alice", Tenant: "t1", Subscribe: []string{"metrics.*"}, Publish: []string{"echo"}}
	sess := ownerSession(t, h, alice)

	// 允许的订阅
	h.HandleInbound(sess, protocol.NewMessage(protocol.TypeSub, "metrics.*"))
	msgs := collect(t, sess, 1, time.Second)
	if msgs[0].Type != protocol.TypeSubOK {
		t.Fatalf("metrics.* should be allowed, got %+v", msgs[0])
	}

	// 超出 ACL 的订阅（订 * 拿全部）必须被拒——评估时的实锤洞
	h.HandleInbound(sess, protocol.NewMessage(protocol.TypeSub, "*"))
	msgs = collect(t, sess, 1, time.Second)
	if msgs[0].Type != protocol.TypeError || msgs[0].Error == nil || msgs[0].Error.Code != protocol.CodeForbidden {
		t.Fatalf("subscribe * should be forbidden, got %+v", msgs[0])
	}

	// 他人私人命名空间必须被拒
	h.HandleInbound(sess, protocol.NewMessage(protocol.TypeSub, "user.bob.*"))
	msgs = collect(t, sess, 1, time.Second)
	if msgs[0].Error == nil || msgs[0].Error.Code != protocol.CodeForbidden {
		t.Fatalf("subscribe user.bob.* should be forbidden, got %+v", msgs[0])
	}
	if len(sess.Subscriptions()) != 1 {
		t.Fatalf("only the allowed subscription should exist, got %v", sess.Subscriptions())
	}
}

func TestRequestACLStampAndRateLimit(t *testing.T) {
	h := testHub()
	called := 0
	var seenSender, seenTenant string
	h.HandleRequest("echo", func(_ context.Context, _ *Session, req protocol.Message) (any, *protocol.MessageError) {
		called++
		seenSender, seenTenant = req.Sender, req.Tenant
		return map[string]any{"ok": true}, nil
	})
	carol := &auth.Claims{Sub: "carol", Tenant: "t9", Publish: []string{"echo"}, RatePerSec: 1}
	sess := ownerSession(t, h, carol)

	doReq := func(topic, forgedTenant string) protocol.Message {
		req := protocol.NewMessage(protocol.TypeReq, topic)
		req.Tenant = forgedTenant
		h.HandleInbound(sess, req)
		// req 在 goroutine 中处理，轮询等待 res 帧
		deadline := time.After(2 * time.Second)
		for {
			select {
			case msg := <-sess.Outbox():
				if msg.Type == protocol.TypeRes && msg.ReplyTo == req.ID {
					return *msg
				}
			case <-deadline:
				t.Fatalf("timeout waiting res for %s", topic)
				return protocol.Message{}
			}
		}
	}

	// 合法请求：处理器只应被调一次，且看到的 tenant/sender 是令牌盖章值而非伪造值
	res := doReq("echo", "evil-tenant")
	if res.Error != nil {
		t.Fatalf("echo should succeed, got %+v", res.Error)
	}
	if called != 1 || seenTenant != "t9" || seenSender != "carol" {
		t.Fatalf("stamp wrong: called=%d tenant=%q sender=%q", called, seenTenant, seenSender)
	}
	if res.Tenant != "t9" || res.Sender != "carol" {
		t.Fatalf("response stamp wrong: %+v", res)
	}

	// 无权主题：FORBIDDEN 且不进处理器
	res = doReq("device.command", "")
	if res.Error == nil || res.Error.Code != protocol.CodeForbidden {
		t.Fatalf("device.command should be forbidden, got %+v", res)
	}
	if called != 1 {
		t.Fatalf("forbidden request reached handler")
	}

	// 限流：rate=1/s、burst=1，第一条刚消耗掉令牌，紧接第二条应被 RATE_LIMITED
	res = doReq("echo", "")
	if res.Error == nil || res.Error.Code != protocol.CodeRateLimited {
		t.Fatalf("second immediate request should be rate limited, got %+v", res)
	}
	if called != 1 {
		t.Fatalf("rate limited request reached handler")
	}
}

func TestResumeOwnerMismatch(t *testing.T) {
	h := testHub()
	alice := &auth.Claims{Sub: "alice", Tenant: "t1"}
	sess := ownerSession(t, h, alice)

	if _, _, err := h.CreateOrResume(sess.ID, &auth.Claims{Sub: "mallory", Tenant: "t1"}); err != ErrOwnerMismatch {
		t.Fatalf("resume by another subject should fail, got %v", err)
	}
	if _, resumed, err := h.CreateOrResume(sess.ID, alice); err != nil || !resumed {
		t.Fatalf("resume by owner should succeed: resumed=%v err=%v", resumed, err)
	}
}

func TestRegistryPayloadGate(t *testing.T) {
	h := NewHub(Options{
		Grace:          30 * time.Second,
		HandlerTimeout: 2 * time.Second,
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Registry:       registry.Default(),
	})
	called := 0
	h.HandleRequest("slow.echo", func(_ context.Context, _ *Session, _ protocol.Message) (any, *protocol.MessageError) {
		called++
		return map[string]any{"ok": true}, nil
	})
	sess, _, _ := h.CreateOrResume("", nil)

	doReq := func(payload string) protocol.Message {
		req := protocol.NewMessage(protocol.TypeReq, "slow.echo")
		req.Payload = json.RawMessage(payload)
		h.HandleInbound(sess, req)
		deadline := time.After(2 * time.Second)
		for {
			select {
			case msg := <-sess.Outbox():
				if msg.Type == protocol.TypeRes && msg.ReplyTo == req.ID {
					return *msg
				}
			case <-deadline:
				t.Fatal("timeout waiting res")
				return protocol.Message{}
			}
		}
	}

	if res := doReq(`{"delayMs":"soon"}`); res.Error == nil || res.Error.Code != protocol.CodeBadMessage {
		t.Fatalf("wrong-typed payload should be BAD_MESSAGE, got %+v", res)
	}
	if called != 0 {
		t.Fatal("invalid payload reached handler")
	}
	if res := doReq(`{"delayMs":100}`); res.Error != nil || called != 1 {
		t.Fatalf("valid payload should pass: res=%+v called=%d", res, called)
	}
}
