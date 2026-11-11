package httpx

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"basestation/internal/auth"
	"basestation/internal/hub"
	"basestation/internal/protocol"
)

const testSecret = "test-secret"

func testServer(t *testing.T, devToken bool) (*httptest.Server, *hub.Hub) {
	t.Helper()
	h := hub.NewHub(hub.Options{Grace: 30 * time.Second, HandlerTimeout: 2 * time.Second, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	h.HandleRequest("echo", func(_ context.Context, _ *hub.Session, req protocol.Message) (any, *protocol.MessageError) {
		return map[string]any{"echo": true, "sender": req.Sender, "tenant": req.Tenant}, nil
	})
	srv := New(h, Config{
		Grace:           30 * time.Second,
		PollWait:        300 * time.Millisecond,
		CORSOrigins:     []string{"*"},
		Version:         "test",
		AuthMode:        "jwt",
		AuthSecret:      testSecret,
		DevToken:        devToken,
		MaxConnsPerUser: 10,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, h
}

func mint(t *testing.T, claims auth.Claims) (string, *auth.Claims) {
	t.Helper()
	token, err := auth.NewSigner(testSecret).Issue(claims, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := auth.NewVerifier(testSecret).Verify(token)
	if err != nil {
		t.Fatal(err)
	}
	return token, verified
}

func doJSON(t *testing.T, method, url, token string, body any) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, url, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	raw, _ := io.ReadAll(resp.Body)
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return resp.StatusCode, out
}

func createSession(t *testing.T, ts *httptest.Server, token, sessionID string) (int, map[string]any) {
	t.Helper()
	return doJSON(t, http.MethodPost, ts.URL+"/api/sessions", token, map[string]any{"sessionId": sessionID})
}

func TestPollFlowAuthGates(t *testing.T) {
	ts, _ := testServer(t, true)
	aliceToken, _ := mint(t, auth.Claims{Sub: "alice", Tenant: "t1", Subscribe: []string{"metrics.*"}, Publish: []string{"echo"}})
	malloryToken, _ := mint(t, auth.Claims{Sub: "mallory", Tenant: "t1", Subscribe: []string{"*"}, Publish: []string{"*"}})

	// 无令牌建会话 → 401
	if code, _ := createSession(t, ts, "", ""); code != http.StatusUnauthorized {
		t.Fatalf("no token should be 401, got %d", code)
	}
	// 篡改签名的令牌 → 401
	if code, _ := createSession(t, ts, aliceToken+"x", ""); code != http.StatusUnauthorized {
		t.Fatalf("tampered token should be 401, got %d", code)
	}
	// 合法建会话
	code, created := createSession(t, ts, aliceToken, "")
	if code != http.StatusOK {
		t.Fatalf("alice create should be 200, got %d (%v)", code, created)
	}
	sessionID, _ := created["sessionId"].(string)
	if sessionID == "" {
		t.Fatalf("missing sessionId in %v", created)
	}
	// 别人拿着 sessionId 续接 → 403（光有 sessionId 接管不了会话）
	if code, _ := createSession(t, ts, malloryToken, sessionID); code != http.StatusForbidden {
		t.Fatalf("resume by other subject should be 403, got %d", code)
	}
	// 本人续接 → 200 resumed
	code, resumed := createSession(t, ts, aliceToken, sessionID)
	if code != http.StatusOK || resumed["resumed"] != true {
		t.Fatalf("resume by owner should be 200 resumed, got %d %v", code, resumed)
	}
	// send：无令牌 401、他人令牌 403、本人 204
	sendURL := ts.URL + "/api/sessions/" + sessionID + "/messages"
	frame := map[string]any{"messages": []any{map[string]any{
		"type": "sub", "id": protocol.NewID(), "ts": time.Now().UnixMilli(), "payload": map[string]any{}, "error": nil, "topic": "metrics.*",
	}}}
	if code, _ := doJSON(t, http.MethodPost, sendURL, "", frame); code != http.StatusUnauthorized {
		t.Fatalf("send without token should be 401, got %d", code)
	}
	if code, _ := doJSON(t, http.MethodPost, sendURL, malloryToken, frame); code != http.StatusForbidden {
		t.Fatalf("send with other's token should be 403, got %d", code)
	}
	if code, _ := doJSON(t, http.MethodPost, sendURL, aliceToken, frame); code != http.StatusAccepted {
		t.Fatalf("send with owner token should be 202, got %d", code)
	}
}

func TestAnonymousStarSubscribeBlockedEndToEnd(t *testing.T) {
	ts, _ := testServer(t, true)
	// 受限令牌：只能看 metrics，却试图订 * ——评估时的实锤洞，端到端必须被拒并回 FORBIDDEN 帧
	limitedToken, _ := mint(t, auth.Claims{Sub: "limited", Subscribe: []string{"metrics.*"}})
	_, created := createSession(t, ts, limitedToken, "")
	sessionID, _ := created["sessionId"].(string)

	sendURL := ts.URL + "/api/sessions/" + sessionID + "/messages"
	frame := map[string]any{"messages": []any{map[string]any{
		"type": "sub", "id": protocol.NewID(), "ts": time.Now().UnixMilli(), "payload": map[string]any{}, "error": nil, "topic": "*",
	}}}
	if code, _ := doJSON(t, http.MethodPost, sendURL, limitedToken, frame); code != http.StatusAccepted {
		t.Fatalf("send should be 202, got %d", code)
	}
	code, out := doJSON(t, http.MethodGet, ts.URL+"/api/sessions/"+sessionID+"/messages?lastSeq=0", limitedToken, nil)
	if code != http.StatusOK {
		t.Fatalf("poll should be 200, got %d", code)
	}
	raw, _ := json.Marshal(out)
	if !strings.Contains(string(raw), protocol.CodeForbidden) {
		t.Fatalf("expected a FORBIDDEN frame for subscribe *, got %s", raw)
	}
}

func TestDevTokenAndRevoke(t *testing.T) {
	ts, _ := testServer(t, true)

	// 第 1 关（开发实现）：换取令牌
	code, issued := doJSON(t, http.MethodPost, ts.URL+"/api/auth/dev-token", "", map[string]any{
		"sub": "dave", "tenant": "t2", "subscribe": []string{"news.*"}, "publish": []string{"echo"}, "ttlSeconds": 300,
	})
	if code != http.StatusOK {
		t.Fatalf("dev-token should be 200, got %d (%v)", code, issued)
	}
	daveToken, _ := issued["token"].(string)
	daveJTI, _ := issued["jti"].(string)
	if daveToken == "" || daveJTI == "" {
		t.Fatalf("dev-token response incomplete: %v", issued)
	}
	_, created := createSession(t, ts, daveToken, "")
	sessionID, _ := created["sessionId"].(string)

	// 非 admin 不能吊销
	if code, _ := doJSON(t, http.MethodPost, ts.URL+"/api/auth/revoke", daveToken, map[string]any{"jti": daveJTI}); code != http.StatusForbidden {
		t.Fatalf("revoke by non-admin should be 403, got %d", code)
	}
	// admin 吊销 → 存量会话被踢除
	adminToken, _ := mint(t, auth.Claims{Sub: "root", Admin: true})
	code, revoked := doJSON(t, http.MethodPost, ts.URL+"/api/auth/revoke", adminToken, map[string]any{"jti": daveJTI})
	if code != http.StatusOK || revoked["kickedSessions"] != float64(1) {
		t.Fatalf("revoke should kick 1 session, got %d %v", code, revoked)
	}
	// 被吊销令牌再也建不了会话
	if code, _ := createSession(t, ts, daveToken, ""); code != http.StatusUnauthorized {
		t.Fatalf("revoked token should be 401, got %d", code)
	}
	// 被踢会话已不存在
	if code, _ := doJSON(t, http.MethodGet, ts.URL+"/api/sessions/"+sessionID+"/messages?lastSeq=0", daveToken, nil); code != http.StatusNotFound {
		t.Fatalf("kicked session should be 404, got %d", code)
	}
}

func TestDevTokenDisabledReturns404(t *testing.T) {
	ts, _ := testServer(t, false)
	if code, _ := doJSON(t, http.MethodPost, ts.URL+"/api/auth/dev-token", "", map[string]any{"sub": "x"}); code != http.StatusNotFound {
		t.Fatalf("dev-token disabled should be 404, got %d", code)
	}
}

func TestWSAuthGate(t *testing.T) {
	ts, _ := testServer(t, true)
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	// 无令牌升级 → 401
	if _, resp, err := websocket.DefaultDialer.Dial(wsURL, nil); err == nil {
		t.Fatal("ws without token should fail")
	} else if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("ws without token should be 401, got %v (%v)", resp, err)
	}

	// 带令牌 → 握手成功并收到 hello
	token, _ := mint(t, auth.Claims{Sub: "alice", Subscribe: []string{"metrics.*"}})
	conn, _, err := websocket.DefaultDialer.Dial(wsURL+"?token="+token, nil)
	if err != nil {
		t.Fatalf("ws with token should connect: %v", err)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var hello protocol.Message
	if err := conn.ReadJSON(&hello); err != nil {
		t.Fatalf("read hello: %v", err)
	}
	if hello.Type != protocol.TypeHello || hello.SessionID == "" {
		t.Fatalf("unexpected hello: %+v", hello)
	}
	if hello.Sender != "alice" {
		t.Fatalf("hello should be stamped with token subject, got sender=%q", hello.Sender)
	}
}

func TestExpiredTokenRejected(t *testing.T) {
	ts, _ := testServer(t, true)
	// 手工拼一张已过期的合法签名令牌
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	payload, _ := json.Marshal(auth.Claims{Sub: "ghost", ExpiresAt: time.Now().Add(-time.Minute).Unix(), JTI: "old"})
	enc := base64.RawURLEncoding
	signing := enc.EncodeToString(header) + "." + enc.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(testSecret))
	mac.Write([]byte(signing))
	expired := signing + "." + enc.EncodeToString(mac.Sum(nil))

	if code, _ := createSession(t, ts, expired, ""); code != http.StatusUnauthorized {
		t.Fatalf("expired token should be 401, got %d", code)
	}
}
