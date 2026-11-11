package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"
)

func TestIssueAndVerify(t *testing.T) {
	signer := NewSigner("test-secret")
	verifier := NewVerifier("test-secret")

	token, err := signer.Issue(Claims{Sub: "alice", Tenant: "t1", Subscribe: []string{"metrics.*"}, Publish: []string{"echo"}}, time.Minute)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	claims, err := verifier.Verify(token)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if claims.Sub != "alice" || claims.Tenant != "t1" || claims.JTI == "" {
		t.Fatalf("unexpected claims: %+v", claims)
	}

	if _, err := NewVerifier("wrong-secret").Verify(token); err != ErrSignature {
		t.Fatalf("wrong secret should fail with ErrSignature, got %v", err)
	}
	if _, err := verifier.Verify("not-a-token"); err != ErrMalformed {
		t.Fatalf("garbage should fail with ErrMalformed, got %v", err)
	}
}

func TestVerifyExpiredAndRevoked(t *testing.T) {
	signer := NewSigner("s")
	verifier := NewVerifier("s")

	// Issue 不签已过期令牌，这里按协议手工拼一张过期的验证校验路径。
	expired := handcraftedToken(t, "s", Claims{Sub: "bob", ExpiresAt: time.Now().Add(-time.Minute).Unix(), JTI: "old"})
	if _, err := verifier.Verify(expired); err != ErrExpired {
		t.Fatalf("expired token should fail with ErrExpired, got %v", err)
	}

	live, err := signer.Issue(Claims{Sub: "bob"}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	claims, _ := verifier.Verify(live)
	verifier.Revoke(claims.JTI)
	if _, err := verifier.Verify(live); err != ErrRevoked {
		t.Fatalf("revoked token should fail with ErrRevoked, got %v", err)
	}
}

func handcraftedToken(t *testing.T, secret string, c Claims) string {
	t.Helper()
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	payload, _ := json.Marshal(c)
	enc := base64.RawURLEncoding
	signing := enc.EncodeToString(header) + "." + enc.EncodeToString(payload)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signing))
	return signing + "." + enc.EncodeToString(mac.Sum(nil))
}

func TestCanSubscribeSubset(t *testing.T) {
	cases := []struct {
		acl     []string
		pattern string
		want    bool
	}{
		{[]string{"*"}, "*", true},
		{[]string{"metrics.*"}, "*", false},
		{[]string{"metrics.*"}, "metrics.*", true},
		{[]string{"metrics.*"}, "metrics.cpu.*", true},
		{[]string{"metrics.cpu.*"}, "metrics.*", false},
		{[]string{"metrics.*"}, "metrics.cpu", true},
		{[]string{"news.notice"}, "news.notice", true},
		{[]string{"news.notice"}, "news.*", false},
		{[]string{"news.*"}, "other.topic", false},
		{nil, "metrics.cpu", false},
	}
	for _, c := range cases {
		if got := CanSubscribe(c.acl, c.pattern); got != c.want {
			t.Errorf("CanSubscribe(%v, %q) = %v, want %v", c.acl, c.pattern, got, c.want)
		}
	}
}

func TestCanPublishAndPrivateTopic(t *testing.T) {
	if !CanPublish([]string{"echo", "device.*"}, "device.command") {
		t.Error("device.command should be allowed")
	}
	if CanPublish([]string{"echo"}, "device.command") {
		t.Error("device.command should be denied")
	}
	if !ViolatesPrivateTopic("user.bob.*", "alice") {
		t.Error("alice subscribing user.bob.* should violate")
	}
	if ViolatesPrivateTopic("user.alice.*", "alice") {
		t.Error("alice subscribing her own namespace should be fine")
	}
	if ViolatesPrivateTopic("metrics.*", "alice") {
		t.Error("metrics.* is not a private namespace")
	}
}

func TestRateLimiter(t *testing.T) {
	limiter := NewRateLimiter()
	now := time.Now()
	if !limiter.Allow("k", 1, 1, now) {
		t.Fatal("first request should pass")
	}
	if limiter.Allow("k", 1, 1, now) {
		t.Fatal("second immediate request should be limited")
	}
	if !limiter.Allow("k", 1, 1, now.Add(1100*time.Millisecond)) {
		t.Fatal("request after refill should pass")
	}
	if !limiter.Allow("any", 0, 0, now) {
		t.Fatal("rate<=0 should be unlimited")
	}
}
