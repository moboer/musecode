// Package auth 实现基站的消息专用令牌（方案 v2 §6 后端全链路验证）：
//
//   - 第 1 关的产物：短期 JWT（HS256），内含可订/可发 topic 的 ACL、限流配额、租户与主体
//   - 校验：签名、有效期、吊销名单（jti）
//   - ACL 判定：订阅模式子集判定、发布主题匹配、私人 topic 归属判定
//   - 令牌桶限流（进程内实现；多实例部署时换 Redis 计数，接口不变）
//
// 生产环境中令牌应由 IdP 登录态交换签发；本包的 Issue 同时供
// 开发用 dev-token 端点与测试使用，签名密钥由部署方注入。
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/moboer/musecode/server/internal/protocol"
)

// Claims 是消息令牌的载荷。字段与签发端点（/api/auth/dev-token）的 JSON 对齐。
type Claims struct {
	Sub        string   `json:"sub"`
	Tenant     string   `json:"tenant"`
	JTI        string   `json:"jti"`
	IssuedAt   int64    `json:"iat"`
	ExpiresAt  int64    `json:"exp"`
	Subscribe  []string `json:"sub_acl"`
	Publish    []string `json:"pub_acl"`
	RatePerSec float64  `json:"rate,omitempty"` // 发布/请求速率上限（条/秒），0 表示用服务端默认
	Admin      bool     `json:"admin,omitempty"`
}

var (
	ErrMalformed = errors.New("malformed token")
	ErrSignature = errors.New("bad token signature")
	ErrExpired   = errors.New("token expired")
	ErrRevoked   = errors.New("token revoked")
)

// Signer 负责签发（HS256）。
type Signer struct{ secret []byte }

func NewSigner(secret string) *Signer { return &Signer{secret: []byte(secret)} }

// Issue 签发令牌：补齐 jti/iat/exp 后签名。ttl <= 0 时默认 10 分钟。
func (s *Signer) Issue(c Claims, ttl time.Duration) (string, error) {
	if c.Sub == "" {
		return "", fmt.Errorf("claims.sub is required")
	}
	now := time.Now()
	if ttl <= 0 {
		ttl = 10 * time.Minute
	}
	c.IssuedAt = now.Unix()
	c.ExpiresAt = now.Add(ttl).Unix()
	if c.JTI == "" {
		c.JTI = newID()
	}
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	enc := base64.RawURLEncoding
	signing := enc.EncodeToString(header) + "." + enc.EncodeToString(payload)
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(signing))
	return signing + "." + enc.EncodeToString(mac.Sum(nil)), nil
}

// Verifier 负责校验：签名、有效期、吊销名单。
type Verifier struct {
	secret  []byte
	mu      sync.RWMutex
	revoked map[string]struct{}
}

func NewVerifier(secret string) *Verifier {
	return &Verifier{secret: []byte(secret), revoked: make(map[string]struct{})}
}

// Revoke 把 jti 加入吊销名单（第 6 节贯穿机制：吊销后新连接被拒，存量会话由 Hub 踢除）。
func (v *Verifier) Revoke(jti string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.revoked[jti] = struct{}{}
}

func (v *Verifier) IsRevoked(jti string) bool {
	v.mu.RLock()
	defer v.mu.RUnlock()
	_, ok := v.revoked[jti]
	return ok
}

func (v *Verifier) Verify(token string) (*Claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ErrMalformed
	}
	enc := base64.RawURLEncoding
	headerRaw, err := enc.DecodeString(parts[0])
	if err != nil {
		return nil, ErrMalformed
	}
	var header struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(headerRaw, &header) != nil || header.Alg != "HS256" {
		return nil, ErrMalformed
	}
	sig, err := enc.DecodeString(parts[2])
	if err != nil {
		return nil, ErrMalformed
	}
	mac := hmac.New(sha256.New, v.secret)
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return nil, ErrSignature
	}
	payloadRaw, err := enc.DecodeString(parts[1])
	if err != nil {
		return nil, ErrMalformed
	}
	var claims Claims
	if json.Unmarshal(payloadRaw, &claims) != nil || claims.Sub == "" {
		return nil, ErrMalformed
	}
	if claims.ExpiresAt > 0 && time.Now().Unix() > claims.ExpiresAt {
		return nil, ErrExpired
	}
	if v.IsRevoked(claims.JTI) {
		return nil, ErrRevoked
	}
	return &claims, nil
}

// CanPublish 判断发布/请求主题是否被 ACL 允许：任一 ACL 模式命中即可（默认拒绝）。
func CanPublish(acl []string, topic string) bool {
	for _, pattern := range acl {
		if protocol.TopicMatches(pattern, topic) {
			return true
		}
	}
	return false
}

// CanSubscribe 判断订阅模式 pattern 的展开范围是否被 ACL 覆盖（子集判定，默认拒绝）：
//   - pattern 为 "*"：仅当 ACL 含 "*" 才允许
//   - pattern 为 "a.b.*"：ACL 含相同模式，或含能覆盖它的更宽模式（如 "*"、"a.*"）
//   - pattern 为精确主题：ACL 任一模式命中该主题即可
func CanSubscribe(acl []string, pattern string) bool {
	for _, allowed := range acl {
		if allowed == "*" {
			return true
		}
		if pattern == "*" {
			continue
		}
		if strings.HasSuffix(pattern, ".*") {
			if allowed == pattern {
				return true
			}
			if strings.HasSuffix(allowed, ".*") {
				// allowed 的前缀是 pattern 前缀的上级时，pattern 的展开范围是其子集
				allowedPrefix := allowed[:len(allowed)-1] // 形如 "a."
				patternPrefix := pattern[:len(pattern)-1] // 形如 "a.b."
				if strings.HasPrefix(patternPrefix, allowedPrefix) {
					return true
				}
			}
			continue
		}
		if protocol.TopicMatches(allowed, pattern) {
			return true
		}
	}
	return false
}

// ViolatesPrivateTopic 判断订阅模式是否试图进入他人的私人命名空间 user.{id}.*：
// 第二段既不是令牌主体本人、也不是与本人一致的精确段时，一律拒绝（与 ACL 无关，强制校验）。
func ViolatesPrivateTopic(pattern, sub string) bool {
	parts := strings.Split(pattern, ".")
	if len(parts) < 2 || parts[0] != "user" {
		return false
	}
	return parts[1] != sub
}

// RateLimiter 是进程内令牌桶：key 维度由调用方决定（建议 sessionId|topic）。
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
}

type bucket struct {
	tokens float64
	last   time.Time
}

func NewRateLimiter() *RateLimiter {
	return &RateLimiter{buckets: make(map[string]*bucket)}
}

// Allow 按 ratePerSec 补充、burst 为桶容量判定是否放行；ratePerSec <= 0 表示不限流。
func (r *RateLimiter) Allow(key string, ratePerSec, burst float64, now time.Time) bool {
	if ratePerSec <= 0 {
		return true
	}
	if burst < 1 {
		burst = 1
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	b, ok := r.buckets[key]
	if !ok {
		r.buckets[key] = &bucket{tokens: burst - 1, last: now}
		return true
	}
	elapsed := now.Sub(b.last).Seconds()
	b.tokens = min(burst, b.tokens+elapsed*ratePerSec)
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}

func newID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(buf)
}
