// Token bucket rate limiter as a bench machine — LIVE version.
// The page holds no model: a zero-dependency Node server (server.mjs in
// this folder) runs the bucket and streams its state over SSE; this figure
// only renders that state, and its rate control writes back via
// POST /api/rate. Concept + parts list: ../token-bucket/concept.md
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "../../custom-skills/anatomy/kit/iso-kit.mjs";
import { kitScript } from "../../custom-skills/anatomy/scripts/inline-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const theme = process.argv.includes("--light") ? "light" : "dark";

const WIDTH = 640;
const HEIGHT = 380;

const PLATE = { x: -146, y: -68, w: 292, d: 136, r: 8 };
const PLATE_H = 12;
const FOOT_H = 5;

const CAP = 12;
const BALL_POS = [
  // layer 1 (bottom, z 12): 6
  [-20, -7, 12], [-8, -7, 12], [4, -7, 12], [-20, 7, 12], [-8, 7, 12], [4, 7, 12],
  // layer 2 (z 21.5): 4
  [-14, -7, 21.5], [-2, -7, 21.5], [-14, 7, 21.5], [-2, 7, 21.5],
  // layer 3 (z 31): 2
  [-14, 0, 31], [-2, 0, 31],
];
const REFILL_PATH = [[-108, 0, 70], [-84, 0, 59], [-40, 0, 47], [-14, -1, 40]];

const GATE_X = 67;
const DIAL = [118, 41];
const DIAL_R = 13;
const DIAL_TOP = 9;
const RATE_MIN = 0.5;
const RATE_MAX = 3.0;
const RATE0 = 1.5;
const NEEDLE_FROM = -2.1;
const NEEDLE_SPAN = 4.2;

const P = k.fitProjection(
  [
    ...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0),
    [-130, -21, 79], [-84, 21, 74], [-44, -10, 47],
    [141, 27, 19], [83, 54, 13], [131, 54, 0], [118, 41, DIAL_TOP],
  ],
  WIDTH,
  HEIGHT,
  { pad: 22, azimuth: 45 },
);

const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));

function plate() {
  const out = [`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`];
  for (const [x, y] of byDepth(k.corners(PLATE, 22))) {
    out.push(S(k.cylinder(x, y, 7, -PLATE_H - FOOT_H, 1.6, P, 28), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 5.4, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: "mid" }));
  }
  out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: "lo" }));
  const screws = k.corners(PLATE, 10);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2.2, 0, P, 16)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
  const strip = { x: -128, y: PLATE.y + PLATE.d - 15, w: 252, d: 7, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(strip.x + 4, strip.x + strip.w - 4, 4, 5, strip.y + 0.8, 0.6, [2, 3.6], P);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(D([at([strip.x + 2, strip.y + 3.5, 0.6]), at([strip.x + strip.w - 2, strip.y + 3.5, 0.6])], { size: 0.45 }));
  // engraved label plate, back-left of the plate top
  const label = { x: -128, y: -58, w: 46, d: 20, r: 2 };
  out.push(S(k.slabOf(label, 0, 0.8, P, 4), { tone: "lo", crease: "none" }));
  out.push(L(k.planOutline(k.insetPlan(label, 1.6), 0.8, P, 4), { tone: "faint" }));
  for (const [dy, len] of [[6, 30], [11, 22], [16, 26]]) {
    out.push(L(k.lineOnTop([label.x + 5, label.y + dy], [label.x + 5 + len, label.y + dy], 0.8, P), { tone: "lo", free: true }));
  }
  out.push(D([at([label.x + 3.5, label.y + 3.5, 0.8]), at([label.x + label.w - 3.5, label.y + 3.5, 0.8])], { size: 0.45 }));
  return out.join("");
}

function spareTray() {
  const out = [];
  const tray = { x: -104, y: 34, w: 36, d: 22, r: 3 };
  out.push(S(k.slabOf(tray, 0, 3, P, 5, 0.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(tray, 2.5), 3, P, 5), { tone: "faint" }));
  out.push(S(k.cylinder(-93, 43, 4.6, 3, 7.5, P, 24, 1.2), { tone: "hi", crease: "lo" }));
  out.push(S(k.cylinder(-81, 39, 4.6, 3, 7.5, P, 24, 1.2), { tone: "hi", crease: "lo" }));
  out.push(D([at([-100, 38, 3]), at([-72, 52, 3])], { size: 0.45 }));
  return out.join("");
}

