// Live "draw → image": debounced reference edit of the current sketch (rspace TASK-1727.10).
// FLUX.2 klein 4B takes the sketch as a reference and the prompt as the instruction, on the
// rented-image-live endpoint that RunPod keeps warm for 2 minutes after the last frame — GX10
// measured 6-20 s a frame, not live. On a 5xx / no answer it falls back ONCE to the same model
// on GX10; a 4xx is surfaced. There is no strength: a reference edit has no denoise knob.

import { generateImageWithBurst, LIVE_FALLBACK_TIMEOUT_MS, LIVE_TIMEOUT_MS, MODELS } from '@/lib/gateway'
import { acquireSlot, config, json, limit, limiters, readJson, readPrompt, upstreamError } from '@/lib/routeHelpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_BODY = 2 * 1024 * 1024 // a 512px sketch PNG as a data URL is well under this
const SIZE_RE = /^(\d{2,3})x(\d{2,3})$/

function validSize(v: unknown): string | null {
	if (typeof v !== 'string') return null
	const m = SIZE_RE.exec(v)
	if (!m) return null
	const w = Number(m[1])
	const h = Number(m[2])
	const ok = (n: number) => n >= 128 && n <= 768 && n % 16 === 0
	return ok(w) && ok(h) ? v : null
}

export async function POST(req: Request) {
	const limited = limit(limiters.live, req)
	if (limited) return limited
	const cfg = config()
	if (cfg instanceof Response) return cfg

	const body = await readJson(req, MAX_BODY)
	if (body instanceof Response) return body

	const prompt = readPrompt(body.prompt)
	const size = validSize(body.size)
	const image = typeof body.image === 'string' && /^data:image\/(png|jpeg);base64,/.test(body.image) ? body.image : null
	if (!prompt || !size || !image) return json({ error: 'Need prompt, size (WxH, 128-768, /16) and image (PNG/JPEG data URL).' }, 400)

	const release = acquireSlot(req)
	if (release instanceof Response) return release
	try {
		const r = await generateImageWithBurst(
			cfg,
			{ prompt, size, image, seed: 42 },
			{
				local: MODELS.liveImage,
				rented: MODELS.liveFallback,
				localTimeoutMs: LIVE_TIMEOUT_MS,
				rentedTimeoutMs: LIVE_FALLBACK_TIMEOUT_MS,
				signal: req.signal,
			}
		)
		if (!r.ok) return upstreamError(r.status, r.error, 'live')
		return json({ image: `data:image/png;base64,${r.data.b64}` })
	} finally {
		release()
	}
}
