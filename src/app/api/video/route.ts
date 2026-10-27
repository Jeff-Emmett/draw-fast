// Image-to-video, submit half. Submits to local-video-ltxv (burst to rented on a >= 500
// submit) and hands the browser OUR job id, which it polls at /api/video/<id>.

import { decodeImageDataUrl, MODELS, submitVideoWithBurst, type VideoSubmit } from '@/lib/gateway'
import { config, json, limit, limiters, readJson, readPrompt, upstreamError } from '@/lib/routeHelpers'
import { putJob } from '@/lib/videoJobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 180

const MAX_BODY = 8 * 1024 * 1024 // source image as a data URL
const SIZES = new Set(['768x512', '512x768', '512x512'])

export async function POST(req: Request) {
	const limited = limit(limiters.videoSubmit, req)
	if (limited) return limited
	const cfg = config()
	if (cfg instanceof Response) return cfg

	const body = await readJson(req, MAX_BODY)
	if (body instanceof Response) return body

	const prompt = readPrompt(body.prompt)
	const image = decodeImageDataUrl(body.image)
	if (!prompt || !image) return json({ error: 'Need a prompt and a PNG/JPEG source image.' }, 400)
	const size = typeof body.size === 'string' && SIZES.has(body.size) ? body.size : '768x512'

	const input: VideoSubmit = { prompt, seconds: '4', size, image }
	const r = await submitVideoWithBurst(cfg, input)
	if (!r.ok) return upstreamError(r.status, r.error)

	const id = putJob({
		gatewayId: r.data.id,
		model: r.model,
		// Only a LOCAL job can still burst; a rented one never needs the inputs again.
		input: r.model === MODELS.localVideo ? input : null,
		burstUsed: r.model !== MODELS.localVideo,
	})
	return json({ id, status: r.data.status }, 202)
}
