// Image-to-video, content half: streams the finished MP4 from the gateway to the <video>.

import { getVideoContent } from '@/lib/gateway'
import { config, json, limit, limiters, upstreamError } from '@/lib/routeHelpers'
import { getJob } from '@/lib/videoJobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: Request, { params }: { params: { id: string } }) {
	const limited = limit(limiters.videoPoll, req)
	if (limited) return limited
	const cfg = config()
	if (cfg instanceof Response) return cfg

	const job = getJob(params.id)
	if (!job) return json({ error: 'Unknown or expired job.' }, 404)

	let res: Response
	try {
		res = await getVideoContent(cfg, job.gatewayId)
	} catch {
		return upstreamError(0, '')
	}
	if (!res.ok || !res.body) return upstreamError(res.status || 502, `HTTP ${res.status}`)

	const headers: Record<string, string> = {
		'Content-Type': 'video/mp4',
		'Cache-Control': 'private, max-age=3600',
	}
	const len = res.headers.get('content-length')
	if (len) headers['Content-Length'] = len
	return new Response(res.body, { status: 200, headers })
}
