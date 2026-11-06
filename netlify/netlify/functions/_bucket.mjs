// Shared token-bucket state machine for the Netlify build.
//
// Same rules as the local Node demo server (capacity 12, refill rate easing
// toward the target with tau = 0.25 s, one request every ~1.4 s +/- 0.3 s,
// judged at the gate after 0.95 s of travel, decided requests kept 800 ms),
// re-expressed as a PURE deterministic advance: given a persisted base state
// and a timestamp, any function instance computes the exact same current
// state (spawn jitter comes from a seeded LCG stored in the state, not from
// Math.random). Writers only ever persist deterministic results, so
// concurrent instances cannot corrupt each other.
//
// Authoritative state lives in Netlify Blobs; if Blobs is unavailable the
// module falls back to per-instance memory and says so in the snapshot.

import { getStore } from "@netlify/blobs";

export const CAP = 12;
const TRAVEL_S = 0.95;
const KEEP_MS = 800;

function freshState(now) {
  return {
    tokens: 8,
    refillRate: 1.5,
    rateTarget: 1.5,
    passed: 0,
    dropped: 0,
    nextId: 1,
    seed: 123456789,
    nextSpawnAt: now + 700,
    inflight: [], // { id, born, decision, decidedAt }
    updatedAt: now,
  };
}

function rand(S) {
  S.seed = (S.seed * 1103515245 + 12345) % 2147483648;
  return S.seed / 2147483648;
}

export function advance(S0, now) {
  const S = JSON.parse(JSON.stringify(S0));
  if (now <= S.updatedAt) return S;

  const refillTo = (t) => {
    const dt = (t - S.updatedAt) / 1000;
    if (dt <= 0) return;
    const tau = 0.25;
    const r0 = S.refillRate;
    const rt = S.rateTarget;
    S.tokens = Math.min(CAP, S.tokens + rt * dt + (r0 - rt) * tau * (1 - Math.exp(-dt / tau)));
    S.refillRate = rt + (r0 - rt) * Math.exp(-dt / tau);
    if (Math.abs(rt - S.refillRate) < 0.001) S.refillRate = rt;
    S.updatedAt = t;
  };

  for (;;) {
    let tNext = Infinity;
    let kind = null;
    let who = null;
    const spawnAt = Math.max(S.nextSpawnAt, S.updatedAt);
    if (spawnAt < tNext) {
      tNext = spawnAt;
      kind = "spawn";
    }
    for (const r of S.inflight) {
      if (!r.decision) {
        const jt = Math.max(r.born + TRAVEL_S * 1000, S.updatedAt);
        if (jt < tNext) {
          tNext = jt;
          kind = "judge";
          who = r;
        }
      }
    }
    if (kind === null || tNext > now) break;
    refillTo(tNext);
    if (kind === "spawn") {
      S.inflight.push({ id: S.nextId++, born: tNext, decision: null, decidedAt: 0 });
      S.nextSpawnAt = tNext + (1.4 + (rand(S) * 0.6 - 0.3)) * 1000;
    } else {
      if (S.tokens >= 1) {
        S.tokens -= 1;
        S.passed += 1;
        who.decision = "pass";
      } else {
        S.dropped += 1;
        who.decision = "drop";
      }
      who.decidedAt = tNext;
    }
  }
  refillTo(now);
  S.inflight = S.inflight.filter((r) => !r.decision || now - r.decidedAt < KEEP_MS);
  return S;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

export function snapshot(S, now, mode) {
  return {
    tokens: round3(S.tokens),
    capacity: CAP,
    refillRate: round3(S.refillRate),
    rateTarget: S.rateTarget,
    passed: S.passed,
    dropped: S.dropped,
    inflight: S.inflight.map((r) => ({
      id: r.id,
      progress: Math.min(1, round3((now - r.born) / 1000 / TRAVEL_S)),
      decision: r.decision,
    })),
    store: mode, // "blobs" | "memory" — which backend actually served this
  };
}

let memState = null;

export async function loadState(now) {
  try {
    const store = getStore({ name: "token-bucket", consistency: "strong" });
    const existing = await store.get("state", { type: "json" });
    if (existing) {
      return {
        S: existing,
        mode: "blobs",
        save: async (n) => {
          try {
            await store.setJSON("state", n);
          } catch {}
        },
      };
    }
    const fresh = freshState(now);
    try {
      await store.setJSON("state", fresh);
    } catch {}
    return {
      S: fresh,
      mode: "blobs",
      save: async (n) => {
        try {
          await store.setJSON("state", n);
        } catch {}
      },
    };
  } catch {
    if (!memState) memState = freshState(now);
    return {
      S: memState,
      mode: "memory",
      save: async (n) => {
        memState = n;
      },
    };
  }
}
