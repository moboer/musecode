import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { SPEC, TOUR, topicMatches, accepts, routeOf, beatAt, gauge } from "./model.mjs";

const SKILL = join(process.env.USERPROFILE, ".agents", "skills", "anatomy");
const kitUrl = (file) => pathToFileURL(join(SKILL, file)).href;
const k = await import(kitUrl("kit/iso-kit.mjs"));
const A = await import(kitUrl("kit/audit.mjs"));
const { kitScript } = await import(kitUrl("scripts/inline-kit.mjs"));

const HERE = dirname(fileURLToPath(import.meta.url));
const theme = process.argv.includes("--dark") ? "dark" : "light";
const WIDTH = 820;
const HEIGHT = 520;

const PLATE = { x: -178, y: -100, w: 364, d: 210, r: 8 };
const PLATE_H = 12;
const BED = 3;
const PLATFORM = { x: -148, y: -68, w: 304, d: 124, r: 2 };

const BACK = { x: -110, y: -68, w: 220, d: 6 };
const LEFT = { x: -110, y: -62, w: 6, d: 40 };
const POST = { x: 104, y: -18, w: 6, d: 22 };
const WALL_H = 46;

const PIN_Y = -54;
const PIN_X = { metrics: -50, news: 6, echo: 68 };
const DRUM = { x: 0, y: -26, r: 12 };
const DEST_Y = 44;
const INST_Y = 22;

const P = k.fitProjection(
  [
    [PLATE.x, PLATE.y, -PLATE_H - 6],
    [PLATE.x + PLATE.w, PLATE.y + PLATE.d, 8],
    [-120, -68, WALL_H + BED],
    [130, 78, 36],
    [DRUM.x, DRUM.y, BED + 32],
  ],
  WIDTH,
  HEIGHT,
  { pad: 28, azimuth: 38, elevation: 34 },
);

const R = A.recorder(P);
const at = (point) => k.iso(point, P);

function slabPiece(name, plan, z, h, tone, opt = {}) {
  plan = { ...plan, r: plan.r ?? 0 };
  const steps = opt.steps ?? 5;
  const bevel = opt.flat ? 0 : (opt.bevel ?? 0.4);
  const paths = k.slabOf(plan, z, h, P, steps, bevel);
  const svg = k.solidSvg(paths, {
    tone,
    lit: Boolean(opt.lit),
    flat: Boolean(opt.flat),
    crease: opt.crease ?? (opt.flat ? "none" : "faint"),
  });
  const shape = A.slab(plan, z, Math.max(h, 0.2), { name, ground: opt.ground || undefined }, steps);
  return { name, svg, shape, at: [plan.x + plan.w / 2, plan.y + plan.d / 2, z + h / 2] };
}

function puckPiece(name, x, y, r, z, h, tone, opt = {}) {
  const paths = k.cylinder(x, y, r, z, h, P, opt.steps ?? 28, opt.bevel ?? 0);
  const svg = k.solidSvg(paths, { tone, lit: Boolean(opt.lit), crease: opt.crease ?? "faint" });
  const shape = A.cylinder(x, y, r, z, h, { name });
  return { name, svg, shape, at: [x, y, z + h / 2] };
}

function part(name, pieces, extra = "", group = "") {
  const list = Array.isArray(pieces) ? pieces : [pieces];
  let svg = list.map((piece) => piece.svg).join("") + extra;
  if (group) svg = `<g data-part="${group}">${svg}</g>`;
  const shapes = list.map((piece) => {
    piece.shape.name = piece.name || name;
    R.solid(piece.shape);
    return piece.shape;
  });
  const origin = list[0].at;
  R.put({ name, svg, shapes, at: origin });
}

function screws(plan, z, inset) {
  const pts = k.corners(plan, inset);
  return (
    k.lineSvg(pts.map(([x, y]) => k.ring(x, y, 2, z, P, 12)).join(""), { tone: "lo" }) +
    k.dotsSvg(pts.map(([x, y]) => at([x, y, z])), { size: 0.46 })
  );
}

function knurl(x, y, r, z0, z1, count = 32) {
  return k.lineSvg(k.knurl(x, y, r, z0, z1, count, P, 0.3), { tone: "lo" });
}

function needleD(cx, cy, z, value) {
  const sweep = Math.PI * 0.8;
  const angle = -sweep / 2 + (Math.max(0, Math.min(100, value)) / 100) * sweep;
  return k.lineOnTop(
    [cx + Math.sin(angle) * 2.3, cy - Math.cos(angle) * 2.3],
    [cx + Math.sin(angle) * 8.6, cy - Math.cos(angle) * 8.6],
    z,
    P,
  );
}

function handD(cx, cy, z, turn, r0, r1) {
  const angle = turn * Math.PI * 2 - Math.PI / 2;
  return k.lineOnTop(
    [cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0],
    [cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1],
    z,
    P,
  );
}