function chute() {
  const out = [];
  // support post first (stands on the plate, its saddle meets the chute mid-point)
  out.push(S(k.cylinder(-62, 0, 4.2, 0, 3, P, 24), { tone: "mid" }));
  out.push(S(k.cylinder(-62, 0, 2, 3, 46, P, 20), { tone: "mid", crease: "none" }));
  out.push(L(k.sideArc(-62, 0, 2, 24, P, 12), { tone: "faint" }));
  out.push(S(k.slabOf({ x: -66, y: -4, w: 8, d: 8, r: 1.5 }, 49, 2, P, 3), { tone: "mid" }));
  // rails: drawn early so their ends sit under the bin outlet and the inlet tray
  const a = [-92, -6, 60], b = [-38, -6, 46.5];
  const c = [-92, 6, 60], d = [-38, 6, 46.5];
  out.push(L(k.segment(a, b, P), { tone: "hi" }));
  out.push(L(k.segment(c, d, P), { tone: "hi" }));
  for (const t of [0.25, 0.5, 0.75]) {
    const p1 = a.map((v, i) => v + (b[i] - v) * t);
    const p2 = c.map((v, i) => v + (d[i] - v) * t);
    out.push(L(k.segment(p1, p2, P), { tone: "mid" }));
  }
  return out.join("");
}

function hopper() {
  const out = [];
  for (const py of [-14, 14]) {
    out.push(S(k.cylinder(-124, py, 5, 0, 4, P, 24), { tone: "mid" }));
    out.push(S(k.cylinder(-124, py, 3.2, 4, 53, P, 24), { tone: "mid", crease: "none" }));
    out.push(L(k.sideArc(-124, py, 3.2, 26, P, 12), { tone: "faint" }));
  }
  const bar = { x: -127, y: -16, w: 6, d: 32, r: 2 };
  out.push(S(k.slabOf(bar, 28, 4, P, 3, 0.5), { tone: "mid" }));
  out.push(D([at([-124, -10, 32]), at([-124, 10, 32])], { size: 0.45 }));
  const BIN = { x: -130, y: -21, w: 46, d: 42, r: 3 };
  out.push(S(k.slabOf(BIN, 57, 5, P, 6, 0.8), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(BIN, 2), 62, P, 6), { tone: "faint" }));
  // stored supply balls sit on the bin floor, behind the front wall
  for (const [bx, by] of [[-118, -8], [-106, 4], [-94, -8], [-112, 10], [-100, -11]]) {
    out.push(S(k.cylinder(bx, by, 5, 62, 8, P, 24, 1.2), { tone: "hi", crease: "lo" }));
  }
  out.push(S(k.slabOf({ x: -130, y: -21, w: 46, d: 4, r: 1 }, 62, 17, P, 3, 0.5), { tone: "mid" })); // back wall
  out.push(S(k.slabOf({ x: -130, y: -21, w: 4, d: 42, r: 1 }, 62, 17, P, 3, 0.5), { tone: "mid" })); // left wall
  out.push(S(k.slabOf({ x: -88, y: -21, w: 4, d: 26, r: 1 }, 62, 12, P, 3, 0.5), { tone: "mid" })); // right wall (outlet gap at front)
  out.push(S(k.slabOf({ x: -130, y: 17, w: 46, d: 4, r: 1 }, 62, 9, P, 3, 0.5), { tone: "mid" })); // front wall, lower
  out.push(S(k.slabOf({ x: -88, y: -10, w: 8, d: 20, r: 1 }, 54, 3, P, 3, 0.4), { tone: "mid" })); // outlet lip
  return out.join("");
}

