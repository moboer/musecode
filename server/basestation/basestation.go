// Package basestation 是基站对外的标准集成面（facade）。
//
// 宿主项目只需 require 本模块并 import 这一个包，即可把基站嵌进自己的
// 工程，不需要也不应该接触 internal 下的实现包。两种用法：
//
// 独立运行（零侵入，基站自己监听端口）：
//
//	srv := basestation.New(basestation.Config{AuthMode: "none"})
//	srv.HandleRequest("orders.create", createOrder)
//	log.Fatal(srv.Serve(ctx, ":8080"))
//
// 嵌入现有 HTTP 服务（把基站挂到宿主自己的 mux 上）：
//
//	mux.Handle("/", srv.Handler()) // 提供 /ws 与 /api/* 路由
//
// 业务侧只有三个动作：HandleRequest 注册请求处理器、Publish 发布事件、
// Serve/Handler 二选一启动。鉴权（jwt 全链路五关）、注册表 payload 校验、
// 限流、会话续接等机制由内部实现统一提供，配置见 Config。
package basestation

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/moboer/musecode/server/internal/biz"
	"github.com/moboer/musecode/server/internal/hub"
	"github.com/moboer/musecode/server/internal/protocol"
	"github.com/moboer/musecode/server/internal/registry"
	"github.com/moboer/musecode/server/internal/transport/httpx"
)

// Config 是基站的全部对外配置，零值即开发默认（免鉴权、注册表校验开启、
// 不带演示业务）。生产环境应至少设置 AuthMode="jwt" 与 AuthSecret。
type Config struct {
	// Version 服务版本号，随 hello 与 health 下发。默认 "1.0.0"。
	Version string
	// Logger 日志器，默认 slog.Default()。
	Logger *slog.Logger

	// Grace 会话宽限期：WS 断开后保留订阅与队列的时长。默认 30s。
	Grace time.Duration
	// Heartbeat 下发给客户端的应用层心跳间隔。默认 15s。
	Heartbeat time.Duration
	// PollWait 长轮询最大挂起时长。默认 25s。
	PollWait time.Duration
	// HandlerTimeout 单个请求处理器的超时。默认 10s。
	HandlerTimeout time.Duration
	// CORSOrigins 允许的 Origin 列表，默认 ["*"]。
	CORSOrigins []string

	// AuthMode 鉴权模式："none"（默认，开发用，不验令牌）| "jwt"（全链路验证）。
	AuthMode string
	// AuthSecret JWT 签名密钥，jwt 模式必填。
	AuthSecret string
	// DevToken 是否开启开发用令牌签发端点 /api/auth/dev-token（仅限内网调试）。
	DevToken bool
	// MaxConnsPerUser 单用户最大会话数（jwt 模式），0 表示用默认值 10。
	MaxConnsPerUser int
	// DefaultRatePerSec 默认请求速率上限（条/秒），0 表示不限；
	// jwt 模式下令牌自带 rate 时以令牌为准。
	DefaultRatePerSec float64

	// DisableRegistry 关闭注册表 payload 校验（第 4 关）。
	// 注意：注册表只校验已登记的主题，宿主自定义主题未登记时自动放行，
	// 因此通常不需要关。默认开启。
	DisableRegistry bool
	// DemoBusiness 注册内置演示业务（echo / metrics / news / slow.echo / boom），
	// 供独立演示与联调使用。真实项目应保持关闭，只注册自己的处理器。默认关闭。
	DemoBusiness bool
}

// Request 是业务处理器看到的请求视图（协议信封的对外投影）。
type Request struct {
	Topic     string
	Payload   json.RawMessage
	SessionID string
	// Tenant / Sender 为服务端盖章的主体信息（jwt 模式下可信，业务无需自验）。
	Tenant string
	Sender string
}

// Decode 把 payload 解码为业务结构体。
func (r Request) Decode(v any) error {
	if len(r.Payload) == 0 {
		return nil
	}
	return json.Unmarshal(r.Payload, v)
}

// Error 是业务可返回的协议错误，Code 会原样下发给客户端
// （如 "BAD_MESSAGE" / "FORBIDDEN" / 自定义码）。返回普通 error 时
// 统一映射为 HANDLER_ERROR。
type Error struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// NewError 构造一个协议错误。
func NewError(code, message string) *Error {
	return &Error{Code: code, Message: message}
}

// HandlerFunc 是业务请求处理器签名。返回 (结果, nil) 或 (nil, error)。
// 结果会被 JSON 序列化后作为响应 payload 下发。
type HandlerFunc func(ctx context.Context, req Request) (any, error)

// Server 是一个基站实例。用 New 创建，Close 释放。
type Server struct {
	cfg  Config
	hub  *hub.Hub
	http *httpx.Server

	ctx    context.Context
	cancel context.CancelFunc

	startOnce sync.Once
	httpSrv   *http.Server
	closeOnce sync.Once
}