const plateTop = 0;
part(
  "stand.plate",
  slabPiece("stand.plate", PLATE, -PLATE_H, PLATE_H, "mid", { ground: true, bevel: 1.1, steps: 6 }),
  k.lineSvg(k.planOutline(k.insetPlan(PLATE, 7), plateTop, P), { tone: "faint" }) + screws(PLATE, plateTop, 14),
);
for (const [x, y] of k.corners(PLATE, 26)) {
  const id = `stand.foot.${x < 0 ? "w" : "e"}.${y < 0 ? "s" : "n"}`;
  part(id, [
    puckPiece(`${id}.pad`, x, y, 6.2, -PLATE_H - 6.4, 2.2, "lo"),
    puckPiece(`${id}.stem`, x, y, 3.6, -PLATE_H - 4.2, 4.2, "mid"),
  ]);
}

part("bed", slabPiece("bed", PLATFORM, 0, BED, "mid", { bevel: 0.6, steps: 4 }));

part("cab.back", slabPiece("cab.back", BACK, BED, WALL_H, "mid", { bevel: 0.5 }), screws(BACK, BED + WALL_H, 4));
part("cab.left", slabPiece("cab.left", LEFT, BED, WALL_H - 4, "mid", { bevel: 0.4 }));
part("cab.post", slabPiece("cab.post", POST, BED, WALL_H - 8, "mid", { bevel: 0.4 }), screws(POST, BED + WALL_H - 8, 1.4));
const sill = { x: -102, y: 48, w: 204, d: 4, r: 1 };
part("cab.sill", slabPiece("cab.sill", sill, BED, 5, "mid", { bevel: 0.35 }));

const label = { x: -26, y: 66, w: 52, d: 16, r: 1.4 };
part(
  "stand.label",
  slabPiece("stand.label", label, 0, 1.1, "lo", { flat: true }),
  [3.4, 6.6, 9.8].map((dy) => {
    const a = [label.x + 1.8, label.y + dy];
    const b = [label.x + label.w - 1.8, label.y + dy];
    return k.lineSvg(k.lineOnTop(a, b, 1.1, P), { tone: "lo" }) + k.dotsSvg([at([...a, 1.1]), at([...b, 1.1])], { size: 0.42, tone: "mid" });
  }).join("") +
    k.faceTextSvg(k.topMatrix([label.x + label.w / 2, label.y + 13.2], 1.15, P, "x"), "基站", { size: 3.1, tone: "hi", anchor: "middle" }),
);
const strip = { x: -150, y: 90, w: 300, d: 7, r: 1 };
part(
  "stand.ruler",
  slabPiece("stand.ruler", strip, 0, 0.7, "lo", { flat: true }),
  (() => {
    const ticks = k.topTicks(strip.x + 2, strip.x + strip.w - 2, 4, 5, strip.y, 0.7, [1.8, 3.4], P);
    return k.lineSvg(ticks.minor, { tone: "lo" }) + k.lineSvg(ticks.major, { tone: "mid" }) + k.dotsSvg([at([strip.x + 2, strip.y + 3.4, 0.7]), at([strip.x + strip.w - 2, strip.y + 3.4, 0.7])], { size: 0.4 });
  })(),
);

for (const [id, x] of Object.entries(PIN_X)) {
  const y = PIN_Y;
  const cap = { x: x - 6.2, y: y - 3.2, w: 12.4, d: 6.4, r: 1 };
  part(`pin.${id}.west`, puckPiece(`pin.${id}.west`, x - 4.4, y, 1.15, BED, 16, "mid"));
  part(`pin.${id}.east`, puckPiece(`pin.${id}.east`, x + 4.4, y, 1.15, BED, 16, "mid"));
  part(`pin.${id}.cap`, slabPiece(`pin.${id}.cap`, cap, BED + 16, 2.2, "mid", { bevel: 0.3 }), screws(cap, BED + 18.2, 1.6));
  part(`pin.${id}.rod`, puckPiece(`pin.${id}.rod`, x, y, 1.05, BED, 9, "hi"), "", `pin-${id}`);
}
const bin = { x: 116, y: -64, w: 28, d: 16 };
part("bin.far", slabPiece("bin.far", { x: bin.x, y: bin.y, w: bin.w, d: 3, r: 0.6 }, BED, 8, "mid", { bevel: 0.3 }));
part("bin.west", slabPiece("bin.west", { x: bin.x, y: bin.y + 3, w: 3, d: bin.d - 3, r: 0.6 }, BED, 8, "mid", { bevel: 0.3 }));
part("bin.east", slabPiece("bin.east", { x: bin.x + bin.w - 3, y: bin.y + 3, w: 3, d: bin.d - 3, r: 0.6 }, BED, 8, "mid", { bevel: 0.3 }));

part("drum.ped", puckPiece("drum.ped", DRUM.x, DRUM.y, 6, BED, 4, "mid"));
const drumZ = BED + 4;
const drumH = 22;
part(
  "drum.body",
  puckPiece("drum.body", DRUM.x, DRUM.y, DRUM.r, drumZ, drumH, "hi", { steps: 40 }),
  k.lineSvg(k.ring(DRUM.x, DRUM.y, DRUM.r - 1.6, drumZ + drumH, P, 40), { tone: "lo" }) +
    k.lineSvg(k.ring(DRUM.x, DRUM.y, 2.2, drumZ + drumH, P, 16), { tone: "mid" }) +
    (() => {
      const ticks = k.radialTicks(DRUM.x, DRUM.y, DRUM.r - 1.6, 24, 6, drumZ + drumH, [1.2, 2.4], P);
      return k.lineSvg(ticks.minor, { tone: "lo" }) + k.lineSvg(ticks.major, { tone: "mid" });
    })() +
    k.lineSvg(handD(DRUM.x, DRUM.y, drumZ + drumH + 0.15, 0.08, 2.2, DRUM.r - 3.2), { tone: "hi", free: "end" }).replace("<path ", '<path data-part="seq-hand" '),
);
part("drum.cap", puckPiece("drum.cap", DRUM.x, DRUM.y, 2.4, drumZ + drumH, 1.4, "mid"));

