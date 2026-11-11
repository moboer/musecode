// Package hub 实现基站核心：会话注册、订阅路由、请求分发与容错。
package hub

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"basestation/internal/protocol"
)

// HandlerFunc 是业务请求处理器。业务模块只依赖该签名与 Hub，
// 不感知底层是 WS 还是 HTTP 轮询。
type HandlerFunc func(ctx context.Context, sess *Session, req protocol.Message) (any, *protocol.MessageError)

// Options 是 Hub 的可配置项。
type Options struct {
	Grace          time.Duration // 会话宽限期
	HandlerTimeout time.Duration // 单请求处理超时
	DedupeTTL      time.Duration // 请求幂等缓存存活时间
	Logger         *slog.Logger
}

type dedupeEntry struct {
	msg     protocol.Message
	expires time.Time
}

// inflightCall 是一次正在执行中的请求。在途去重：
// 同 (sessionId, reqId) 的重复请求不再启动第二次执行，而是等这次执行的结果。
type inflightCall struct {
	done chan struct{}
	resp protocol.Message
}

// Hub 是基站消息中枢。
type Hub struct {
	mu            sync.RWMutex
	sessions      map[string]*Session
	subsByPattern map[string]map[string]struct{}
	handlers      map[string]HandlerFunc
	dedupe        map[string]dedupeEntry
	inflight      map[string]*inflightCall

	grace          time.Duration
	handlerTimeout time.Duration
	dedupeTTL      time.Duration
	logger         *slog.Logger
	startedAt      time.Time
}

// NewHub 创建基站中枢。
func NewHub(opts Options) *Hub {
	if opts.Grace <= 0 {
		opts.Grace = 30 * time.Second
	}
	if opts.HandlerTimeout <= 0 {
		opts.HandlerTimeout = 10 * time.Second
	}
	if opts.DedupeTTL <= 0 {
		opts.DedupeTTL = 5 * time.Minute
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	return &Hub{
		sessions:       make(map[string]*Session),
		subsByPattern:  make(map[string]map[string]struct{}),
		handlers:       make(map[string]HandlerFunc),
		dedupe:         make(map[string]dedupeEntry),
		inflight:       make(map[string]*inflightCall),
		grace:          opts.Grace,
		handlerTimeout: opts.HandlerTimeout,
		dedupeTTL:      opts.DedupeTTL,
		logger:         opts.Logger,
		startedAt:      time.Now(),
	}
}

// HandleRequest 注册业务请求处理器。业务模块的接入口仅此一个。
func (h *Hub) HandleRequest(topic string, fn HandlerFunc) {
	h.mu.Lock()
	h.handlers[topic] = fn
	h.mu.Unlock()
}

// CreateOrResume 创建或续接会话。sessionID 不存在时按新会话处理。
func (h *Hub) CreateOrResume(sessionID string) (*Session, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if sessionID != "" {
		if sess, ok := h.sessions[sessionID]; ok && !sess.Closed() {
			sess.Touch()
			// 会话复用时把既有订阅重新写入索引，保证中途重建索引也一致。
			for _, pattern := range sess.Subscriptions() {
				h.indexSubscribeLocked(sess.ID, pattern)
			}
			return sess, true
		}
	}

	id := sessionID
	if id == "" {
		id = protocol.NewID()
	}
	sess := NewSession(id)
	h.sessions[id] = sess
	h.logger.Info("session created", "sessionId", id)
	return sess, false
}

// Get 按 ID 取会话。
func (h *Hub) Get(sessionID string) (*Session, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	sess, ok := h.sessions[sessionID]
	if !ok || sess.Closed() {
		return nil, false
	}
	return sess, true
}

// Delete 主动销毁会话。
func (h *Hub) Delete(sessionID string) {
	h.mu.Lock()
	sess, ok := h.sessions[sessionID]
	if ok {
		delete(h.sessions, sessionID)
		for _, pattern := range sess.Subscriptions() {
			h.indexUnsubscribeLocked(sessionID, pattern)
		}
	}
	h.mu.Unlock()
	if ok {
		sess.Close()
		h.logger.Info("session closed", "sessionId", sessionID)
	}
}

// DroppedTotal 返回全部会话因出站队列溢出累计丢弃的帧数（指标出口）。
func (h *Hub) DroppedTotal() int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var total int64
	for _, sess := range h.sessions {
		total += sess.Dropped()
	}
	return total
}

// Count 返回当前在线会话数。
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.sessions)
}

// Uptime 返回基站运行时长。
func (h *Hub) Uptime() time.Duration { return time.Since(h.startedAt) }

