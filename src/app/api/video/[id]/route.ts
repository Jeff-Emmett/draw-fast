// Image-to-video, poll half. The browser polls this every few seconds; we poll the
// gateway. A local job that fails with capacity_error is re-submitted ONCE to rented.

import { getVideo, MODELS, shouldBurstFailedJob, submitVideo } from '@/lib/gateway'
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

	const r = await getVideo(cfg, job.gatewayId)
	if (!r.ok) return upstreamError(r.status, r.error)
	const status = r.data

	if (status.status === 'failed' && shouldBurstFailedJob(job.model, status) && !job.burstUsed && job.input) {
		job.burstUsed = true
		const resubmit = await submitVideo(cfg, MODELS.rentedVideo, job.input)
		job.input = null
		if (resubmit.ok) {
			job.gatewayId = resubmit.data.id
			job.model = resubmit.model
			return json({ status: resubmit.data.status, progress: 0, lane: 'rented' })
		}
		return json({ status: 'failed', error: { code: 'burst_failed', message: resubmit.error } })
	}

	if (status.status === 'completed' || status.status === 'failed') job.input = null

	return json({
		status: status.status,
		progress: typeof status.progress === 'number' ? status.progress : undefined,
		error: status.error ? { code: status.error.code, message: status.error.message } : undefined,
		lane: job.model === MODELS.rentedVideo ? 'rented' : 'local',
	})
}