const ductW = { x: -78, y: -8, w: 3, d: 16, r: 0.6 };
const ductE = { x: -34, y: -8, w: 3, d: 16, r: 0.6 };
part("duct.west", slabPiece("duct.west", ductW, BED, 8, "mid", { bevel: 0.3 }));
part("duct.east", slabPiece("duct.east", ductE, BED, 8, "mid", { bevel: 0.3 }));
part(
  "duct.blower",
  puckPiece("duct.blower", -82, -38, 4.8, BED, 6.5, "mid", { steps: 28 }),
  knurl(-82, -38, 4.8, BED + 4, BED + 6.5, 24),
);
part("duct.hub", puckPiece("duct.hub", -82, -38, 1.5, BED + 6.5, 1.5, "hi"));

for (const [name, y] of [["near", 5.2], ["far", -7.4]]) {
  part(`rail.${name}`, slabPiece(`rail.${name}`, { x: 28, y, w: 42, d: 2.6, r: 0.6 }, BED, 2, "mid", { bevel: 0.25 }));
}
for (const x of [34, 46, 58]) {
  part(`tie.${x}`, slabPiece(`tie.${x}`, { x, y: -4.2, w: 2.2, d: 8.6, r: 0.4 }, BED, 1.1, "lo", { flat: true }));
}
part("rail.stop", slabPiece("rail.stop", { x: 73, y: -8, w: 3.2, d: 16, r: 0.6 }, BED, 6, "mid", { bevel: 0.3 }));

const cartBody = { x: 34, y: -4, w: 22, d: 12, r: 1.2 };
const cartPieces = [
  puckPiece("cart.roll.nw", 38, -6.1, 1.6, BED + 2, 2.4, "lo"),
  puckPiece("cart.roll.ne", 52, -6.1, 1.6, BED + 2, 2.4, "lo"),
  puckPiece("cart.roll.sw", 38, 6.5, 1.6, BED + 2, 2.4, "lo"),
  puckPiece("cart.roll.se", 52, 6.5, 1.6, BED + 2, 2.4, "lo"),
  slabPiece("cart.body", cartBody, BED + 4.4, 5.4, "hi", { bevel: 0.35 }),
  puckPiece("cart.knob", 54, 2, 1.6, BED + 9.8, 1.15, "mid"),
];
part("cart", cartPieces, screws(cartBody, BED + 9.8, 2.2) + knurl(54, 2, 1.6, BED + 9.8, BED + 10.95, 16), "cart");

const gatePosts = [
  puckPiece("gate.west", -84, 2, 1.5, BED, 12, "mid"),
  puckPiece("gate.east", 86, 2, 1.5, BED, 12, "mid"),
];
part("gate.posts", gatePosts);
part("gate.beam", slabPiece("gate.beam", { x: -86, y: -1.2, w: 174, d: 6.4, r: 1 }, BED + 12, 2, "mid", { bevel: 0.3 }));
const shutter = { x: 30, y: -0.6, w: 38, d: 5.2, r: 1 };
part(
  "gate.shutter",
  slabPiece("gate.shutter", shutter, BED + 14, 3.2, "hi", { bevel: 0.3 }),
  screws(shutter, BED + 17.2, 1.8),
  "shutter",
);
part("gate.knob", puckPiece("gate.knob", 49, 2, 2.2, BED + 17.2, 2.4, "mid"), knurl(49, 2, 2.2, BED + 17.2, BED + 19.6, 18));

part("bellows.base", slabPiece("bellows.base", { x: -96, y: -22, w: 14, d: 14, r: 1.5 }, BED, 3, "mid", { bevel: 0.3 }), screws({ x: -96, y: -22, w: 14, d: 14, r: 1.5 }, BED + 3, 2));
part("bellows.can", puckPiece("bellows.can", -89, -15, 4.2, BED + 3, 6, "mid"));
part("bellows.cap", puckPiece("bellows.cap", -89, -15, 4.6, BED + 9, 2.2, "hi"), knurl(-89, -15, 4.6, BED + 9, BED + 11.2, 22), "bellows");

