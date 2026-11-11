package httpx

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"basestation/internal/auth"
	"basestation/internal/hub"
	"basestation/internal/protocol"
)

// authenticate 是第 1/2 关的统一入口：从 Authorization 头或 ?token= 取令牌并校验。
// 鉴权关闭时返回 (nil, nil)；开启时缺令牌/验不过一律返回错误。
func (s *Server) authenticate(r *http.Request) (*auth.Claims, error) {
	if !s.authEnabled() {
		return nil, nil
	}
	token := ""
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		token = strings.TrimPrefix(h, "Bearer ")
	}
	if token == "" {
		token = r.URL.Query().Get("token")
	}
	if token == "" {
		return nil, auth.ErrMalformed
	}
	return s.verifier.Verify(token)
}

// writeAuthError 把鉴权错误写成统一错误信封：过期/吊销/缺失/签名错误 → 401，主体不符 → 403。
func (s *Server) writeAuthError(w http.ResponseWriter, err error) {
	if errors.Is(err, hub.ErrOwnerMismatch) {
		writeJSON(w, http.StatusForbidden, map[string]any{
			"error": protocol.MessageError{Code: protocol.CodeForbidden, Message: "session belongs to a different subject", Retryable: false},
		})
		return
	}
	writeJSON(w, http.StatusUnauthorized, map[string]any{
		"error": protocol.MessageError{Code: protocol.CodeUnauthorized, Message: "invalid or missing token: " + err.Error(), Retryable: false},
	})
}

// checkSessionOwner 校验请求令牌主体与会话原主一致（poll/send/delete 在 jwt 模式下的持续校验）。
// 返回 false 时已写好响应。
func (s *Server) checkSessionOwner(w http.ResponseWriter, r *http.Request, sess *hub.Session) bool {
	if !s.authEnabled() {
		return true
	}
	claims, err := s.authenticate(r)
	if err != nil {
		s.writeAuthError(w, err)
		return false
	}
	owner := sess.Owner()
	if owner != nil && claims != nil && (owner.Sub != claims.Sub || owner.Tenant != claims.Tenant) {
		s.logger.Warn("audit: session access denied (owner mismatch)", "sessionId", sess.ID, "owner", owner.Sub, "requester", claims.Sub)
		s.writeAuthError(w, hub.ErrOwnerMismatch)
		return false
	}
	return true
}

// checkConnLimit 第 2 关的连接数上限：仅对新建会话计数。
func (s *Server) checkConnLimit(w http.ResponseWriter, claims *auth.Claims, isResume bool) bool {
	if claims == nil || isResume || s.cfg.MaxConnsPerUser <= 0 {
		return true
	}
	if s.hub.CountByOwner(claims.Sub) >= s.cfg.MaxConnsPerUser {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": protocol.MessageError{Code: protocol.CodeRateLimited, Message: "too many sessions for subject", Retryable: true},
		})
		return false
	}
	return true
}

type devTokenRequest struct {
	Sub        string   `json:"sub"`
	Tenant     string   `json:"tenant"`
	Subscribe  []string `json:"subscribe"`
	Publish    []string `json:"publish"`
	RatePerSec float64  `json:"ratePerSec"`
	Admin      bool     `json:"admin"`
	TTLSeconds int      `json:"ttlSeconds"`
}

// handleDevToken 是第 1 关（令牌交换）的开发实现：用登录主体信息直接换消息令牌。
// 仅在 -dev-token 开启时可用；生产环境应替换为校验 IdP 登录令牌后签发的交换端点。
func (s *Server) handleDevToken(w http.ResponseWriter, r *http.Request) {
	if !s.authEnabled() || !s.cfg.DevToken {
		http.NotFound(w, r)
		return
	}
	var body devTokenRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil || body.Sub == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": protocol.MessageError{Code: protocol.CodeBadMessage, Message: "sub is required", Retryable: false},
		})
		return
	}
	ttl := time.Duration(body.TTLSeconds) * time.Second
	token, err := s.signer.Issue(auth.Claims{
		Sub:        body.Sub,
		Tenant:     body.Tenant,
		Subscribe:  body.Subscribe,
		Publish:    body.Publish,
		RatePerSec: body.RatePerSec,
		Admin:      body.Admin,
	}, ttl)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": protocol.MessageError{Code: protocol.CodeBadMessage, Message: err.Error(), Retryable: false},
		})
		return
	}
	claims, _ := s.verifier.Verify(token)
	s.logger.Info("audit: dev token issued", "sub", body.Sub, "tenant", body.Tenant, "jti", claims.JTI)
	writeJSON(w, http.StatusOK, map[string]any{
		"token":     token,
		"jti":       claims.JTI,
		"expiresAt": claims.ExpiresAt,
	})
}

// handleRevoke 吊销一张令牌（需 admin 令牌）：加入吊销名单并踢除其存量会话。
func (s *Server) handleRevoke(w http.ResponseWriter, r *http.Request) {
	if !s.authEnabled() {
		http.NotFound(w, r)
		return
	}
	claims, err := s.authenticate(r)
	if err != nil {
		s.writeAuthError(w, err)
		return
	}
	if !claims.Admin {
		s.writeAuthError(w, hub.ErrOwnerMismatch)
		return
	}
	var body struct {
		JTI string `json:"jti"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.JTI == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": protocol.MessageError{Code: protocol.CodeBadMessage, Message: "jti is required", Retryable: false},
		})
		return
	}
	s.verifier.Revoke(body.JTI)
	kicked := s.hub.KickByJTI(body.JTI)
	s.logger.Warn("audit: token revoked", "jti", body.JTI, "by", claims.Sub, "kickedSessions", kicked)
	writeJSON(w, http.StatusOK, map[string]any{"revoked": body.JTI, "kickedSessions": kicked})
}
