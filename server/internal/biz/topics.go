// Package biz 是一个示例业务模块：它只依赖 hub.Hub，
// 完全不感知底层是 WebSocket 还是 HTTP 轮询。
package biz

import (
	"context"
	"math/rand/v2"
	"sync"
	"time"

	"basestation/internal/hub"
	"basestation/internal/protocol"
)

// Service 演示请求处理器与周期发布器。
type Service struct {
	h         *hub.Hub
	version   string
	startedAt time.Time

	mu      sync.Mutex
	cpu     float64
	mem     float64
	newsSeq int64
}

// Register 注册示例主题处理器与发布器。
func Register(ctx context.Context, h *hub.Hub, version string) *Service {
	s := &Service{h: h, version: version, startedAt: time.Now(), cpu: 24, mem: 46}
	h.HandleRequest("echo", s.echo)
	h.HandleRequest("system.info", s.systemInfo)
	h.HandleRequest("metrics.snapshot", s.metricsSnapshot)
	h.HandleRequest("slow.echo", s.slowEcho)
	h.HandleRequest("boom", s.boom)

	go s.metricsLoop(ctx)
	go s.newsLoop(ctx)
	return s
}

func (s *Service) echo(_ context.Context, _ *hub.Session, req protocol.Message) (any, *protocol.MessageError) {
	return req.Payload, nil
}

func (s *Service) systemInfo(_ context.Context, _ *hub.Session, _ protocol.Message) (any, *protocol.MessageError) {
	return map[string]any{
		"version":      s.version,
		"uptimeMs":     time.Since(s.startedAt).Milliseconds(),
		"sessions":     s.h.Count(),
		"droppedTotal": s.h.DroppedTotal(),
		"serverTs":     time.Now().UnixMilli(),
		"modes":        []string{"ws", "poll"},
		"topics":       []string{"echo", "system.info", "metrics.snapshot", "slow.echo", "boom", "metrics.cpu", "metrics.mem", "news.notice"},
	}, nil
}

func (s *Service) metricsSnapshot(_ context.Context, _ *hub.Session, _ protocol.Message) (any, *protocol.MessageError) {
	s.mu.Lock()
	cpu, mem := s.cpu, s.mem
	s.mu.Unlock()
	return map[string]any{
		"cpu":      cpu,
		"mem":      mem,
		"serverTs": time.Now().UnixMilli(),
	}, nil
}

func (s *Service) slowEcho(ctx context.Context, _ *hub.Session, req protocol.Message) (any, *protocol.MessageError) {
	select {
	case <-time.After(2 * time.Second):
		return req.Payload, nil
	case <-ctx.Done():
		return nil, &protocol.MessageError{
			Code:      protocol.CodeTimeout,
			Message:   "slow.echo cancelled by context",
			Retryable: true,
		}
	}
}

func (s *Service) boom(_ context.Context, _ *hub.Session, _ protocol.Message) (any, *protocol.MessageError) {
	return nil, &protocol.MessageError{
		Code:      protocol.CodeHandlerError,
		Message:   "boom: deliberate business failure",
		Retryable: false,
		Details:   map[string]any{"hint": "这是一个不可重试的业务错误示例"},
	}
}

func (s *Service) metricsLoop(ctx context.Context) {
	cpuTick := time.NewTicker(time.Second)
	memTick := time.NewTicker(2 * time.Second)
	defer cpuTick.Stop()
	defer memTick.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-cpuTick.C:
			s.mu.Lock()
			s.cpu = clamp(s.cpu+(rand.Float64()-0.5)*6, 5, 95)
			cpu := s.cpu
			s.mu.Unlock()
			s.h.Publish("metrics.cpu", map[string]any{
				"value":    round1(cpu),
				"unit":     "percent",
				"series":   "cpu",
				"serverTs": time.Now().UnixMilli(),
			})
		case <-memTick.C:
			s.mu.Lock()
			s.mem = clamp(s.mem+(rand.Float64()-0.5)*3, 20, 90)
			mem := s.mem
			s.mu.Unlock()
			s.h.Publish("metrics.mem", map[string]any{
				"value":    round1(mem),
				"unit":     "percent",
				"series":   "mem",
				"serverTs": time.Now().UnixMilli(),
			})
		}
	}
}

func (s *Service) newsLoop(ctx context.Context) {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()

	titles := []string{
		"基站已启用按需订阅路由",
		"WebSocket 与轮询共享同一会话状态",
		"心跳丢失后自动降级到长轮询",
		"未订阅的会话不会收到任何事件",
		"请求重试借助幂等缓存不会重复执行",
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			s.mu.Lock()
			s.newsSeq++
			n := s.newsSeq
			s.mu.Unlock()
			s.h.Publish("news.notice", map[string]any{
				"noticeId":    n,
				"level":       "info",
				"title":       titles[int(n-1)%len(titles)],
				"publishedAt": time.Now().UnixMilli(),
			})
		}
	}
}

func clamp(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func round1(v float64) float64 {
	return float64(int(v*10+0.5)) / 10
}
