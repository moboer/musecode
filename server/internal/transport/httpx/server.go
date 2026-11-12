// Package httpx 提供基站的 HTTP 入口：WebSocket 升级与轮询接口。
// 两个传输共用 hub.Session，因此可以无缝切换。
package httpx

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/moboer/musecode/server/internal/auth"
	"github.com/moboer/musecode/server/internal/hub"
)

// Config 是传输层配置。
type Config struct {
	Grace       time.Duration
	Heartbeat   time.Duration
	PollWait    time.Duration
	CORSOrigins []string
	Version     string

	// AuthMode: "none"（默认，开发模式，不验令牌） | "jwt"（全链路验证，方案 v2 §6）
	AuthMode string
	// AuthSecret 是 JWT(HS256) 签名密钥，AuthMode=jwt 时必填。
	AuthSecret string
	// DevToken 开启开发用令牌签发端点 /api/auth/dev-token（仅供联调/演示，生产应由 IdP 交换签发）。
	DevToken bool
	// MaxConnsPerUser 单用户最大会话数（第 2 关），0 表示不限。
	MaxConnsPerUser int
}

// Server 组装所有 HTTP 路由。
type Server struct {
	hub      *hub.Hub
	cfg      Config
	logger   *slog.Logger
	wsSeq    atomic.Int64
	signer   *auth.Signer
	verifier *auth.Verifier
}

// New 创建传输层服务。
func New(h *hub.Hub, cfg Config, logger *slog.Logger) *Server {
	if cfg.Heartbeat <= 0 {
		cfg.Heartbeat = 15 * time.Second
	}
	if cfg.PollWait <= 0 {
		cfg.PollWait = 25 * time.Second
	}
	if cfg.Grace <= 0 {
		cfg.Grace = 30 * time.Second
	}
	if logger == nil {
		logger = slog.Default()
	}
	s := &Server{hub: h, cfg: cfg, logger: logger}
	if cfg.AuthMode == "jwt" {
		s.signer = auth.NewSigner(cfg.AuthSecret)
		s.verifier = auth.NewVerifier(cfg.AuthSecret)
	}
	return s
}

// authEnabled 表示是否开启全链路验证。
func (s *Server) authEnabled() bool { return s.verifier != nil }

// Handler 返回带 CORS 的完整路由。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", s.handleWS)
	mux.HandleFunc("POST /api/sessions", s.handleCreateSession)
	mux.HandleFunc("DELETE /api/sessions/{id}", s.handleDeleteSession)
	mux.HandleFunc("POST /api/sessions/{id}/messages", s.handleSend)
	mux.HandleFunc("GET /api/sessions/{id}/messages", s.handlePoll)
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("POST /api/auth/dev-token", s.handleDevToken)
	mux.HandleFunc("POST /api/auth/revoke", s.handleRevoke)
	return s.cors(mux)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":           true,
		"version":      s.cfg.Version,
		"sessions":     s.hub.Count(),
		"droppedTotal": s.hub.DroppedTotal(),
		"authMode":     s.cfg.AuthMode,
		"uptimeMs":     s.hub.Uptime().Milliseconds(),
		"modes":        []string{"ws", "poll"},
		"serverTs":     time.Now().UnixMilli(),
	})
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && s.originAllowed(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) originAllowed(origin string) bool {
	if origin == "" {
		return true
	}
	if len(s.cfg.CORSOrigins) == 0 {
		return false
	}
	for _, allowed := range s.cfg.CORSOrigins {
		if allowed == "*" || strings.EqualFold(allowed, origin) {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
