import { loadState, advance, snapshot } from "./_bucket.mjs";

export default async () => {
  const now = Date.now();
  const { S, save, mode } = await loadState(now);
  const A = advance(S, now);
  await save(A);
  return Response.json(snapshot(A, now, mode));
};

export const config = { path: "/api/state" };
