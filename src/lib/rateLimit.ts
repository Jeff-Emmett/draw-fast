// Per-client-IP token buckets for the generation routes. draw.jeffemmett.com is public and
// unauthenticated, and every call costs GX10 time or RunPod money (rspace TASK-1727).
// In-memory: the app runs as ONE container; a restart forgives everyone, which is fine.
//
// Self-contained (no relative imports) so node:test can load it with --experimental-strip-types.

export interface BucketOptions {
	/** Max burst of requests. */
	capacity: number
	/** Tokens added per second. */
	refillPerSec: number
	/** Max distinct clients tracked; the stalest are evicted beyond this. */
	maxKeys?: number
	now?: () => number
}

export interface LimitResult {
	allowed: boolean
	/** Seconds until one token is available (0 when allowed). */
	retryAfterSec: number
}

export class RateLimiter {
	private buckets = new Map<string, { tokens: number; at: number }>()
	private readonly capacity: number
	private readonly refillPerSec: number
	private readonly maxKeys: number
	private readonly now: () => number

	constructor(opts: BucketOptions) {
		this.capacity = opts.capacity
		this.refillPerSec = opts.refillPerSec
		this.maxKeys = opts.maxKeys ?? 10_000
		this.now = opts.now ?? Date.now
	}

	take(key: string, cost = 1): LimitResult {
		const t = this.now()
		const prev = this.buckets.get(key)
		let tokens = this.capacity
		if (prev) {
			tokens = Math.min(this.capacity, prev.tokens + ((t - prev.at) / 1000) * this.refillPerSec)
			this.buckets.delete(key) // re-insert below: Map order = recency, oldest first
		}
		let allowed = false
		if (tokens >= cost) {
			tokens -= cost
			allowed = true
		}
		this.buckets.set(key, { tokens, at: t })
		if (this.buckets.size > this.maxKeys) {
			const oldest = this.buckets.keys().next().value
			if (oldest !== undefined) this.buckets.delete(oldest)
		}
		const retryAfterSec = allowed ? 0 : Math.ceil((cost - tokens) / this.refillPerSec)
		return { allowed, retryAfterSec }
	}

	get size() {
		return this.buckets.size
	}
}

export const SHARED_BUCKET = 'shared'

/**
 * Rate-limit key. The app is reached ONLY via the Cloudflare tunnel → Traefik, and
 * Cloudflare sets cf-connecting-ip (overwriting any client-supplied value). That is the
 * only header trusted: x-forwarded-for / x-real-ip are client-spoofable, so trusting them
 * would let one client mint unlimited buckets. Absent → one shared bucket for everyone.
 */
export function clientIp(headers: Headers): string {
	const cf = headers.get('cf-connecting-ip')?.trim()
	return cf || SHARED_BUCKET
}

export class BodyTooLargeError extends Error {
	readonly limit: number
	constructor(limit: number) {
		super(`request body exceeds ${limit} bytes`)
		this.limit = limit
	}
}

/** Reads a request body, refusing (without buffering the rest) once it passes maxBytes. */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string> {
	const declared = Number(req.headers.get('content-length') || '')
	if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError(maxBytes)
	if (!req.body) return ''
	const reader = req.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) break
		total += value.byteLength
		if (total > maxBytes) {
			await reader.cancel().catch(() => {})
			throw new BodyTooLargeError(maxBytes)
		}
		chunks.push(value)
	}
	const all = new Uint8Array(total)
	let off = 0
	for (const c of chunks) {
		all.set(c, off)
		off += c.byteLength
	}
	return new TextDecoder().decode(all)
}
