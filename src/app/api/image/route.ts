// Text-to-image: local-image-flux on GX10, bursting once to rented-image-flux (our RunPod
// worker) when GX10 answers >= 500 or cannot be reached.

import { generateImageWithBurst } from '@/lib/gateway'
import { acquireSlot, config, json, limit, limiters, readJson, readPrompt, upstreamError } from '@/lib/routeHelpers'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 180

const MAX_BODY = 16 * 1024
const SIZES = new Set(['1024x1024', '768x768', '512x512', '1024x768', '768x1024'])

export async function POST(req: Request) {
	const limited = limit(limiters.image, req)
	if (limited) return limited
	const cfg = config()
	if (cfg instanceof Response) return cfg

	const body = await readJson(req, MAX_BODY)
	if (body instanceof Response) return body

	const prompt = readPrompt(body.prompt)
	if (!prompt) return json({ error: 'Need a prompt (1-1000 characters).' }, 400)
	const size = typeof body.size === 'string' && SIZES.has(body.size) ? body.size : '1024x1024'

	const release = acquireSlot(req)
	if (release instanceof Response) return release
	try {
		const r = await generateImageWithBurst(cfg, { prompt, size }, { signal: req.signal })
		if (!r.ok) return upstreamError(r.status, r.error, 'image')
		return json({ image: `data:image/png;base64,${r.data.b64}`, model: r.model })
	} finally {
		release()
	}
}