function bucketBack() {
  const out = [];
  const BASE = { x: -36, y: -25, w: 54, d: 50, r: 4 };
  out.push(S(k.slabOf(BASE, 0, 6, P, 6, 0.8), { tone: "mid" }));
  out.push(S(k.slabOf(k.insetPlan(BASE, 4), 6, 5, P, 6, 0.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(BASE, 7), 11, P, 6), { tone: "faint" }));
  // back vertical bars (behind the balls)
  for (const bx of [-16, -2]) out.push(S(k.cylinder(bx, -19, 1.3, 11, 41, P, 12), { tone: "mid", crease: "none" }));
  out.push(S(k.slabOf({ x: -29, y: -19.5, w: 40, d: 1.8, r: 0.8 }, 31, 2.5, P, 2), { tone: "mid", crease: "none" }));
  // corner posts: back two here, front two in bucketFront
  for (const [px, py] of [[-29, -18], [11, -18]]) {
    out.push(S(k.cylinder(px, py, 3.2, 11, 3, P, 20), { tone: "mid" }));
    out.push(S(k.cylinder(px, py, 2.3, 14, 38, P, 20), { tone: "mid", crease: "none" }));
  }
  return out.join("");
}

function tokenBalls() {
  return BALL_POS.map(([bx, by, bz], i) =>
    `<g data-ball="${i}"${i >= 8 ? ' style="display:none"' : ""}>${S(k.cylinder(bx, by, 5.6, bz, 9, P, 28, 1.6), { tone: "lit", lit: true, crease: "lo" })}</g>`,
  ).join("");
}

function refillBalls() {
  const ball = S(k.cylinder(0, 0, 4.4, -4, 8, P, 24, 1.2), { tone: "lit", lit: true, crease: "lo" });
  return [0, 1, 2].map((i) => `<g data-refill="${i}" style="display:none">${ball}</g>`).join("");
}

function bucketFront() {
  const out = [];
  for (const [px, py] of [[-29, 18], [11, 18]]) {
    out.push(S(k.cylinder(px, py, 3.2, 11, 3, P, 20), { tone: "mid" }));
    out.push(S(k.cylinder(px, py, 2.3, 14, 38, P, 20), { tone: "mid", crease: "none" }));
  }
  // inlet tray: the chute lands on it, above the cage's left side
  const tray = { x: -44, y: -10, w: 14, d: 20, r: 2 };
  out.push(S(k.slabOf(tray, 44, 3, P, 4, 0.5), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(tray, 1.6), 47, P, 4), { tone: "faint" }));
  // front + near-side cage bars (in front of the balls)
  for (const bx of [-20, -8, 4]) out.push(S(k.cylinder(bx, 19, 1.1, 11, 41, P, 12), { tone: "mid", crease: "none" }));
  for (const by of [-6, 8]) out.push(S(k.cylinder(13, by, 1.1, 11, 41, P, 12), { tone: "mid", crease: "none" }));
  out.push(S(k.slabOf({ x: -29, y: 18, w: 40, d: 2, r: 0.8 }, 31, 2.5, P, 2), { tone: "mid", crease: "none" }));
  // top rim frame
  out.push(S(k.slabOf({ x: -31, y: -20, w: 46, d: 4, r: 1 }, 52, 4, P, 3, 0.5), { tone: "mid" }));
  out.push(S(k.slabOf({ x: -31, y: 16, w: 46, d: 4, r: 1 }, 52, 4, P, 3, 0.5), { tone: "mid" }));
  out.push(S(k.slabOf({ x: -31, y: -20, w: 4, d: 40, r: 1 }, 52, 4, P, 3, 0.5), { tone: "mid" }));
  out.push(S(k.slabOf({ x: 9, y: -20, w: 4, d: 40, r: 1 }, 52, 4, P, 3, 0.5), { tone: "mid" }));
  // label plate flat on the base's front strip
  const label = { x: -16, y: 19, w: 18, d: 4, r: 0.8 };
  out.push(S(k.slabOf(label, 6, 0.8, P, 3), { tone: "lo", crease: "none" }));
  out.push(L(k.lineOnTop([label.x + 3, label.y + 2], [label.x + 13, label.y + 2], 6.8, P), { tone: "lo", free: true }));
  return out.join("");
}

