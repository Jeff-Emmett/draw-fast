// In-memory registry of image-to-video jobs. The browser only ever sees OUR job id; the
// gateway id (which encodes routing) stays server-side and is kept exactly as returned.
// We keep the submit inputs until the job settles so a local capacity failure can be
// re-submitted once to the rented lane (the contract's video burst rule).

import type { VideoSubmit } from '@/lib/gateway'

export interface VideoJobRecord {
	gatewayId: string
	model: string
	/** Inputs for the one allowed rented re-submit; dropped once no longer needed. */
	input: VideoSubmit | null
	burstUsed: boolean
	createdAt: number
}

const TTL_MS = 60 * 60 * 1000
const MAX_JOBS = 100

const jobs = new Map<string, VideoJobRecord>()

function sweep(now: number) {
	for (const [id, job] of jobs) {
		if (now - job.createdAt > TTL_MS) jobs.delete(id)
	}
	while (jobs.size > MAX_JOBS) {
		const oldest = jobs.keys().next().value
		if (oldest === undefined) break
		jobs.delete(oldest)
	}
}

export function putJob(rec: Omit<VideoJobRecord, 'createdAt'>): string {
	const now = Date.now()
	sweep(now)
	const id = crypto.randomUUID()
	jobs.set(id, { ...rec, createdAt: now })
	return id
}

export function getJob(id: string): VideoJobRecord | undefined {
	const job = jobs.get(id)
	if (job && Date.now() - job.createdAt > TTL_MS) {
		jobs.delete(id)
		return undefined
	}
	return job
}
