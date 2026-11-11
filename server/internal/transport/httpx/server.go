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

	"basestation/internal/hub"
)

// Config 是传输层配置。
type Config struct {
	Grace       time.Duration
	Heartbeat   time.Duration
	PollWait    time.Duration
	CORSOrigins []string
	Version     string
}

// Server 组装所有 HTTP 路由。
type Server struct {
	hub    *hub.Hub
	cfg    Config
	logger *slog.Logger
	wsSeq  atomic.Int64
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
	return &Server{hub: h, cfg: cfg, logger: logger}
}

// Handler 返回带 CORS 的完整路由。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", s.handleWS)
	mux.HandleFunc("POST /api/sessions", s.handleCreateSession)
	mux.HandleFunc("DELETE /api/sessions/{id}", s.handleDeleteSession)
	mux.HandleFunc("POST /api/sessions/{id}/messages", s.handleSend)
	mux.HandleFunc("GET /api/sessions/{id}/messages", s.handlePoll)
	mux.HandleFunc("GET /api/health", s.handleHealth)
	return s.cors(mux)
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"version":  s.cfg.Version,
		"sessions": s.hub.Count(),
		"uptimeMs": s.hub.Uptime().Milliseconds(),
		"modes":    []string{"ws", "poll"},
		"serverTs": time.Now().UnixMilli(),
	})
}

func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && s.originAllowed(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
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