function track() {
  const out = [];
  const BED = { x: 38, y: -5, w: 102, d: 32, r: 3 };
  out.push(S(k.slabOf(BED, 0, 8, P, 6, 0.8), { tone: "mid", inner: L(k.sideSeam(BED, 4, P, 6), { tone: "faint" }) }));
  out.push(S(k.slabOf({ x: 43, y: -1, w: 92, d: 24, r: 2 }, 8, 2, P, 4), { tone: "lo", crease: "none" }));
  out.push(D([at([48, 11, 10]), at([130, 11, 10])], { size: 0.4 }));
  for (const rx of [52, 70, 88, 106, 124]) {
    out.push(S(k.slabOf({ x: rx, y: 0, w: 3, d: 22, r: 1 }, 10, 1, P, 2), { tone: "mid", crease: "none" }));
  }
  out.push(S(k.slabOf({ x: 38, y: -5, w: 102, d: 3, r: 1 }, 10, 5, P, 3, 0.4), { tone: "mid" })); // back rail
  out.push(S(k.slabOf({ x: 38, y: 24, w: 102, d: 3, r: 1 }, 10, 3, P, 3, 0.4), { tone: "mid" })); // front rail
  out.push(S(k.slabOf({ x: 136, y: -5, w: 5, d: 32, r: 1 }, 8, 11, P, 3, 0.5), { tone: "mid" })); // end stop
  out.push(D([at([138.5, 2, 19]), at([138.5, 20, 19])], { size: 0.45 }));
  out.push(S(k.slabOf({ x: 26, y: 0, w: 14, d: 24, r: 2 }, 2, 5, P, 4, 0.6), { tone: "mid" })); // exit tray
  return out.join("");
}

function gate() {
  const out = [];
  for (const py of [-8, 29]) {
    out.push(S(k.cylinder(GATE_X, py, 3.4, 0, 3, P, 20), { tone: "mid" }));
    out.push(S(k.cylinder(GATE_X, py, 2.6, 3, 43, P, 20), { tone: "mid", crease: "none" }));
    out.push(S(k.cylinder(GATE_X, py, 3.4, 34, 2.5, P, 20), { tone: "mid" }));
    out.push(L(k.sideArc(GATE_X, py, 2.6, 18, P, 12), { tone: "faint" }));
  }
  out.push(S(k.slabOf({ x: 63, y: -10, w: 9, d: 42, r: 2 }, 46, 6, P, 4, 0.6), { tone: "mid" })); // crossbeam
  out.push(D([at([GATE_X, -4, 52]), at([GATE_X, 24, 52])], { size: 0.45 }));
  out.push(S(k.cylinder(GATE_X, 10, 4, 52, 5, P, 24), { tone: "mid" })); // winch drum
  out.push(L(k.knurl(GATE_X, 10, 4, 52, 57, 20, P), { tone: "lo" }));
  out.push(D([at([GATE_X, 10, 57])], { size: 0.5, tone: "hi" }));
  // sensor beside the gate, on the bed's front corner
  out.push(S(k.slabOf({ x: 79, y: 22, w: 9, d: 5, r: 1 }, 10, 2, P, 3), { tone: "mid" }));
  out.push(S(k.cylinder(83, 24, 1.5, 12, 13, P, 14), { tone: "mid", crease: "none" }));
  out.push(D([at([83, 24, 25])], { size: 0.8, tone: "lit" }));
  return out.join("");
}

function gateBlade() {
  const out = [];
  out.push(S(k.slabOf(k.insetPlan({ x: 64.5, y: -2, w: 5, d: 26, r: 1 }, -0.8), 12, 3, P, 3, 0.4), { tone: "lit", lit: true, crease: "lo" }));
  const bladePlan = { x: 64.5, y: -2, w: 5, d: 26, r: 1 };
  const seams = [23, 31, 39].map((gz) => k.sideSeam(bladePlan, gz, P, 3)).join("");
  out.push(S(k.slabOf(bladePlan, 15, 29, P, 3, 0.5), { tone: "lit", lit: true, crease: "lo", inner: L(seams, { tone: "lo" }) }));
  out.push(L(k.planOutline({ x: 66, y: 0, w: 2, d: 22, r: 0.8 }, 44, P, 3), { tone: "lo" }));
  return `<g data-part="gate">${out.join("")}</g>`;
}

