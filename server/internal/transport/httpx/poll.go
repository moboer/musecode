package httpx

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"basestation/internal/protocol"
)

type createSessionResponse struct {
	SessionID           string `json:"sessionId"`
	Resumed             bool   `json:"resumed"`
	HeartbeatIntervalMs int64  `json:"heartbeatIntervalMs"`
	PollWaitMs          int64  `json:"pollWaitMs"`
	GraceMs             int64  `json:"graceMs"`
	ServerTs            int64  `json:"serverTs"`
}

type pollResponse struct {
	Messages   []protocol.Message `json:"messages"`
	Timeout    bool               `json:"timeout"`
	ReplacedBy string             `json:"replacedBy,omitempty"`
	ServerTs   int64              `json:"serverTs"`
}

// handleCreateSession 创建或续接轮询会话。
func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)

	sess, resumed := s.hub.CreateOrResume(body.SessionID)
	sess.Touch()

	writeJSON(w, http.StatusOK, createSessionResponse{
		SessionID:           sess.ID,
		Resumed:             resumed,
		HeartbeatIntervalMs: s.cfg.Heartbeat.Milliseconds(),
		PollWaitMs:          s.cfg.PollWait.Milliseconds(),
		GraceMs:             s.cfg.Grace.Milliseconds(),
		ServerTs:            time.Now().UnixMilli(),
	})
}

// handleDeleteSession 主动关闭会话。
func (s *Server) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	s.hub.Delete(r.PathValue("id"))
	w.WriteHeader(http.StatusNoContent)
}

// handleSend 批量接收入站帧，与 WS 读泵走同一处理路径。
func (s *Server) handleSend(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess, ok := s.hub.Get(id)
	if !ok {
		s.writeSessionNotFound(w, id)
		return
	}

	var body struct {
		Messages []protocol.Message `json:"messages"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": protocol.MessageError{Code: protocol.CodeBadMessage, Message: "invalid body: " + err.Error()},
		})
		return
	}
	if len(body.Messages) > 256 {
		body.Messages = body.Messages[:256]
	}

	for i := range body.Messages {
		s.hub.HandleInbound(sess, body.Messages[i])
	}
	sess.Touch()

	writeJSON(w, http.StatusAccepted, map[string]any{"accepted": len(body.Messages)})
}

// handlePoll 长轮询拉取出站帧。返回空数组 + timeout=true 表示挂起到期。
func (s *Server) handlePoll(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sess, ok := s.hub.Get(id)
	if !ok {
		s.writeSessionNotFound(w, id)
		return
	}

	lastSeq, _ := strconv.ParseInt(r.URL.Query().Get("lastSeq"), 10, 64)
	waitMs, _ := strconv.ParseInt(r.URL.Query().Get("waitMs"), 10, 64)
	wait := s.cfg.PollWait
	if waitMs >= 0 && waitMs < 60000 {
		wait = time.Duration(waitMs) * time.Millisecond
	}

	// 轮询本身就是心跳。
	sess.Touch()

	if sess.WSAttached() {
		writeJSON(w, http.StatusOK, pollResponse{
			Messages:   []protocol.Message{},
			ReplacedBy: "ws",
			ServerTs:   time.Now().UnixMilli(),
		})
		return
	}

	collected := make([]protocol.Message, 0, 16)
	deadline := time.Now().Add(wait)

waitLoop:
	for {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		timer := time.NewTimer(remaining)
		select {
		case <-r.Context().Done():
			timer.Stop()
			return
		case <-timer.C:
			timer.Stop()
			break waitLoop
		case msg := <-sess.Outbox():
			timer.Stop()
			if msg.Seq > lastSeq {
				collected = append(collected, *msg)
				lastSeq = msg.Seq
			}
			for len(collected) < 64 {
				select {
				case next := <-sess.Outbox():
					if next.Seq > lastSeq {
						collected = append(collected, *next)
						lastSeq = next.Seq
					}
				default:
					timer.Stop()
					break waitLoop
				}
			}
			if len(collected) > 0 {
				break waitLoop
			}
		}
	}

	writeJSON(w, http.StatusOK, pollResponse{
		Messages: collected,
		Timeout:  len(collected) == 0,
		ServerTs: time.Now().UnixMilli(),
	})
}

func (s *Server) writeSessionNotFound(w http.ResponseWriter, id string) {
	writeJSON(w, http.StatusNotFound, map[string]any{
		"error": protocol.MessageError{
			Code:      protocol.CodeSessionNotFound,
			Message:   "session not found: " + id,
			Retryable: false,
		},
	})
}
