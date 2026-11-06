// Demo backend for the live token bucket figure. Zero dependencies (node:http only).
//
// The server is the single source of truth: it runs a real token bucket
// (capacity 12, tokens refill at refillRate/s easing toward rateTarget,
// one request every ~1.4 s ± 0.3 s; a request that finds tokens >= 1 spends
// one and passes, otherwise it is dropped) and streams the state to the
// page over SSE. The page only renders; the rate control writes back
// through POST /api/rate.
//
//   node server.mjs   ->   http://localhost:8371  (dark)   /light (light)

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 8371;
const CAP = 12;
const TRAVEL_S = 0.95; // conveyor ride from spawn to the gate, as drawn
const KEEP_DECISION_MS = 800; // keep a decided request around so the page can animate it

const state = {
  tokens: 8,
  refillRate: 1.5,
  rateTarget: 1.5,
  passed: 0,
  dropped: 0,
  nextId: 1,
  inflight: [], // { id, born, decision, decidedAt }
};
let nextSpawnIn = 0.7;
let lastTick = Date.now();

function tick() {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;

  // refill rate eases toward the target, tokens accumulate up to capacity
  state.refillRate += (state.rateTarget - state.refillRate) * (1 - Math.exp(-dt / 0.25));
  if (Math.abs(state.rateTarget - state.refillRate) < 0.001) state.refillRate = state.rateTarget;
  state.tokens = Math.min(CAP, state.tokens + state.refillRate * dt);

  // requests arrive about every 1.4 s with jitter
  nextSpawnIn -= dt;
  if (nextSpawnIn <= 0) {
    nextSpawnIn += 1.4 + (Math.random() * 0.6 - 0.3);
    state.inflight.push({ id: state.nextId++, born: now, decision: null, decidedAt: 0 });
  }

  // a request is judged when it reaches the gate
  for (const r of state.inflight) {
    if (!r.decision && (now - r.born) / 1000 >= TRAVEL_S) {
      if (state.tokens >= 1) {
        state.tokens -= 1;
        state.passed += 1;
        r.decision = "pass";
      } else {
        state.dropped += 1;
        r.decision = "drop";
      }
      r.decidedAt = now;
    }
  }
  state.inflight = state.inflight.filter((r) => !r.decision || now - r.decidedAt < KEEP_DECISION_MS);
}
setInterval(tick, 20);

const round3 = (v) => Math.round(v * 1000) / 1000;
function snapshot() {
  const now = Date.now();
  return {
    tokens: round3(state.tokens),
    capacity: CAP,
    refillRate: round3(state.refillRate),
    rateTarget: state.rateTarget,
    passed: state.passed,
    dropped: state.dropped,
    inflight: state.inflight.map((r) => ({
      id: r.id,
      progress: Math.min(1, round3((now - r.born) / 1000 / TRAVEL_S)),
      decision: r.decision,
    })),
  };
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sendPage(res, file) {
  try {
    const html = readFileSync(join(HERE, file), "utf8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("page not built yet: run node build.mjs && node build.mjs --light");
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/") return sendPage(res, "token-bucket-live.html");
  if (req.method === "GET" && url.pathname === "/light") return sendPage(res, "token-bucket-live-light.html");
  if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, snapshot());
  if (req.method === "GET" && url.pathname === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const push = () => res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    push();
    const timer = setInterval(push, 100);
    req.on("close", () => clearInterval(timer));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/rate") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { rate } = JSON.parse(body);
        if (typeof rate !== "number" || !Number.isFinite(rate)) throw new Error("rate must be a number");
        state.rateTarget = Math.min(3.0, Math.max(0.5, rate));
        sendJson(res, 200, snapshot());
      } catch (err) {
        sendJson(res, 400, { error: String(err.message ?? err) });
      }
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`token bucket demo server listening on http://localhost:${PORT} (dark) and http://localhost:${PORT}/light`);
});
