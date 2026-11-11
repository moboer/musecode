// Command basestation 启动基站服务。
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"basestation/internal/biz"
	"basestation/internal/hub"
	"basestation/internal/transport/httpx"
)

func main() {
	addr := flag.String("addr", ":8080", "监听地址")
	grace := flag.Duration("grace", 30*time.Second, "会话宽限期（WS 断开后保留订阅与队列的时长）")
	heartbeat := flag.Duration("hb", 15*time.Second, "下发给客户端的应用层心跳间隔")
	pollWait := flag.Duration("poll-wait", 25*time.Second, "长轮询最大挂起时长")
	handlerTimeout := flag.Duration("handler-timeout", 10*time.Second, "单请求处理器超时")
	cors := flag.String("cors", "*", "允许的 Origin，逗号分隔，* 表示全部")
	version := flag.String("version", "1.0.0", "服务版本号")
	logLevel := flag.String("log-level", "info", "日志级别：debug|info|warn|error")
	flag.Parse()

	logger := newLogger(*logLevel)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	h := hub.NewHub(hub.Options{
		Grace:          *grace,
		HandlerTimeout: *handlerTimeout,
		Logger:         logger,
	})
	h.Start(ctx)
	biz.Register(ctx, h, *version)

	transport := httpx.New(h, httpx.Config{
		Grace:       *grace,
		Heartbeat:   *heartbeat,
		PollWait:    *pollWait,
		CORSOrigins: splitOrigins(*cors),
		Version:     *version,
	}, logger)

	srv := &http.Server{
		Addr:              *addr,
		Handler:           transport.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}

	go func() {
		logger.Info("base station listening",
			"addr", *addr, "ws", "/ws", "poll", "/api/sessions", "version", *version)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen failed", "error", err)
			stop()
		}
	}()

	<-ctx.Done()
	logger.Info("shutting down base station")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}

func newLogger(level string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	return slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: lvl}))
}

func splitOrigins(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}
