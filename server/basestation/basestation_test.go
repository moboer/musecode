package basestation_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/moboer/musecode/server/basestation"
)

type frame struct {
	Type    string          `json:"type"`
	ID      string          `json:"id"`
	TS      int64           `json:"ts"`
	Topic   string          `json:"topic,omitempty"`
	Payload json.RawMessage `json:"payload"`
	Error   *struct {
		Code string `json:"code"`
	} `json:"error"`
	ReplyTo string `json:"replyTo,omitempty"`
}

// TestFacadeEndToEnd 以“宿主项目”的姿势使用公共包：注册自有主题处理器、
// 挂 Handler、WS 客户端请求 + 订阅 + 服务端 Publish，全链路只碰 facade。
func TestFacadeEndToEnd(t *testing.T) {
	srv := basestation.New(basestation.Config{})
	defer func() { _ = srv.Close() }()

	srv.HandleRequest("orders.create", func(_ context.Context, req basestation.Request) (any, error) {
		var in struct {
			SKU string `json:"sku"`
		}
		if err := req.Decode(&in); err != nil {
			return nil, basestation.NewError("BAD_MESSAGE", "bad payload")
		}
		if in.SKU == "" {
			return nil, basestation.NewError("BAD_MESSAGE", "sku required")
		}
		return map[string]any{"orderId": "o-1", "sku": in.SKU}, nil
	})

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// health 可达
	resp, err := http.Get(ts.URL + "/api/health")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("health: resp=%v err=%v", resp, err)
	}
	_ = resp.Body.Close()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))

	read := func() frame {
		t.Helper()
		var f frame
		if err := conn.ReadJSON(&f); err != nil {
			t.Fatalf("read frame: %v", err)
		}
		return f
	}
	send := func(f frame) {
		t.Helper()
		if f.Error == nil {
			// 入站信封 error 恒存在
			raw, _ := json.Marshal(f)
			var m map[string]any
			_ = json.Unmarshal(raw, &m)
			m["error"] = nil
			if err := conn.WriteJSON(m); err != nil {
				t.Fatalf("write frame: %v", err)
			}
			return
		}
		if err := conn.WriteJSON(f); err != nil {
			t.Fatalf("write frame: %v", err)
		}
	}

	hello := read()
	if hello.Type != "hello" {
		t.Fatalf("first frame = %s, want hello", hello.Type)
	}

	// 订阅自有事件主题
	send(frame{Type: "sub", ID: "s1", TS: 1, Topic: "orders.created", Payload: json.RawMessage("null")})
	for {
		f := read()
		if f.Type == "subok" {
			break
		}
	}

	// 请求-响应：宿主自有主题（未登记注册表）应被放行并命中处理器
	send(frame{Type: "req", ID: "r1", TS: 1, Topic: "orders.create", Payload: json.RawMessage(`{"sku":"A-1"}`)})
	var res frame
	for {
		f := read()
		if f.Type == "res" && f.ReplyTo == "r1" {
			res = f
			break
		}
	}
	if res.Error != nil {
		t.Fatalf("res error: %+v", res.Error)
	}
	var out struct {
		OrderID string `json:"orderId"`
	}
	if err := json.Unmarshal(res.Payload, &out); err != nil || out.OrderID != "o-1" {
		t.Fatalf("res payload = %s, err=%v", res.Payload, err)
	}

	// 错误映射：facade Error 的 Code 应原样下发
	send(frame{Type: "req", ID: "r2", TS: 1, Topic: "orders.create", Payload: json.RawMessage(`{}`)})
	for {
		f := read()
		if f.Type == "res" && f.ReplyTo == "r2" {
			if f.Error == nil || f.Error.Code != "BAD_MESSAGE" {
				t.Fatalf("r2 error = %+v, want BAD_MESSAGE", f.Error)
			}
			break
		}
	}

	// 服务端主动 Publish → 订阅者收到事件
	if n := srv.Publish("orders.created", map[string]any{"orderId": "o-1"}); n != 1 {
		t.Fatalf("Publish delivered to %d sessions, want 1", n)
	}
	for {
		f := read()
		if f.Type == "event" && f.Topic == "orders.created" {
			break
		}
	}
	if srv.Sessions() < 1 {
		t.Fatalf("Sessions() = %d, want >= 1", srv.Sessions())
	}
}

