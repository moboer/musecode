// Command basestation 启动独立版基站服务。
//
// 本命令只是标准集成面（server/basestation 包）的一层薄壳：解析命令行、
// 组装 Config、带演示业务独立运行。宿主项目集成时不需要这个命令，
// 直接 import basestation 包即可（见 docs/integration.md）。
package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/moboer/musecode/server/basestation"
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
	authMode := flag.String("auth-mode", "none", "鉴权模式：none（开发，不验令牌）| jwt（全链路验证）")
	authSecret := flag.String("auth-secret", "", "JWT 签名密钥（jwt 模式必填；也可经环境变量 BS_AUTH_SECRET）")
	devToken := flag.Bool("dev-token", false, "开启开发用令牌签发端点 /api/auth/dev-token")
	maxConns := flag.Int("max-conns-per-user", 10, "单用户最大会话数（jwt 模式），0 表示不限")
	ratePerSec := flag.Float64("rate-per-sec", 0, "默认发布/请求速率上限（条/秒/主题），0 表示不限；令牌自带 rate 时以令牌为准")
	flag.Parse()

	logger := newLogger(*logLevel)

	if *authSecret == "" {
		*authSecret = os.Getenv("BS_AUTH_SECRET")
	}

	srv := basestation.New(basestation.Config{
		Version:           *version,
		Logger:            logger,
		Grace:             *grace,
		Heartbeat:         *heartbeat,
		PollWait:          *pollWait,
		HandlerTimeout:    *handlerTimeout,
		CORSOrigins:       splitOrigins(*cors),
		AuthMode:          *authMode,
		AuthSecret:        *authSecret,
		DevToken:          *devToken,
		MaxConnsPerUser:   *maxConns,
		DefaultRatePerSec: *ratePerSec,
		DemoBusiness:      true, // 独立演示服务带内置演示业务；宿主集成时不要开
	})
	if err := srv.Validate(); err != nil {
		logger.Error("invalid config", "error", err)
		os.Exit(2)
	}
	if *authMode == "none" {
		logger.Warn("auth disabled (dev only): tokens are not verified; do not use in production")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := srv.Serve(ctx, *addr); err != nil {
		logger.Error("serve failed", "error", err)
		os.Exit(1)
	}
	logger.Info("base station stopped")
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