// HandleInbound 是所有入站帧的唯一处理入口（WS 读泵与轮询批量入站共用）。
func (h *Hub) HandleInbound(sess *Session, msg protocol.Message) {
	msg.Normalize()
	sess.Touch()

	if mErr := msg.Validate(); mErr != nil {
		h.send(sess, protocol.TypeError, msg.Topic, msg.ID, nil, mErr)
		return
	}

	switch msg.Type {
	case protocol.TypePing:
		h.send(sess, protocol.TypePong, "", msg.ID, map[string]any{"ts": time.Now().UnixMilli()}, nil)

	case protocol.TypeSub:
		added := sess.Subscribe(msg.Topic)
		if added {
			h.mu.Lock()
			h.indexSubscribeLocked(sess.ID, msg.Topic)
			h.mu.Unlock()
		}
		h.send(sess, protocol.TypeSubOK, msg.Topic, msg.ID, map[string]any{"topic": msg.Topic, "added": added}, nil)

	case protocol.TypeUnsub:
		removed := sess.Unsubscribe(msg.Topic)
		if removed {
			h.mu.Lock()
			h.indexUnsubscribeLocked(sess.ID, msg.Topic)
			h.mu.Unlock()
		}
		h.send(sess, protocol.TypeUnsubOK, msg.Topic, msg.ID, map[string]any{"topic": msg.Topic, "removed": removed}, nil)

	case protocol.TypeReq:
		go h.handleRequest(sess, msg)

	default:
		h.send(sess, protocol.TypeError, msg.Topic, msg.ID, nil, &protocol.MessageError{
			Code:      protocol.CodeBadMessage,
			Message:   "unsupported inbound type: " + msg.Type,
			Retryable: false,
		})
	}
}

func (h *Hub) handleRequest(sess *Session, req protocol.Message) {
	key := sess.ID + "|" + req.ID

	// 第一级：完成缓存。已执行完的请求直接回放缓存响应（幂等）。
	if cached, ok := h.dedupeLookup(key); ok {
		resp := cached
		sess.Enqueue(&resp)
		h.logger.Debug("request deduped", "sessionId", sess.ID, "requestId", req.ID)
		return
	}

	// 第二级：在途去重。第一个请求还在执行时，同 key 的重试不启动第二次执行，
	// 而是登记为等待者，与首个请求共享同一次执行结果。
	h.mu.Lock()
	if call, ok := h.inflight[key]; ok {
		h.mu.Unlock()
		<-call.done
		resp := call.resp
		sess.Enqueue(&resp)
		h.logger.Debug("request joined inflight", "sessionId", sess.ID, "requestId", req.ID)
		return
	}
	call := &inflightCall{done: make(chan struct{})}
	h.inflight[key] = call
	h.mu.Unlock()

	resp := h.executeRequest(sess, req)

	// 先写完成缓存，再唤醒等待者：迟到的重试命中缓存，在途的等待者拿共享结果。
	h.dedupeStore(key, resp)
	call.resp = resp
	close(call.done)
	h.mu.Lock()
	delete(h.inflight, key)
	h.mu.Unlock()

	sess.Enqueue(&resp)
}

// executeRequest 真正执行一次业务处理器并组装响应帧（不含任何去重逻辑）。
func (h *Hub) executeRequest(sess *Session, req protocol.Message) protocol.Message {
	h.mu.RLock()
	fn, ok := h.handlers[req.Topic]
	h.mu.RUnlock()
	if !ok {
		return protocol.Message{
			Type:    protocol.TypeRes,
			ID:      protocol.NewID(),
			TS:      time.Now().UnixMilli(),
			Payload: protocol.MarshalPayload(nil),
			Error: &protocol.MessageError{
				Code:      protocol.CodeUnknownTopic,
				Message:   "no handler for topic: " + req.Topic,
				Retryable: false,
			},
			Topic:     req.Topic,
			SessionID: sess.ID,
			ReplyTo:   req.ID,
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), h.handlerTimeout)
	defer cancel()

	var (
		payload any
		mErr    *protocol.MessageError
	)
	func() {
		defer func() {
			if r := recover(); r != nil {
				h.logger.Error("handler panic", "topic", req.Topic, "panic", r)
				mErr = &protocol.MessageError{Code: protocol.CodeInternal, Message: "handler panic", Retryable: true}
			}
		}()
		payload, mErr = fn(ctx, sess, req)
	}()

	if mErr == nil && ctx.Err() == context.DeadlineExceeded {
		mErr = &protocol.MessageError{
			Code:      protocol.CodeTimeout,
			Message:   "handler timed out after " + h.handlerTimeout.String(),
			Retryable: true,
		}
		payload = nil
	}

	resp := protocol.Message{
		Type:      protocol.TypeRes,
		ID:        protocol.NewID(),
		TS:        time.Now().UnixMilli(),
		Payload:   protocol.MarshalPayload(payload),
		Error:     mErr,
		Topic:     req.Topic,
		SessionID: sess.ID,
		ReplyTo:   req.ID,
	}
	return resp
}