const clockZ = BED;
part(
  "clock",
  puckPiece("clock", 90, 18, 7, clockZ, 3.2, "hi", { steps: 32 }),
  k.lineSvg(k.ring(90, 18, 5.4, clockZ + 3.2, P, 28), { tone: "lo" }) +
    (() => {
      const ticks = k.radialTicks(90, 18, 5.4, 12, 3, clockZ + 3.2, [0.9, 1.8], P);
      return k.lineSvg(ticks.minor, { tone: "lo" }) + k.lineSvg(ticks.major, { tone: "mid" });
    })() +
    k.lineSvg(k.ring(90, 18, 1.3, clockZ + 3.35, P, 12), { tone: "mid" }) +
    k.lineSvg(handD(90, 18, clockZ + 3.45, 0, 1.3, 4.6), { tone: "hi", free: "end" }).replace("<path ", '<path data-part="grace-hand" '),
);
part("clock.hub", puckPiece("clock.hub", 90, 18, 1.15, clockZ + 3.2, 0.8, "mid"));

function instrument(name, plan, pieces, extra = "") {
  part(name, [slabPiece(`${name}.base`, plan, BED, 4, "mid", { bevel: 0.35 }), ...pieces], screws(plan, BED + 4, Math.min(3, plan.w / 5)) + extra);
}

const lamp = { x: -128, y: INST_Y, w: 16, d: 14, r: 1.4 };
instrument(
  "lamp",
  lamp,
  [
    puckPiece("lamp.stem", -120, INST_Y + 7, 1.8, BED + 4, 14, "mid"),
    puckPiece("lamp.head", -120, INST_Y + 7, 5, BED + 18, 5, "hi", { steps: 24 }),
  ],
  `<g data-part="lamp-lens">${puckPiece("lamp.lens", -120, INST_Y + 7, 2.2, BED + 23, 1.5, "hi").svg}</g>`,
);

const dialPlan = { x: -72, y: INST_Y, w: 46, d: 16, r: 1.4 };
const cpu0 = gauge("cpu", 1);
const mem0 = gauge("mem", 1);
const DIAL_Z = BED + 19;
function dialFace(id, x, value) {
  const ticks = k.radialTicks(x, INST_Y + 8, 6.2, 20, 5, DIAL_Z, [1, 1.9], P);
  return {
    piece: puckPiece(id, x, INST_Y + 8, 6.8, BED + 14.6, 4.4, "hi", { steps: 32 }),
    extra:
      knurl(x, INST_Y + 8, 6.8, DIAL_Z - 1.5, DIAL_Z, 28) +
      k.lineSvg(k.ring(x, INST_Y + 8, 6.2, DIAL_Z, P, 28), { tone: "lo" }) +
      k.lineSvg(ticks.minor, { tone: "lo" }) +
      k.lineSvg(ticks.major, { tone: "mid" }) +
      k.lineSvg(k.ring(x, INST_Y + 8, 2.2, DIAL_Z + 0.12, P, 14), { tone: "mid" }) +
      k.lineSvg(needleD(x, INST_Y + 8, DIAL_Z + 0.2, value), { tone: "hi", free: "end" }).replace("<path ", `<path data-part="needle-${id}" `),
  };
}
const cpuFace = dialFace("cpu", -58, cpu0);
const memFace = dialFace("mem", -42, mem0);
part(
  "dials",
  [
    slabPiece("dials.base", dialPlan, BED, 4, "mid", { bevel: 0.35 }),
    puckPiece("dials.post", -58, INST_Y + 5, 1.7, BED + 4, 8.2, "mid"),
    slabPiece("dials.arm", { x: -70, y: INST_Y + 3, w: 42, d: 10, r: 1 }, BED + 12.2, 2.4, "lo", { bevel: 0.25 }),
    cpuFace.piece,
    memFace.piece,
  ],
  screws(dialPlan, BED + 4, 2.6) + cpuFace.extra + memFace.extra,
);

const news = { x: -6, y: INST_Y, w: 26, d: 16, r: 1.4 };
const newsTop = BED + 4;
part(
  "news",
  slabPiece("news.base", news, BED, 4, "mid", { bevel: 0.35 }),
  screws(news, newsTop, 2.4) +
    puckPiece("news.roll.far", 7, INST_Y + 4, 2.2, newsTop, 3, "mid").svg +
    puckPiece("news.roll.near", 7, INST_Y + 12, 2.2, newsTop, 3, "mid").svg +
    `<defs><clipPath id="news-clip"><path d="${k.planOutline({ x: -2, y: INST_Y + 3, w: 18, d: 10, r: 0.8 }, newsTop + 3.05, P)}"/></clipPath></defs>` +
    `<g data-part="news-roll" clip-path="url(#news-clip)">${[0, 1, 2, 3, 4].map((i) => k.lineSvg(k.lineOnTop([-1, INST_Y + 4.2 + i * 2.1], [15, INST_Y + 4.2 + i * 2.1], newsTop + 3.1, P), { tone: "lo", free: true })).join("")}</g>`,
);

const stamp = { x: 52, y: INST_Y, w: 28, d: 16, r: 1.4 };
part(
  "stamp",
  [
    slabPiece("stamp.base", stamp, BED, 4, "mid", { bevel: 0.35 }),
    slabPiece("stamp.col.w", { x: 56, y: INST_Y + 3, w: 3, d: 10, r: 0.6 }, BED + 4, 16, "mid", { bevel: 0.2 }),
    slabPiece("stamp.col.e", { x: 73, y: INST_Y + 3, w: 3, d: 10, r: 0.6 }, BED + 4, 16, "mid", { bevel: 0.2 }),
    slabPiece("stamp.head", { x: 55, y: INST_Y + 2.4, w: 22, d: 11.2, r: 1 }, BED + 20, 2.4, "mid", { bevel: 0.25 }),
  ],
  screws(stamp, BED + 4, 2.4),
);
part(
  "stamp.ram",
  puckPiece("stamp.ram", 66, INST_Y + 8, 2.2, BED + 22.4, 5, "hi"),
  knurl(66, INST_Y + 8, 2.2, BED + 24.6, BED + 27.4, 16),
  "stamp",
);