// New 创建基站实例（不立即监听端口）。业务处理器应在 Serve/Handler 之前注册。
func New(cfg Config) *Server {
	if cfg.Version == "" {
		cfg.Version = "1.0.0"
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Grace <= 0 {
		cfg.Grace = 30 * time.Second
	}
	if cfg.Heartbeat <= 0 {
		cfg.Heartbeat = 15 * time.Second
	}
	if cfg.PollWait <= 0 {
		cfg.PollWait = 25 * time.Second
	}
	if cfg.HandlerTimeout <= 0 {
		cfg.HandlerTimeout = 10 * time.Second
	}
	if len(cfg.CORSOrigins) == 0 {
		cfg.CORSOrigins = []string{"*"}
	}
	if cfg.AuthMode == "" {
		cfg.AuthMode = "none"
	}
	if cfg.MaxConnsPerUser <= 0 {
		cfg.MaxConnsPerUser = 10
	}

	ctx, cancel := context.WithCancel(context.Background())

	hubOpts := hub.Options{
		Grace:             cfg.Grace,
		HandlerTimeout:    cfg.HandlerTimeout,
		Logger:            cfg.Logger,
		DefaultRatePerSec: cfg.DefaultRatePerSec,
	}
	if !cfg.DisableRegistry {
		hubOpts.Registry = registry.Default()
	}
	h := hub.NewHub(hubOpts)

	s := &Server{
		cfg:    cfg,
		hub:    h,
		ctx:    ctx,
		cancel: cancel,
	}
	s.http = httpx.New(h, httpx.Config{
		Grace:           cfg.Grace,
		Heartbeat:       cfg.Heartbeat,
		PollWait:        cfg.PollWait,
		CORSOrigins:     cfg.CORSOrigins,
		Version:         cfg.Version,
		AuthMode:        cfg.AuthMode,
		AuthSecret:      cfg.AuthSecret,
		DevToken:        cfg.DevToken,
		MaxConnsPerUser: cfg.MaxConnsPerUser,
	}, cfg.Logger)

	if cfg.DemoBusiness {
		biz.Register(ctx, h, cfg.Version)
	}
	return s
}

// Validate 检查配置是否可运行（Serve/Handler 内部会调用，宿主一般无需显式调）。
func (s *Server) Validate() error {
	if s.cfg.AuthMode != "none" && s.cfg.AuthMode != "jwt" {
		return fmt.Errorf("basestation: unknown AuthMode %q (want none|jwt)", s.cfg.AuthMode)
	}
	if s.cfg.AuthMode == "jwt" && s.cfg.AuthSecret == "" {
		return errors.New("basestation: AuthMode=jwt requires AuthSecret")
	}
	return nil
}

// HandleRequest 为某个 topic 注册业务请求处理器（同名后注册的覆盖先注册的）。
func (s *Server) HandleRequest(topic string, fn HandlerFunc) {
	s.hub.HandleRequest(topic, func(ctx context.Context, sess *hub.Session, msg protocol.Message) (any, *protocol.MessageError) {
		req := Request{
			Topic:     msg.Topic,
			Payload:   msg.Payload,
			SessionID: sess.ID,
		}
		if owner := sess.Owner(); owner != nil {
			req.Tenant, req.Sender = owner.Tenant, owner.Sub
		}
		payload, err := fn(ctx, req)
		if err == nil {
			return payload, nil
		}
		var berr *Error
		if errors.As(err, &berr) {
			return nil, &protocol.MessageError{Code: berr.Code, Message: berr.Message, Retryable: berr.Retryable}
		}
		return nil, &protocol.MessageError{Code: protocol.CodeHandlerError, Message: err.Error(), Retryable: false}
	})
}

// Publish 向一个 topic 发布事件，返回实际投递到的会话数。
// 业务可以在任意 goroutine 中调用（如采集循环、定时任务）。
func (s *Server) Publish(topic string, payload any) int {
	return s.hub.Publish(topic, payload)
}

// Sessions 返回当前会话数；DroppedTotal 返回累计丢帧数（慢消费者被丢弃的帧）。
func (s *Server) Sessions() int       { return s.hub.Count() }
func (s *Server) DroppedTotal() int64 { return s.hub.DroppedTotal() }

// Handler 返回基站的 HTTP 处理器（/ws、/api/sessions、/api/health、/api/auth/*），
// 供嵌入宿主自己的 http.Server / mux。首次调用时启动会话回收等后台任务。
func (s *Server) Handler() http.Handler {
	s.start()
	return s.http.Handler()
}

// Serve 在 addr 上独立运行基站，直到 ctx 结束或监听失败。
// 这是零侵入用法：宿主只需在自己的 main 里加一行。
func (s *Server) Serve(ctx context.Context, addr string) error {
	if err := s.Validate(); err != nil {
		return err
	}
	s.start()
	s.httpSrv = &http.Server{
		Addr:              addr,
		Handler:           s.http.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return s.ctx },
	}
	errCh := make(chan error, 1)
	go func() {
		s.cfg.Logger.Info("base station listening", "addr", addr, "version", s.cfg.Version)
		errCh <- s.httpSrv.ListenAndServe()
	}()
	select {
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.httpSrv.Shutdown(shutdownCtx)
		return nil
	}
}

// Close 停止后台任务并（若经 Serve 启动）关闭 HTTP 服务。可重复调用。
func (s *Server) Close() error {
	var err error
	s.closeOnce.Do(func() {
		s.cancel()
		if s.httpSrv != nil {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err = s.httpSrv.Shutdown(shutdownCtx)
		}
	})
	return err
}

func (s *Server) start() {
	s.startOnce.Do(func() {
		if err := s.Validate(); err != nil {
			s.cfg.Logger.Error("basestation config invalid", "error", err)
		}
		s.hub.Start(s.ctx)
	})
}
