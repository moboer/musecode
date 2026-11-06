# Token bucket — live server version

The Anatomy token bucket figure (see `../token-bucket/`) rebuilt so the
**server is the only source of truth** and the page only renders.

## Run it

```sh
cd ~/workspace/anatomy-examples/token-bucket-live
node build.mjs && node build.mjs --light   # only if the pages need rebuilding
node server.mjs
```

Then open http://localhost:8371 (dark) or http://localhost:8371/light (light).

## How it works

- `server.mjs` — zero-dependency Node (`node:http` only). It runs a real
  token bucket: capacity 12, `tokens` refill at `refillRate`/s easing
  toward `rateTarget`, one request arrives every ~1.4 s (±0.3 s jitter)
  and is judged on reaching the gate after a 0.95 s ride: `tokens >= 1`
  spends a token and passes, otherwise it is dropped.
- The page connects with `EventSource` to `/api/stream` and renders each
  snapshot: token discs follow `floor(tokens)`, request cubes ride at the
  server-reported `progress` and play their pass/drop animation when the
  server's `decision` arrives, the dial and readout show the
  server-reported `refillRate`. Readout ends in `· live`, or `· offline`
  (picture frozen on the last snapshot) while the stream is down;
  EventSource reconnects automatically.
- The rate control writes back: pointer moves / arrow keys POST the new
  target rate (throttled to one POST per 150 ms).

## API

| Endpoint | What |
|---|---|
| `GET /` | dark figure page |
| `GET /light` | light figure page |
| `GET /api/state` | JSON snapshot `{tokens, capacity, refillRate, rateTarget, passed, dropped, inflight:[{id, progress, decision}]}` |
| `GET /api/stream` | SSE, one snapshot frame every 100 ms |
| `POST /api/rate` | body `{"rate": number}`, clamps `rateTarget` to 0.5–3.0, returns the new snapshot |

Rebuild the pages after editing `build.mjs` (geometry is shared with
`../token-bucket/`; only the live script, caption and readout differ).
