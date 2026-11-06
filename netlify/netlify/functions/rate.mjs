import { loadState, advance, snapshot } from "./_bucket.mjs";

export default async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  let rate;
  try {
    ({ rate } = await req.json());
    if (typeof rate !== "number" || !Number.isFinite(rate)) throw new Error("rate must be a number");
  } catch (err) {
    return Response.json({ error: String(err.message ?? err) }, { status: 400 });
  }
  const now = Date.now();
  const { S, save, mode } = await loadState(now);
  const A = advance(S, now);
  A.rateTarget = Math.min(3.0, Math.max(0.5, rate));
  await save(A);
  return Response.json(snapshot(A, now, mode));
};

export const config = { path: "/api/rate" };
