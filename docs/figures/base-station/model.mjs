/** Real timings from the base station. One demo second stands for one 15 s heartbeat. */

export const SPEC = {
  heartbeatMs: 15000,
  heartbeatTimeoutMs: 5000,
  graceMs: 30000,
  pollWaitMs: 25000,
  handlerTimeoutMs: 10000,
  requestTimeoutMs: 10000,
  slowEchoServerMs: 2000,
  slowEchoClientMs: 1000,
  retryDelayMs: 200,
  wsUpgradeProbeMs: 30000,
  reconnectBaseMs: 500,
  reconnectMaxMs: 10000,
  reconnectFactor: 2,
  jitterRatio: 0.2,
  outbox: 512,
  cpuPeriodMs: 1000,
  memPeriodMs: 2000,
  newsPeriodMs: 5000,
  cpuMin: 5,
  cpuMax: 95,
  memMin: 20,
  memMax: 90,
};

export const TOUR = [
  { dur: 2.3, transport: "ws", kind: "event", topic: "metrics.cpu" },
  { dur: 2.1, transport: "ws", kind: "event", topic: "news.notice" },
  { dur: 2.2, transport: "ws", kind: "res", topic: "echo" },
  { dur: 0.55, transport: "poll", kind: "switch" },
  { dur: 1.05, transport: "poll", kind: "event", topic: "metrics.mem" },
  { dur: 1.3, transport: "ws", kind: "upgrade" },
];

export function topicMatches(pattern, topic) {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    return topic.length > prefix.length && topic.startsWith(prefix);
  }
  return pattern === topic;
}

export function accepts(pins, topic) {
  if (pins.metrics && topicMatches("metrics.*", topic)) return "metrics";
  if (pins.news && topicMatches("news.notice", topic)) return "news";
  return null;
}

export function routeOf(beat, pins) {
  if (!beat || beat.kind === "switch" || beat.kind === "upgrade") return "park";
  if (beat.kind === "res") return "pending";
  return accepts(pins, beat.topic) ?? "reject";
}

export function beatAt(clock) {
  const total = TOUR.reduce((sum, beat) => sum + beat.dur, 0);
  let t = ((clock % total) + total) % total;
  for (let index = 0; index < TOUR.length; index++) {
    if (t <= TOUR[index].dur) return { index, beat: TOUR[index], u: TOUR[index].dur ? t / TOUR[index].dur : 0 };
    t -= TOUR[index].dur;
  }
  return { index: 0, beat: TOUR[0], u: 0 };
}

export function gauge(series, n) {
  const [lo, hi] = series === "cpu" ? [SPEC.cpuMin, SPEC.cpuMax] : [SPEC.memMin, SPEC.memMax];
  const mid = (lo + hi) / 2;
  const amp = ((hi - lo) / 2) * 0.62;
  const phase = series === "mem" ? 1.1 : 0.2;
  return Math.round((mid + amp * Math.sin(n * 1.35 + phase)) * 10) / 10;
}

export function realMs(demoSeconds) {
  return demoSeconds * SPEC.heartbeatMs;
}