const tape = { x: 96, y: INST_Y, w: 40, d: 16, r: 1.4 };
const tapeTop = BED + 4;
part(
  "tape",
  [
    slabPiece("tape.base", tape, BED, 4, "mid", { bevel: 0.35 }),
    puckPiece("tape.reel.w", 104, INST_Y + 8, 3.2, tapeTop, 3, "mid"),
    puckPiece("tape.reel.e", 128, INST_Y + 8, 3.2, tapeTop, 3, "mid"),
  ],
  screws(tape, tapeTop, 2.6) +
    `<defs><clipPath id="tape-clip"><path d="${k.planOutline({ x: 108, y: INST_Y + 3.2, w: 16, d: 9.6, r: 0.8 }, tapeTop + 3.05, P)}"/></clipPath></defs>` +
    `<g data-part="tape-roll" clip-path="url(#tape-clip)">${[0, 1, 2, 3, 4, 5, 6].map((i) => k.lineSvg(k.lineOnTop([109 + i * 2.4, INST_Y + 4], [109 + i * 2.4, INST_Y + 12], tapeTop + 3.1, P), { tone: "mid", free: true })).join("")}</g>`,
);

const capsuleRest = [PIN_X.metrics, PIN_Y + 6, BED];
part(
  "capsule",
  [
    puckPiece("capsule.body", capsuleRest[0], capsuleRest[1], 2.15, BED, 3.1, "hi", { lit: true, steps: 20 }),
    puckPiece("capsule.cap", capsuleRest[0], capsuleRest[1], 1.2, BED + 3.1, 0.9, "hi", { lit: true }),
  ],
  "",
  "capsule",
);

A.settle(R, P);
const body = R.items
  .slice()
  .sort((a, b) => a.key - b.key || a.name.localeCompare(b.name))
  .map((item) => item.svg)
  .join("");
const halo = `<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H, PLATE_H, P)}"/>`;

const paths = {
  rest: capsuleRest,
  shutterRestX: shutter.x,
  shutterPollX: -72,
  cartDock: 12,
  pinLift: 6.5,
  bellowsLift: 1.7,
  stampPress: 3.2,
  dial: { cpu: [-56, INST_Y + 8, BED + 16.2], mem: [-40, INST_Y + 8, BED + 16.2] },
  clock: [90, 18, clockZ + 3.45],
  drum: [DRUM.x, DRUM.y, drumZ + drumH + 0.15],
  bed: BED,
};

function approach(x) {
  const safe = Math.abs(x) < 18 ? -28 : x;
  return [
    [x, PIN_Y + 6, BED],
    [x, -44, BED],
    [safe, -40, BED],
    [safe, -8, BED],
  ];
}
function finish(transport, dest) {
  if (transport === "poll") return [[48, -6, BED], [48, 24, BED], [dest[0], 24, BED], dest];
  return [[-52, -4, BED], [-52, 12, BED], [dest[0], 12, BED], dest];
}
const destOf = {
  metrics: [PIN_X.metrics, DEST_Y, BED],
  news: [PIN_X.news, DEST_Y, BED],
  pending: [66, DEST_Y, BED],
  reject: [128, -56, BED],
};
function buildPath(transport, route) {
  if (route === "park") return [transport === "poll" ? [48, 16, BED] : [-52, 10, BED]];
  if (route === "reject") {
    const x = PIN_X.metrics;
    return [[x, PIN_Y + 6, BED], [x, -44, BED], [128, -44, BED], destOf.reject];
  }
  const startX = route === "pending" ? 66 : PIN_X[route] ?? PIN_X.metrics;
  const head = route === "pending"
    ? [[66, DEST_Y, BED], [66, 30, BED], [66, 16, BED]]
    : approach(startX);
  const dest = destOf[route] ?? destOf.metrics;
  const forward = [...head, ...finish(transport, dest)];
  if (route !== "pending") return forward;
  return forward.concat(forward.slice(0, -1).reverse());
}

const GEO = {
  paths,
  destOf,
  initial: { cpu: cpu0, mem: mem0 },
};

const labelText =
  "一座气动分拣台。后面的销钉是订阅，中间的鼓是会话，前面的闸门同一时刻只接通方管或斗车。胶囊只走打开的那一路，并且只落进销钉按下的那台仪器。";

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  label: labelText,
  body: [halo, body],
});

