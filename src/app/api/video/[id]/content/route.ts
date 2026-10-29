// Image-to-video, content half. The finished MP4 is downloaded from the gateway ONCE per
// job (one deadline, size-capped), kept in memory for the job's lifetime, and served with
// HTTP Range support — Safari/iOS <video> needs byte ranges to play and seek.

import { getVideoContent } from '@/lib/gateway'
import { parseRange } from '@/lib/range'
import { config, json, limit, limiters, upstreamError } from '@/lib/routeHelpers'
import { cacheVideo, getJob, type VideoJobRecord } from '@/lib/videoJobs'
import type { GatewayConfig, GatewayResult } from '@/lib/gateway'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

function loadVideo(cfg: GatewayConfig, job: VideoJobRecord): Promise<GatewayResult<Uint8Array<ArrayBuffer>>> {
	if (job.mp4) return Promise.resolve({ ok: true, status: 200, data: job.mp4, model: '' })
	if (!job.mp4Pending) {
		job.mp4Pending = getVideoContent(cfg, job.gatewayId)
			.then((r) => {
				if (r.ok) cacheVideo(job, r.data)
				return r
			})
			.finally(() => {
				job.mp4Pending = undefined
			})
	}
	return job.mp4Pending
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
	const limited = limit(limiters.videoPoll, req)
	if (limited) return limited
	const cfg = config()
	if (cfg instanceof Response) return cfg

	const job = getJob(params.id)
	if (!job) return json({ error: 'Unknown or expired job.' }, 404)

	const r = await loadVideo(cfg, job)
	if (!r.ok) return upstreamError(r.status, r.error, 'video-content')
	const mp4 = r.data

	const size = mp4.byteLength
	const base = {
		'Content-Type': 'video/mp4',
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'private, max-age=3600',
	}
	const range = parseRange(req.headers.get('range'), size)
	if (range === 'unsatisfiable') {
		return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
	}
	if (range) {
		const chunk = mp4.subarray(range.start, range.end + 1)
		return new Response(chunk, {
			status: 206,
			headers: { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(chunk.byteLength) },
		})
	}
	return new Response(mp4, { status: 200, headers: { ...base, 'Content-Length': String(size) } })
}
