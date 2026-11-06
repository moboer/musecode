# token-bucket-live

Interactive 2.5D token-bucket rate limiter (built with the Anatomy skill), driven by a **real backend** — the figure only renders server state, and dragging the rate control in the figure writes back to the server.

Two runnable variants of the same demo:

## `local/` — zero-dependency Node server

A single `server.mjs` (node:http only) runs the actual token bucket: capacity 12, refill rate easing toward the target, one request every ~1.4 s, judged at the gate after 0.95 s of travel.

```bash
cd local
node server.mjs        # http://localhost:8371  (dark) · /light (light)
```

Endpoints: `GET /api/state` · `GET /api/stream` (SSE, 100 ms frames) · `POST /api/rate` `{ "rate": 0.5–3.0 }`

## `netlify/` — Netlify Functions + Blobs

The same rules re-expressed as a pure, deterministic state advance (seeded RNG in the state), so any function instance computes the same current state from the persisted base in Netlify Blobs. Same API paths; the page is unchanged.

- `netlify/functions/state.mjs` → `GET /api/state`
- `netlify/functions/stream.mjs` → `GET /api/stream` (SSE in ~50 s chunks; EventSource reconnects)
- `netlify/functions/rate.mjs` → `POST /api/rate`

Deploy by connecting this repo to Netlify (publish directory `netlify/`, or drag the folder while signed in — anonymous Drop does **not** deploy functions).

State is in-memory on the Node version (restart resets the counters); on Netlify it persists in Blobs.