const live = `
const P = ${JSON.stringify(P)};
const SPEC = ${JSON.stringify(SPEC)};
const TOUR = ${JSON.stringify(TOUR)};
const PIN_X = ${JSON.stringify(PIN_X)};
const GEO = ${JSON.stringify(GEO)};
const topicMatches = ${topicMatches.toString()};
const accepts = ${accepts.toString()};
const routeOf = ${routeOf.toString()};
const beatAt = ${beatAt.toString()};
const gauge = ${gauge.toString()};
const PATHS = ${JSON.stringify({
  ws: { metrics: buildPath("ws", "metrics"), news: buildPath("ws", "news"), pending: buildPath("ws", "pending"), reject: buildPath("ws", "reject"), park: buildPath("ws", "park") },
  poll: { metrics: buildPath("poll", "metrics"), news: buildPath("poll", "news"), pending: buildPath("poll", "pending"), reject: buildPath("poll", "reject"), park: buildPath("poll", "park") },
})};

const stage = document.querySelector(".iso-stage");
const svg = stage.querySelector("svg");
const readout = document.querySelector("[data-readout]");
const liveText = document.querySelector("[data-live]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
const q = (name) => svg.querySelector('[data-part="' + name + '"]');
const nodes = {
  shutter: q("shutter"),
  cart: q("cart"),
  capsule: q("capsule"),
  bellows: q("bellows"),
  stamp: q("stamp"),
  pins: { metrics: q("pin-metrics"), news: q("pin-news"), echo: q("pin-echo") },
  cpu: q("needle-cpu"),
  mem: q("needle-mem"),
  seq: q("seq-hand"),
  grace: q("grace-hand"),
  tape: q("tape-roll"),
  news: q("news-roll"),
  lens: q("lamp-lens"),
};
const follow = (value, target, dt, tau, calm) => calm ? target : value + (target - value) * (1 - Math.exp(-dt / tau));
const smooth = (u) => { const x = Math.max(0, Math.min(1, u)); return x * x * (3 - 2 * x); };
function pointAt(points, u) {
  if (!points.length) return GEO.paths.rest;
  if (points.length === 1) return points[0];
  const seg = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]);
    seg.push(d);
    total += d;
  }
  let dist = Math.max(0, Math.min(1, u)) * total;
  for (let i = 1; i < points.length; i++) {
    if (dist <= seg[i - 1] || i === points.length - 1) {
      const t = seg[i - 1] ? Math.max(0, Math.min(1, dist / seg[i - 1])) : 0;
      const a = points[i - 1], b = points[i];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    dist -= seg[i - 1];
  }
  return points[points.length - 1];
}
function needleAt(cx, cy, z, value) {
  const sweep = Math.PI * 0.8;
  const angle = -sweep / 2 + (Math.max(0, Math.min(100, value)) / 100) * sweep;
  return lineOnTop([cx + Math.sin(angle) * 2.3, cy - Math.cos(angle) * 2.3], [cx + Math.sin(angle) * 8.6, cy - Math.cos(angle) * 8.6], z, P);
}
function handAt(cx, cy, z, turn, r0, r1) {
  const angle = turn * Math.PI * 2 - Math.PI / 2;
  return lineOnTop([cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0], [cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1], z, P);
}
const sim = {
  clock: 0,
  touring: !still.matches,
  transport: "ws",
  shutter: 0,
  cart: 0,
  pins: { metrics: true, news: true, echo: false },
  pin: { metrics: 1, news: 1, echo: 0 },
  bellows: 0,
  stamp: 0,
  cpu: GEO.initial.cpu,
  mem: GEO.initial.mem,
  seq: 0,
  tape: 0,
  news: 0,
  beat: -1,
  latched: false,
  pollAge: 0,
  dead: false,
  send: null,
  said: "",
};
function phrase() {
  const mode = sim.shutter < 0.5 ? "ws" : "poll";
  const n = ["metrics", "news", "echo"].filter((id) => sim.pins[id]).length;
  if (sim.dead) return "轮询 · 宽限 0 s · 会话已丢";
  const link = mode === "poll" ? "轮询" : "WS";
  const grace = mode === "poll" ? " · 宽限 " + Math.max(0, (SPEC.graceMs - sim.pollAge * SPEC.heartbeatMs) / 1000).toFixed(0) + " s" : "";
  return link + " · seq " + sim.seq + " · 订阅 " + n + grace;
}
function say(force) {
  const text = phrase();
  if (readout.textContent !== text) readout.textContent = text;
  if (text !== sim.said) {
    sim.said = text;
    if (liveText) liveText.textContent = text;
    stage.setAttribute("aria-label", "基站分拣台。" + text + "。左右方向键切换传输，1 指标、2 公告、3 请求销，空格发送 echo。");
  }
}
function place(node, delta) {
  if (!node) return;
  const [x, y, z] = delta;
  if (Math.hypot(x, y, z) < 0.01) node.removeAttribute("transform");
  else node.setAttribute("transform", translateAlong(P, delta));
}
function draw() {
  const mode = sim.shutter < 0.5 ? "ws" : "poll";
  place(nodes.shutter, [(GEO.paths.shutterPollX - GEO.paths.shutterRestX) * sim.shutter, 0, 0]);
  place(nodes.cart, [0, GEO.paths.cartDock * sim.cart, 0]);
  for (const id of ["metrics", "news", "echo"]) place(nodes.pins[id], [0, 0, (1 - sim.pin[id]) * GEO.paths.pinLift]);
  place(nodes.bellows, [0, 0, sim.bellows]);
  place(nodes.stamp, [0, 0, GEO.paths.stampPress * (1 - sim.stamp)]);
  const beat = sim._beat;
  const route = sim._route;
  const points = (PATHS[mode] && PATHS[mode][route]) || PATHS.ws.park;
  const u = route === "park" ? 1 : smooth(sim._u || 0);
  const p = pointAt(points, u);
  place(nodes.capsule, [p[0] - GEO.paths.rest[0], p[1] - GEO.paths.rest[1], p[2] - GEO.paths.rest[2]]);
  if (nodes.capsule) nodes.capsule.style.opacity = sim.dead ? "0" : "1";
  if (nodes.cpu) nodes.cpu.setAttribute("d", needleAt(-58, ${INST_Y + 8}, ${DIAL_Z + 0.2}, sim.cpu));
  if (nodes.mem) nodes.mem.setAttribute("d", needleAt(-42, ${INST_Y + 8}, ${DIAL_Z + 0.2}, sim.mem));
  if (nodes.seq) nodes.seq.setAttribute("d", handAt(${DRUM.x}, ${DRUM.y}, ${drumZ + drumH + 0.15}, (sim.seq % 24) / 24, 2.2, ${DRUM.r - 3.2}));
  const remain = sim.dead ? 0 : Math.max(0, 1 - (sim.pollAge * SPEC.heartbeatMs) / SPEC.graceMs);
  const sweep = mode === "poll" ? 1 - remain : 0;
  if (nodes.grace) nodes.grace.setAttribute("d", handAt(90, 18, ${clockZ + 3.45}, sweep, 1.3, 4.6));
  if (nodes.tape) nodes.tape.setAttribute("transform", translateAlong(P, [-(sim.tape % 4) * 0.6, 0, 0]));
  if (nodes.news) nodes.news.setAttribute("transform", translateAlong(P, [0, -((sim.news % 4) * 0.45), 0]));
  if (nodes.lens) nodes.lens.style.opacity = sim.dead ? "0.28" : "1";
  say();
}
function latch(beat, route, u) {
  if (beat.index !== sim.beat) {
    sim.beat = beat.index;
    sim.latched = false;
  }
  const arrive = u > 0.8 && route !== "park" && route !== "reject" && !sim.dead;
  if (!arrive || sim.latched) return;
  sim.latched = true;
  sim.seq += 1;
  sim.tape += 1;
  if (beat.topic === "metrics.cpu") sim.cpu = gauge("cpu", sim.seq);
  if (beat.topic === "metrics.mem") sim.mem = gauge("mem", sim.seq);
  if (beat.topic === "news.notice") sim.news += 1;
}
let frame = 0, last = 0, visible = false, idleTimer = 0;
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  const calm = still.matches;
  if (sim.touring && !sim.dead) sim.clock += dt;
  let beat = sim.send ? { index: -2, beat: sim.send, u: Math.min(1, sim.send.age / sim.send.dur) } : beatAt(sim.clock);
  if (sim.send) {
    sim.send.age += dt;
    if (sim.send.age >= sim.send.dur) sim.send = null;
  }
  if (!sim.touring && !sim.send) beat = { index: -1, beat: { kind: "switch", transport: sim.transport }, u: 1 };
  const targetMode = sim.dead ? "poll" : (sim.send ? sim.send.transport : (sim.touring ? beat.beat.transport : sim.transport));
  const wantShutter = targetMode === "poll" ? 1 : 0;
  sim.shutter = follow(sim.shutter, wantShutter, dt, 0.22, calm);
  const mode = sim.shutter < 0.5 ? "ws" : "poll";
  if (mode === "poll" && !sim.dead) sim.pollAge += dt;
  if (mode === "ws") { sim.pollAge = 0; sim.dead = false; }
  if (!sim.touring && !sim.send && !sim.dead && mode === "poll" && sim.pollAge * SPEC.heartbeatMs >= SPEC.graceMs) sim.dead = true;
  const route = sim.dead ? "park" : routeOf(beat.beat, sim.pins);
  sim._beat = beat.beat;
  sim._route = route;
  sim._u = beat.u;
  if (!sim.dead) latch(beat, route, beat.u);
  const cartTarget = mode === "poll" && !sim.dead && route !== "reject" ? 1 : 0;
  sim.cart = follow(sim.cart, cartTarget, dt, 0.28, calm);
  for (const id of ["metrics", "news", "echo"]) {
    const down = sim.pins[id] ? 1 : 0;
    sim.pin[id] = follow(sim.pin[id], down, dt, 0.16, calm);
  }
  const pump = mode === "ws" && !sim.dead && !calm ? Math.max(0, Math.sin(sim.clock * Math.PI * 2)) : 0;
  sim.bellows = follow(sim.bellows, pump * GEO.paths.bellowsLift, dt, 0.12, calm);
  const pressing = !sim.dead && beat.beat.kind === "res" && beat.u > 0.58 && beat.u < 0.86;
  sim.stamp = follow(sim.stamp, pressing ? 1 : 0, dt, 0.1, calm);
  draw();
  const moving = sim.touring || sim.send || Math.abs(sim.shutter - wantShutter) > 0.004 || Math.abs(sim.cart - cartTarget) > 0.004;
  frame = visible && (moving || !calm) ? requestAnimationFrame(tick) : 0;
  if (!moving && calm) frame = 0;
}
const run = () => { if (!frame && visible) { last = 0; frame = requestAnimationFrame(tick); } };
function touch() {
  sim.touring = false;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!still.matches) { sim.touring = true; sim.clock = 0; run(); } }, 3600);
  run();
}
function setTransport(mode) {
  if (sim.dead && mode === "ws") {
    sim.dead = false;
    sim.seq = 0;
    sim.pollAge = 0;
    sim.pins.metrics = false;
    sim.pins.news = false;
    sim.pins.echo = false;
    sim.beat = -3;
  }
  sim.transport = mode;
  touch();
}
new IntersectionObserver((entries) => {
  visible = entries[entries.length - 1].isIntersecting;
  if (visible) run();
}, { rootMargin: "120px 0px" }).observe(stage);
stage.addEventListener("pointerdown", (event) => {
  const box = svg.getBoundingClientRect();
  const share = (event.clientX - box.left) / box.width;
  setTransport(share < 0.5 ? "ws" : "poll");
});
stage.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") setTransport("ws");
  else if (event.key === "ArrowRight") setTransport("poll");
  else if (event.key === "1") { sim.pins.metrics = !sim.pins.metrics; touch(); }
  else if (event.key === "2") { sim.pins.news = !sim.pins.news; touch(); }
  else if (event.key === "3") { sim.pins.echo = !sim.pins.echo; touch(); }
  else if (event.key === " " || event.key === "Enter") {
    sim.send = { age: 0, dur: 2.1, transport: sim.shutter < 0.5 ? "ws" : "poll", kind: "res", topic: "echo" };
    touch();
  } else return;
  event.preventDefault();
});
if (still.matches) {
  sim.touring = false;
  sim.seq = 1;
  sim.cpu = gauge("cpu", 1);
  sim.mem = gauge("mem", 1);
  sim._beat = TOUR[0];
  sim._route = "metrics";
  sim._u = 1;
  sim.shutter = 0;
}
draw();
run();
`;