function drawer() {
  const out = [];
  const CASE = { x: 52, y: 35, w: 31, d: 19, r: 3 };
  out.push(S(k.slabOf(CASE, 0, 11, P, 5, 0.7), { tone: "mid" }));
  out.push(S(k.slabOf(k.insetPlan(CASE, 3), 11, 0.7, P, 4), { tone: "lo", crease: "none" }));
  out.push(S(k.slabOf({ x: 52, y: 51, w: 31, d: 3.5, r: 1 }, 0, 13, P, 4, 0.6), { tone: "hi", crease: "lo" }));
  out.push(S(k.slabOf({ x: 61, y: 54.5, w: 2.5, d: 2, r: 0.8 }, 5, 3, P, 2), { tone: "mid", crease: "none" }));
  out.push(S(k.slabOf({ x: 73, y: 54.5, w: 2.5, d: 2, r: 0.8 }, 5, 3, P, 2), { tone: "mid", crease: "none" }));
  out.push(S(k.slabOf({ x: 61, y: 56, w: 14.5, d: 2.2, r: 1 }, 6.5, 2.2, P, 2), { tone: "mid" }));
  out.push(D([at([56, 52.8, 13]), at([79, 52.8, 13])], { size: 0.45 }));
  return out.join("");
}

function dial() {
  const out = [];
  // rate knob on its pedestal, left of the dial
  out.push(S(k.slabOf({ x: 88, y: 34, w: 15, d: 15, r: 2 }, 0, 4, P, 4, 0.6), { tone: "mid" }));
  out.push(S(k.cylinder(95.5, 41.5, 5.5, 4, 5, P, 28), { tone: "mid" }));
  out.push(L(k.knurl(95.5, 41.5, 5.5, 4, 9, 24, P), { tone: "lo" }));
  out.push(L(k.lineOnTop([95.5, 41.5], [100.5, 41.5], 9, P), { tone: "hi" }));
  out.push(D([at([95.5, 41.5, 9])], { size: 0.5, tone: "hi" }));
  // the dial itself
  const [x, y] = DIAL;
  out.push(S(k.cylinder(x, y, DIAL_R, 0, DIAL_TOP, P, 56, 0.8), { tone: "hi", crease: "lo" }));
  out.push(L(k.knurl(x, y, DIAL_R, DIAL_TOP - 3.2, DIAL_TOP, 72, P, 0.3), { tone: "lo" }));
  out.push(L(k.sideArc(x, y, DIAL_R, DIAL_TOP - 3.2, P, 40), { tone: "faint" }));
  out.push(L(k.ring(x, y, DIAL_R - 2, DIAL_TOP, P, 56), { tone: "lo" }));
  const ticks = k.radialTicks(x, y, DIAL_R - 2.6, 25, 5, DIAL_TOP, [1.2, 2.6], P, NEEDLE_FROM, NEEDLE_SPAN);
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  out.push(S(k.slabOf({ x: x + DIAL_R - 0.5, y: y - 2.5, w: 5, d: 5, r: 1.2 }, 2, 5, P, 3), { tone: "mid" }));
  out.push(L(k.ring(x, y, 1.5, DIAL_TOP, P, 16), { tone: "mid" }));
  out.push(k.faceTextSvg(k.topMatrix([x, y + 7.5], DIAL_TOP, P, "x"), "RATE", { size: 2.2, tone: "lo", anchor: "middle" }));
  // control wire: knob pedestal across the bench to the gate sensor base
  out.push(k.wireSvg(at([100, 36, 4]), at([86, 25, 12]), { via: [at([94, 27, 13])], tone: "lo", size: 1.1 }));
  return out.join("");
}

function cubes() {
  const plan = { x: -5.5, y: -5.5, w: 11, d: 11, r: 1 };
  const one = [
    S(k.slabOf(plan, 0, 10, P, 3, 0.5), { tone: "lit", lit: true, crease: "lo" }),
    L(k.planOutline(k.insetPlan(plan, 2), 10, P, 3), { tone: "lo" }),
  ].join("");
  return [0, 1, 2, 3].map((i) => `<g data-cube="${i}" style="display:none">${one}</g>`).join("");
}

