# Draw Fast

**Draw Fast** is a [tldraw](https://tldraw.dev) canvas with live sketch-to-image generation, forked from
tldraw's demo. Deployed at draw.jeffemmett.com.

All generation runs on **our own compute** through our LiteLLM media gateway (rspace TASK-1727): GX10 first,
our RunPod ComfyUI worker as the burst lane. No third-party model API is called, and the browser never holds a
credential — it only calls this app's own `/api/*` routes.

| Feature | Route | Gateway model(s) |
|---|---|---|
| Live sketch → image (debounced img2img, latest wins) | `POST /api/live` | `local-image-flux` only (never burst) |
| Text → image | `POST /api/image` | `local-image-flux`, burst → `rented-image-flux` |
| Image → video | `POST /api/video`, `GET /api/video/:id`, `GET /api/video/:id/content` | `local-video-ltxv`, burst → `rented-video-ltxv` |

Burst rule: the local model is called first; on HTTP >= 500 or a network failure the rented twin is called
once. A 4xx is never retried. Every generation route is rate-limited per client IP and has a body-size cap.

## Configuration (server-side env)

- `LITELLM_MEDIA_KEY` — the app's virtual key on the gateway (secret; in production injected from Infisical
  project `draw-fast`).
- `LITELLM_BASE_URL` — default `https://llm.jeffemmett.com/v1`.

Without a key the generation routes answer 503 and the canvas still works.

## Run it locally

```
npm install
LITELLM_MEDIA_KEY=<your key> npm run dev
```

Open `localhost:3000`, draw in the frame, double-click the frame heading to change the prompt.

## Tests

```
npm test          # node:test, burst helper + rate limiter with a mocked fetch
npm run typecheck
npm run build
```
