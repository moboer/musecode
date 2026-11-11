package hub

import "basestation/internal/protocol"

// 订阅倒排索引：pattern → 会话集合。Publish 只遍历已注册的模式，
// 未订阅的会话不会收到任何一帧。

func (h *Hub) indexSubscribeLocked(sessionID, pattern string) {
	set, ok := h.subsByPattern[pattern]
	if !ok {
		set = make(map[string]struct{})
		h.subsByPattern[pattern] = set
	}
	set[sessionID] = struct{}{}
}

func (h *Hub) indexUnsubscribeLocked(sessionID, pattern string) {
	set, ok := h.subsByPattern[pattern]
	if !ok {
		return
	}
	delete(set, sessionID)
	if len(set) == 0 {
		delete(h.subsByPattern, pattern)
	}
}

// subscribersLocked 返回所有命中该主题的在线会话（调用方需持有读锁）。
func (h *Hub) subscribersLocked(topic string) []*Session {
	targets := make(map[string]struct{})
	for pattern, ids := range h.subsByPattern {
		if !protocol.TopicMatches(pattern, topic) {
			continue
		}
		for id := range ids {
			targets[id] = struct{}{}
		}
	}
	out := make([]*Session, 0, len(targets))
	for id := range targets {
		if sess, ok := h.sessions[id]; ok {
			out = append(out, sess)
		}
	}
	return out
}
