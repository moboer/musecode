import { loadState, advance, snapshot } from "./_bucket.mjs";

// SSE for the page's EventSource. Netlify streaming functions cap at 60 s,
// so each connection serves ~50 s of frames projected deterministically
// from the persisted state; EventSource reconnects on its own and the next
// connection re-reads the authoritative state (picking up rate changes).
export default async (req) => {
  const now0 = Date.now();
  const { S, save, mode } = await loadState(now0);
  const base = advance(S, now0);
  await save(base);

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const push = () => {
        const now = Date.now();
        const proj = advance(base, now);
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(snapshot(proj, now, mode))}\n\n`));
        } catch {}
      };
      push();
      const timer = setInterval(() => {
        if (Date.now() - now0 > 50000) {
          clearInterval(timer);
          try {
            controller.close();
          } catch {}
          return;
        }
        push();
      }, 200);
      req.signal?.addEventListener("abort", () => clearInterval(timer));
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
};

export const config = { path: "/api/stream" };