const needleAt = (rate) => {
  const f = Math.min(1, Math.max(0, (rate - RATE_MIN) / (RATE_MAX - RATE_MIN)));
  const a = NEEDLE_FROM + f * NEEDLE_SPAN;
  const [x, y] = DIAL;
  return k.lineOnTop(
    [x - Math.sin(a) * 3.2, y + Math.cos(a) * 3.2],
    [x + Math.sin(a) * (DIAL_R - 4), y - Math.cos(a) * (DIAL_R - 4)],
    DIAL_TOP + 0.2, P,
  );
};

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  label:
    "A token bucket rate limiter as a bench machine. Token balls roll down a chute from a raised hopper into a caged bucket that holds twelve; the balls visible in the cage are the tokens. Request cubes ride a conveyor to a lifting gate: while the bucket holds a token the gate rises, the cube passes and one ball is spent; when the bucket is empty the cube is tipped into the reject drawer below. A dial on the bench shows the refill rate.",
  body: [
    plate(),
    spareTray(),
    chute(),
    hopper(),
    bucketBack(),
    tokenBalls(),
    refillBalls(),
    bucketFront(),
    track(),
    gate(),
    gateBlade(),
    cubes(),
    drawer(),
    dial(),
    `<path data-part="needle" class="iso-line" data-tone="lit" data-free="start" d="${needleAt(RATE0)}" style="stroke-width:1.1"/>`,
  ],
});