// TestValidateJWTRequiresSecret 配置校验：jwt 模式缺密钥应报错。
func TestValidateJWTRequiresSecret(t *testing.T) {
	srv := basestation.New(basestation.Config{AuthMode: "jwt"})
	defer func() { _ = srv.Close() }()
	if err := srv.Validate(); err == nil {
		t.Fatal("Validate() = nil, want error for jwt without secret")
	}
}

// TestPathPrefixMounting 验证 PathPrefix：路由整体挂到前缀下，根路径不再响应。
func TestPathPrefixMounting(t *testing.T) {
	srv := basestation.New(basestation.Config{PathPrefix: "/bs", DemoBusiness: true})
	defer func() { _ = srv.Close() }()

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/bs/api/health")
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("prefixed health: resp=%v err=%v", resp, err)
	}
	_ = resp.Body.Close()

	resp2, err := http.Get(ts.URL + "/api/health")
	if err != nil {
		t.Fatalf("root health err: %v", err)
	}
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("root health status = %d, want 404", resp2.StatusCode)
	}
	_ = resp2.Body.Close()

	// WS 也在前缀下可用
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/bs/ws"
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("dial prefixed ws: %v", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var hello frame
	if err := conn.ReadJSON(&hello); err != nil || hello.Type != "hello" {
		t.Fatalf("hello = %+v err=%v", hello, err)
	}
}

// TestIssueToken 验证宿主签发令牌：none 模式报错；jwt 模式下无令牌被拒、
// 宿主签发的令牌可正常连接与请求。
func TestIssueToken(t *testing.T) {
	noneSrv := basestation.New(basestation.Config{})
	defer func() { _ = noneSrv.Close() }()
	if _, err := noneSrv.IssueToken(basestation.TokenRequest{Subject: "u1"}); err == nil {
		t.Fatal("IssueToken in none mode should error")
	}

	srv := basestation.New(basestation.Config{
		AuthMode: "jwt", AuthSecret: "test-secret", DemoBusiness: true,
	})
	defer func() { _ = srv.Close() }()

	issued, err := srv.IssueToken(basestation.TokenRequest{
		Subject: "admin", Subscribe: []string{"*"}, Publish: []string{"*"}, TTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	if issued.Token == "" || issued.ID == "" || issued.ExpiresAt.Before(time.Now()) {
		t.Fatalf("issued = %+v", issued)
	}

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	wsBase := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"

	// 无令牌：握手应被拒
	if _, resp, err := websocket.DefaultDialer.Dial(wsBase, nil); err == nil {
		t.Fatal("dial without token should fail")
	} else if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("dial without token: err=%v resp=%v", err, resp)
	}

	// 带宿主签发的令牌：连接 + echo 请求全通
	conn, _, err := websocket.DefaultDialer.Dial(wsBase+"?token="+issued.Token, nil)
	if err != nil {
		t.Fatalf("dial with issued token: %v", err)
	}
	defer func() { _ = conn.Close() }()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var hello frame
	if err := conn.ReadJSON(&hello); err != nil || hello.Type != "hello" {
		t.Fatalf("hello = %+v err=%v", hello, err)
	}
	if err := conn.WriteJSON(map[string]any{
		"type": "req", "id": "r1", "ts": 1, "topic": "echo",
		"payload": map[string]any{"x": 1}, "error": nil,
	}); err != nil {
		t.Fatalf("write req: %v", err)
	}
	for {
		var f frame
		if err := conn.ReadJSON(&f); err != nil {
			t.Fatalf("read: %v", err)
		}
		if f.Type == "res" && f.ReplyTo == "r1" {
			if f.Error != nil {
				t.Fatalf("echo res error: %+v", f.Error)
			}
			break
		}
	}
}
