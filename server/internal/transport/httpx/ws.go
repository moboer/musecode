package httpx

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/gorilla/websocket"

	"basestation/internal/hub"
	"basestation/internal/protocol"
)

// handleWS 升级为长连接。会话在升级后立即收到 hello，
// 其中包含续接所需的心跳与轮询参数。
// jwt 模式下升级前先过第 2 关：验令牌（头或 ?token=）、连接数上限；
// 续接的主体一致性在 CreateOrResume 内校验，不过则升级后立即断开。
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	claims, err := s.authenticate(r)
	if err != nil {
		s.logger.Warn("audit: ws connect denied", "error", err)
		s.writeAuthError(w, err)
		return
	}
	sessionID := r.URL.Query().Get("sessionId")
	_, isResume := s.hub.Get(sessionID)
	if sessionID == "" {
		isResume = false
	}
	if !s.checkConnLimit(w, claims, isResume) {
		return
	}

	up := websocket.Upgrader{
		ReadBufferSize:  4096,
		WriteBufferSize: 4096,
		CheckOrigin: func(req *http.Request) bool {
			return s.originAllowed(req.Header.Get("Origin"))
		},
	}
	conn, err := up.Upgrade(w, r, nil)
	if err != nil {
		s.logger.Warn("ws upgrade failed", "error", err)
		return
	}

	sess, resumed, err := s.hub.CreateOrResume(sessionID, claims)
	if err != nil {
		s.logger.Warn("audit: ws resume denied", "error", err)
		_ = conn.Close()
		return
	}

	wsID := s.wsSeq.Add(1)
	if prev := sess.BindWS(wsID, func() { _ = conn.Close() }); prev != nil {
		prev() // 同一会话被新连接接管时关闭旧连接
	}

	// hello 走同一出站队列，保证与后续帧的顺序一致。
	hello := &protocol.Message{
		Type:      protocol.TypeHello,
		ID:        protocol.NewID(),
		TS:        time.Now().UnixMilli(),
		Payload:   protocol.MarshalPayload(s.helloPayload(sess, resumed)),
		SessionID: sess.ID,
	}
	if owner := sess.Owner(); owner != nil {
		hello.Tenant, hello.Sender = owner.Tenant, owner.Sub
	}
	sess.Enqueue(hello)
	s.logger.Info("ws attached", "sessionId", sess.ID, "resumed", resumed)

	done := make(chan struct{})
	go s.wsWriter(conn, sess, done)

	s.wsReader(conn, sess)

	close(done)
	sess.UnbindWS(wsID)
	_ = conn.Close()
	s.logger.Info("ws detached", "sessionId", sess.ID)
}

func (s *Server) helloPayload(sess *hub.Session, resumed bool) map[string]any {
	return map[string]any{
		"sessionId":           sess.ID,
		"resumed":             resumed,
		"heartbeatIntervalMs": s.cfg.Heartbeat.Milliseconds(),
		"pollWaitMs":          s.cfg.PollWait.Milliseconds(),
		"graceMs":             s.cfg.Grace.Milliseconds(),
		"serverTs":            time.Now().UnixMilli(),
	}
}

func (s *Server) wsWriter(conn *websocket.Conn, sess *hub.Session, done <-chan struct{}) {
	ping := time.NewTicker(s.cfg.Heartbeat / 2)
	defer ping.Stop()

	for {
		select {
		case <-done:
			return
		case <-ping.C:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				_ = conn.Close()
				return
			}
		case msg := <-sess.Outbox():
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(msg); err != nil {
				_ = conn.Close()
				return
			}
		}
	}
}

func (s *Server) wsReader(conn *websocket.Conn, sess *hub.Session) {
	conn.SetReadLimit(1 << 20)
	readWait := s.cfg.Heartbeat * 3
	_ = conn.SetReadDeadline(time.Now().Add(readWait))
	conn.SetPongHandler(func(string) error {
		sess.Touch()
		return conn.SetReadDeadline(time.Now().Add(readWait))
	})

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		sess.Touch()
		_ = conn.SetReadDeadline(time.Now().Add(readWait))

		var msg protocol.Message
		if err := json.Unmarshal(data, &msg); err != nil {
			s.hub.SendError(sess, "", &protocol.MessageError{
				Code:      protocol.CodeBadMessage,
				Message:   "invalid JSON frame: " + err.Error(),
				Retryable: false,
			})
			continue
		}
		s.hub.HandleInbound(sess, msg)
	}
}