const live = `
const P = ${JSON.stringify(P)};
const CAP = ${CAP};
const DIAL = ${JSON.stringify(DIAL)};
const DIAL_R = ${DIAL_R}, DIAL_TOP = ${DIAL_TOP};
const RATE_MIN = ${RATE_MIN}, RATE_MAX = ${RATE_MAX};
const NEEDLE_FROM = ${NEEDLE_FROM}, NEEDLE_SPAN = ${NEEDLE_SPAN};
const PATH = ${JSON.stringify(REFILL_PATH)};
const stage = document.querySelector(".iso-stage");
const svgEl = stage.querySelector("svg");
const balls = [...svgEl.querySelectorAll("[data-ball]")];
const refills = [...svgEl.querySelectorAll("[data-refill]")];
const cubeEls = [...svgEl.querySelectorAll("[data-cube]")];
const gateEl = svgEl.querySelector('[data-part="gate"]');
const needle = svgEl.querySelector('[data-part="needle"]');
const readout = document.querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;
const needleAt = ${needleAt.toString().replace("k.lineOnTop", "lineOnTop")};
// The server is the only source of truth: S is its latest snapshot, pushed
// over SSE ten times a second. This page keeps no model of its own; it only
// renders S (plus the short pass/drop animations a decision sets off).
let S = null;
let online = false;
let shownFloat = 8, shown = 8, prevFloor = null;
let gateLift = 0;
let rateGoal = ${RATE0}, lastSteerAt = 0, lastPostAt = 0, postTimer = 0;
const refillPool = refills.map((el) => ({ el, t: -1 }));
const cubePool = cubeEls.map((el) => ({ el, id: 0, phase: "idle", t: 0, x: 131, y: 11, z: 11, prog: 0, progAt: 0, fade: undefined }));
function spawnRefill() {
  const slot = refillPool.find((r) => r.t < 0);
  if (slot) slot.t = 0;
}
function refillPos(t) {
  const seg = Math.min(2, Math.floor(t * 3));
  const lt = t * 3 - seg;
  const a = PATH[seg], b = PATH[seg + 1];
  const drop = seg === 2 ? lt * lt : lt;
  return [lerp(a[0], b[0], lt), lerp(a[1], b[1], lt), lerp(a[2], b[2], drop)];
}
function cubeFor(id, now) {
  let c = cubePool.find((q) => q.id === id && q.phase !== "idle");
  if (!c) {
    c = cubePool.find((q) => q.phase === "idle");
    if (c) { c.id = id; c.phase = "in"; c.t = 0; c.fade = undefined; c.prog = 0; c.progAt = now; }
  }
  return c;
}
function onSnapshot(s) {
  S = s;
  const now = performance.now();
  const fl = Math.floor(s.tokens + 1e-6);
  if (prevFloor !== null && fl > prevFloor && !still.matches) spawnRefill();
  prevFloor = fl;
  if (now - lastSteerAt > 1000) rateGoal = s.rateTarget;
  const seen = new Set();
  for (const r of s.inflight) {
    seen.add(r.id);
    const c = cubeFor(r.id, now);
    if (!c) continue;
    if (c.phase === "in") {
      if (r.decision) {
        if (still.matches) { c.phase = "idle"; c.id = 0; }
        else { c.phase = r.decision; c.t = 0; }
      } else {
        c.prog = clamp(r.progress, 0, 1);
        c.progAt = now;
      }
    }
  }
  for (const c of cubePool) {
    if (c.phase === "in" && c.id && !seen.has(c.id)) { c.phase = "idle"; c.id = 0; }
  }
}
function stepLocal(dt, now) {
  for (const r of refillPool) if (r.t >= 0) { r.t += dt / 0.6; if (r.t >= 1) r.t = -1; }
  let gateWanted = 0;
  for (const c of cubePool) {
    if (c.phase === "in") {
      const p = clamp(c.prog + (now - c.progAt) / 950, 0, 1);
      const e = 1 - Math.pow(1 - p, 1.5);
      c.x = lerp(131, 77, e); c.y = 11; c.z = 11;
    } else if (c.phase === "pass") {
      gateWanted = 1;
      c.t += dt / 0.6;
      const t = Math.min(1, c.t);
      c.x = lerp(77, 38, t); c.y = 11; c.z = lerp(11, 7, t);
      if (c.t >= 1) { c.phase = "idle"; c.id = 0; }
    } else if (c.phase === "drop") {
      c.t += dt / 0.65;
      const t = Math.min(1, c.t);
      if (t < 0.45) { const u = t / 0.45; c.x = lerp(77, 72, u); c.y = lerp(11, 30, u); c.z = lerp(11, 17, u); }
      else { const u = (t - 0.45) / 0.55; c.x = lerp(72, 70, u); c.y = lerp(30, 43, u); c.z = lerp(17, 13, u); c.fade = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1; }
      if (c.t >= 1) { c.phase = "idle"; c.id = 0; c.fade = undefined; }
    }
  }
  gateLift += (gateWanted - gateLift) * (1 - Math.exp(-dt / 0.12));
  if (Math.abs(gateWanted - gateLift) < 0.002) gateLift = gateWanted;
}
function draw() {
  if (S) {
    const disp = Math.floor(shownFloat + 1e-6);
    if (disp !== shown) {
      shown = disp;
      balls.forEach((g, i) => { g.style.display = i < disp ? "" : "none"; });
    }
    needle.setAttribute("d", needleAt(S.refillRate));
  }
  gateEl.setAttribute("transform", translateAlong(P, [0, 0, gateLift * 17]));
  for (const r of refillPool) {
    if (r.t < 0) { if (r.el.style.display !== "none") r.el.style.display = "none"; continue; }
    const p = refillPos(Math.min(1, r.t));
    r.el.style.display = "";
    r.el.setAttribute("transform", translateAlong(P, p));
  }
  for (const c of cubePool) {
    if (c.phase === "idle") { if (c.el.style.display !== "none") c.el.style.display = "none"; continue; }
    c.el.style.display = "";
    c.el.style.opacity = c.fade === undefined ? "" : String(c.fade);
    c.el.setAttribute("transform", translateAlong(P, [c.x, c.y, c.z]));
  }
  const base = S
    ? "tokens " + shown + " / " + CAP + " · passed " + S.passed + " · dropped " + S.dropped + " · refill " + S.refillRate.toFixed(1) + "/s"
    : "tokens – / " + CAP + " · passed – · dropped – · refill –";
  const text = base + (online ? " · live" : " · offline");
  if (readout.textContent !== text) readout.textContent = text;
  const aria = S
    ? "server refill " + S.refillRate.toFixed(1) + " per second · tokens " + shown + " of " + CAP + " · passed " + S.passed + " · dropped " + S.dropped + (online ? " · connected" : " · offline")
    : "not connected to the token bucket server";
  if (stage.getAttribute("aria-valuetext") !== aria) {
    stage.setAttribute("aria-valuenow", S ? String(Math.round(S.refillRate * 10)) : "0");
    stage.setAttribute("aria-valuetext", aria);
  }
}
let frame = 0, last = 0, visible = false;
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  if (online) {
    // offline the picture freezes on the last snapshot; online it tracks S
    if (S) {
      if (still.matches) shownFloat = S.tokens;
      else {
        shownFloat += (S.tokens - shownFloat) * (1 - Math.exp(-dt / 0.15));
        if (Math.abs(S.tokens - shownFloat) < 0.01) shownFloat = S.tokens;
      }
    }
    stepLocal(dt, now);
  }
  draw();
  frame = visible ? requestAnimationFrame(tick) : 0;
}
const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); else if (frame) { cancelAnimationFrame(frame); frame = 0; } }, { rootMargin: "120px 0px" }).observe(stage);
// rate control writes back to the server, throttled to one POST per 150 ms
function postRate() {
  lastPostAt = performance.now();
  fetch("/api/rate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rate: rateGoal }) }).catch(() => {});
}
const steer = (next) => {
  rateGoal = clamp(next, RATE_MIN, RATE_MAX);
  lastSteerAt = performance.now();
  if (lastSteerAt - lastPostAt >= 150) { clearTimeout(postTimer); postTimer = 0; postRate(); }
  else if (!postTimer) postTimer = setTimeout(() => { postTimer = 0; postRate(); }, 160);
};
stage.addEventListener("pointermove", (event) => {
  const box = svgEl.getBoundingClientRect();
  const share = clamp((event.clientX - box.left) / box.width, 0, 1);
  steer(RATE_MIN + share * (RATE_MAX - RATE_MIN));
});
stage.addEventListener("keydown", (event) => {
  let to = null;
  if (event.key === "ArrowRight" || event.key === "ArrowUp") to = rateGoal + 0.25;
  if (event.key === "ArrowLeft" || event.key === "ArrowDown") to = rateGoal - 0.25;
  if (event.key === "Home") to = RATE_MIN;
  if (event.key === "End") to = RATE_MAX;
  if (to === null) return;
  event.preventDefault();
  steer(to);
});
const es = new EventSource("/api/stream");
es.onopen = () => { online = true; };
es.onmessage = (ev) => { online = true; try { onSnapshot(JSON.parse(ev.data)); } catch (e) { /* keep the last snapshot */ } };
es.onerror = () => { online = false; };
draw();
`;