const plate = k.plateHtml({
  fig: "图 1",
  title: "基站分拣台",
  hint: "左侧方管 · 右侧斗车 · 1 指标 2 公告 3 销 · 空格 echo",
  readout: "WS · seq 0 · 订阅 2",
  keys: [
    { mark: "lit", label: "胶囊：这一帧只走当前打开的传输" },
    { mark: "raised", label: "按下的销钉：该主题已订阅，胶囊才会离开基站" },
  ],
  caption:
    "和这个仓库的基站是同一套机制。一个页面只有一条物理连接：方管是 WebSocket，斗车是 HTTP 长轮询，换向闸先停旧的再开新的。两路共用中间那只会话鼓，鼓上是同一份订阅、容量 512 的出站队列和同一套 seq。后面三根销钉是倒排索引：metrics.* 每 1 秒送 cpu、每 2 秒送 mem（读数夹在 5–95 和 20–90），news.notice 每 5 秒一条；销钉抬起时胶囊掉进废料盘，seq 不加，纸带也不走。请求章是 pending 表，echo 的响应按 id 回到章上，不进另外两台仪器。服务端默认心跳 15 秒、心跳超时 5 秒、断线宽限 30 秒、长轮询最多挂起 25 秒、升级探测 30 秒。slow.echo 在服务端固定睡 2 秒，演示页用 1 秒超时，200 毫秒后用同一个 id 再试一次。画面按心跳加速：1 秒代表 15 秒。宽限走完仍停在轮询上，会话连同订阅一起丢掉，切回方管是一次新的连接。",
  body: `<div class="iso-stage" tabindex="0" role="group" aria-label="基站分拣台。左右方向键切换 WebSocket 与长轮询，数字键 1、2、3 切换分拣销，空格发送 echo。">${svg}</div><p class="iso-sr" data-live>WS · seq 0 · 订阅 2</p>`,
});

let html = k.pageHtml({
  title: "基站分拣台",
  theme,
  body: plate,
  script: kitScript() + live,
  width: 860,
});
html = html.replace(`lang="en"`, `lang="zh-CN"`);
html = html.replace(
  `font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif`,
  `font:14px/1.6 "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif`,
);
html = html.replace(
  `--anatomy-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace`,
  `--anatomy-mono:"Cascadia Mono","Microsoft YaHei",ui-monospace,monospace`,
);
html = html.replace(
  `</style>`,
  `.iso-stage{touch-action:pan-y;cursor:ew-resize}.iso-stage:focus-visible{outline:1px solid var(--anatomy-muted);outline-offset:6px}.iso-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.iso-plate-corner[data-corner="title"],.iso-plate-corner[data-corner="hint"]{text-transform:none;letter-spacing:.04em}@media (max-width:560px){.iso-plate-corner[data-corner="readout"]{max-width:58%;white-space:normal;text-align:right}}</style>`,
);

const file = theme === "light" ? "index.html" : "index-dark.html";
writeFileSync(join(HERE, file), html);
console.log("wrote", file, "items", R.items.length, "solids", R.solids.length);
A.auditOrExit(R, P);
