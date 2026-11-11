package hub

import (
	"sync"
	"time"

	"basestation/internal/auth"
	"basestation/internal/protocol"
)

// OutboxSize 是每个会话的出站队列容量。队列满时丢弃最旧帧，
// 保证慢消费者不会阻塞基站。
const OutboxSize = 512

// Session 是基站侧唯一的连接状态载体：WS 与 HTTP 轮询只是它的可替换读写端。
type Session struct {
	ID string

	outbox chan *protocol.Message

	mu       sync.Mutex
	subs     map[string]struct{}
	seq      int64
	lastSeen time.Time
	created  time.Time
	closed   bool
	dropped  int64
	wsID     int64
	wsClose  func()

	// owner 是建连时令牌的 Claims（鉴权开启时非 nil）。会话的权限判定全部以它为准，
	// 续接时必须与它同主体——光有 sessionId 不能接管别人的会话。
	owner      *auth.Claims
	violations int

	// sendMu 串行化出队，保证 seq 与 channel 中的顺序一致。
	sendMu sync.Mutex
}

// NewSession 创建一个新会话。
func NewSession(id string) *Session {
	now := time.Now()
	return &Session{
		ID:       id,
		outbox:   make(chan *protocol.Message, OutboxSize),
		subs:     make(map[string]struct{}),
		lastSeen: now,
		created:  now,
	}
}

// Subscribe 幂等加入订阅模式，返回是否为新增。
func (s *Session) Subscribe(topic string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.subs[topic]; ok {
		return false
	}
	s.subs[topic] = struct{}{}
	return true
}

// Unsubscribe 移除订阅模式，返回是否存在。
func (s *Session) Unsubscribe(topic string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.subs[topic]
	delete(s.subs, topic)
	return ok
}

// Subscriptions 返回当前订阅模式快照。
func (s *Session) Subscriptions() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.subs))
	for topic := range s.subs {
		out = append(out, topic)
	}
	return out
}

// Enqueue 分配 seq 后写入出站队列；队列满时丢弃最旧一帧。
func (s *Session) Enqueue(msg *protocol.Message) {
	s.sendMu.Lock()
	defer s.sendMu.Unlock()

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.seq++
	msg.Seq = s.seq
	s.mu.Unlock()

	select {
	case s.outbox <- msg:
		return
	default:
	}

	select {
	case <-s.outbox:
	default:
	}
	s.mu.Lock()
	s.dropped++
	s.mu.Unlock()

	select {
	case s.outbox <- msg:
	default:
	}
}

// Outbox 返回出站队列，供 WS 写泵或长轮询消费。
func (s *Session) Outbox() <-chan *protocol.Message { return s.outbox }

// SetOwner 绑定会话主体（建连验过令牌后调用一次）。
func (s *Session) SetOwner(claims *auth.Claims) {
	s.mu.Lock()
	s.owner = claims
	s.mu.Unlock()
}

// Owner 返回会话主体（未开启鉴权时为 nil）。
func (s *Session) Owner() *auth.Claims {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.owner
}

// AddViolation 累加一次违规（超限/越权尝试），返回累计次数。
func (s *Session) AddViolation() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.violations++
	return s.violations
}

// Kick 强制断开本会话的 WS 连接（若附着）并标记关闭，用于令牌过期/吊销/违规封禁。
func (s *Session) Kick() {
	s.mu.Lock()
	closeFn := s.wsClose
	s.closed = true
	s.mu.Unlock()
	if closeFn != nil {
		closeFn()
	}
}

// Touch 刷新活跃时间。
func (s *Session) Touch() {
	s.mu.Lock()
	s.lastSeen = time.Now()
	s.mu.Unlock()
}

// LastSeen 返回最近活跃时间。
func (s *Session) LastSeen() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastSeen
}

// BindWS 绑定一条 WS 连接，返回被替换的旧连接关闭函数。
func (s *Session) BindWS(id int64, closeFn func()) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev := s.wsClose
	s.wsID = id
	s.wsClose = closeFn
	s.lastSeen = time.Now()
	return prev
}

// UnbindWS 解绑指定代次的 WS 连接（避免误清后来者）。
func (s *Session) UnbindWS(id int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.wsID != id {
		return
	}
	s.wsID = 0
	s.wsClose = nil
	s.lastSeen = time.Now()
}

// WSAttached 表示当前是否有 WS 连接接管本会话。
func (s *Session) WSAttached() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.wsClose != nil
}

// Close 标记会话关闭，阻止后续入队。
func (s *Session) Close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
}

// Closed 返回会话是否已关闭。
func (s *Session) Closed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// Dropped 返回因队列溢出被丢弃的帧数。
func (s *Session) Dropped() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dropped
}

// CreatedAt 返回会话创建时间。
func (s *Session) CreatedAt() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.created
}