const body = k.plateHtml({
  fig: "Fig 5",
  title: "TOKEN BUCKET",
  hint: "Move to set refill",
  readout: "tokens – / 12 · passed – · dropped – · refill – · offline",
  keys: [
    { mark: "lit", label: "Token balls, gate blade and request cubes: what the model moves" },
    { mark: "raised", label: "Caged bucket in the middle: it holds at most 12 tokens" },
    { mark: "edge", label: "Dial at front right: the refill rate, 0.5 to 3.0 per second" },
  ],
  caption:
    "A token bucket driven live by its server. The page keeps no model of its own: a small Node service runs the bucket — tokens refilling, a request arriving about every 1.4 seconds, each request spending a token or being rejected — and streams the state ten times a second, and the machine on the bench draws exactly that. Count the balls in the cage and you have the server's tokens, up to twelve; the dial shows the refill rate the server reports back. Slide the pointer across the figure (or use the arrow keys) and the new rate is written back to the server with POST /api/rate",
  body: `<div class="iso-stage" tabindex="0" role="slider" aria-label="Token bucket, live from the server: move the pointer across, or use the arrow keys, to set the refill rate on the server between 0.5 and 3.0 per second" aria-valuemin="5" aria-valuemax="30" aria-valuenow="15">${svg}</div>`,
});

writeFileSync(join(HERE, theme === "light" ? "token-bucket-live-light.html" : "token-bucket-live.html"), k.pageHtml({ title: "Token bucket — live", theme, body, script: kitScript() + live }));
console.log("wrote", theme === "light" ? "token-bucket-live-light.html" : "token-bucket-live.html");