// Publish 向所有订阅了该主题的会话推送事件，返回实际投递的会话数。
// 未订阅的会话不会收到任何帧。
func (h *Hub) Publish(topic string, payload any) int {
	raw := protocol.MarshalPayload(payload)

	h.mu.RLock()
	targets := h.subscribersLocked(topic)
	h.mu.RUnlock()

	for _, sess := range targets {
		msg := protocol.Message{
			Type:      protocol.TypeEvent,
			ID:        protocol.NewID(),
			TS:        time.Now().UnixMilli(),
			Payload:   raw,
			Topic:     topic,
			SessionID: sess.ID,
		}
		sess.Enqueue(&msg)
	}
	return len(targets)
}

// Notify 向单个会话推送事件（用于 hello 等点对点系统帧）。
func (h *Hub) Notify(sess *Session, topic string, payload any) {
	msg := protocol.Message{
		Type:      protocol.TypeEvent,
		ID:        protocol.NewID(),
		TS:        time.Now().UnixMilli(),
		Payload:   protocol.MarshalPayload(payload),
		Topic:     topic,
		SessionID: sess.ID,
	}
	sess.Enqueue(&msg)
}

// IsSubscribed 判断会话是否订阅了某主题（供服务端扩展使用）。
func (h *Hub) IsSubscribed(sessionID, topic string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for pattern, ids := range h.subsByPattern {
		if _, ok := ids[sessionID]; !ok {
			continue
		}
		if protocol.TopicMatches(pattern, topic) {
			return true
		}
	}
	return false
}

// SendError 向会话推送一个错误帧（供传输层在解析失败时使用）。
func (h *Hub) SendError(sess *Session, replyTo string, mErr *protocol.MessageError) {
	h.send(sess, protocol.TypeError, "", replyTo, nil, mErr)
}

func (h *Hub) send(sess *Session, typ, topic, replyTo string, payload any, mErr *protocol.MessageError) {
	msg := protocol.Message{
		Type:      typ,
		ID:        protocol.NewID(),
		TS:        time.Now().UnixMilli(),
		Payload:   protocol.MarshalPayload(payload),
		Error:     mErr,
		Topic:     topic,
		SessionID: sess.ID,
		ReplyTo:   replyTo,
	}
	sess.Enqueue(&msg)
}

// Start 启动后台巡检：会话宽限期回收与幂等缓存清理。
func (h *Hub) Start(ctx context.Context) {
	go func() {
		reap := time.NewTicker(5 * time.Second)
		prune := time.NewTicker(60 * time.Second)
		defer reap.Stop()
		defer prune.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-reap.C:
				h.reapExpired()
			case <-prune.C:
				h.pruneDedupe()
			}
		}
	}()
}

func (h *Hub) reapExpired() {
	now := time.Now()

	h.mu.RLock()
	expired := make([]string, 0)
	for id, sess := range h.sessions {
		if sess.WSAttached() {
			continue
		}
		if now.Sub(sess.LastSeen()) > h.grace {
			expired = append(expired, id)
		}
	}
	h.mu.RUnlock()

	for _, id := range expired {
		h.Delete(id)
	}
}

func (h *Hub) dedupeLookup(key string) (protocol.Message, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	entry, ok := h.dedupe[key]
	if !ok || time.Now().After(entry.expires) {
		return protocol.Message{}, false
	}
	return entry.msg, true
}

func (h *Hub) dedupeStore(key string, msg protocol.Message) {
	h.mu.Lock()
	h.dedupe[key] = dedupeEntry{msg: msg, expires: time.Now().Add(h.dedupeTTL)}
	h.mu.Unlock()
}

func (h *Hub) pruneDedupe() {
	now := time.Now()
	h.mu.Lock()
	for key, entry := range h.dedupe {
		if now.After(entry.expires) {
			delete(h.dedupe, key)
		}
	}
	h.mu.Unlock()
}

// DedupeSize 返回幂等缓存条目数（测试与监控用）。
func (h *Hub) DedupeSize() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.dedupe)
}
