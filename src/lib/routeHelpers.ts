// Shared pieces for the /api generation routes: rate limiters, JSON parsing with a body
// cap, and response helpers. Server-only.

import { gatewayConfigFromEnv, publicErrorFor, type GatewayConfig } from '@/lib/gateway'
import { BodyTooLargeError, clientIp, ConcurrencyLimiter, RateLimiter, readBodyCapped } from '@/lib/rateLimit'

// Budgets per client IP. Live sketching fires at most once per ~2 s debounce; t2i and
// video are explicit clicks. Video costs the most (70-120 s of GX10, or RunPod money).
export const limiters = {
	live: new RateLimiter({ capacity: 10, refillPerSec: 1 / 2 }),
	image: new RateLimiter({ capacity: 5, refillPerSec: 1 / 12 }),
	videoSubmit: new RateLimiter({ capacity: 2, refillPerSec: 1 / 120 }),
	videoPoll: new RateLimiter({ capacity: 60, refillPerSec: 1 }),
}

/** At most 2 image/live/video-submit requests IN FLIGHT per client at once. */
export const inflight = new ConcurrencyLimiter(2)

/** Takes an in-flight slot; returns its release function, or a 429 Response. */
export function acquireSlot(req: Request): (() => void) | Response {
	const release = inflight.acquire(clientIp(req.headers))
	if (release) return release
	return json({ error: 'You already have generations running — wait for one to finish.' }, 429, { 'Retry-After': '5' })
}

export const MAX_PROMPT_CHARS = 1000

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
	})
}

/** Applies a limiter; returns a 429 Response when the caller is over budget. */
export function limit(limiter: RateLimiter, req: Request): Response | null {
	const r = limiter.take(clientIp(req.headers))
	if (r.allowed) return null
	return json({ error: 'Too many requests — slow down a little.' }, 429, { 'Retry-After': String(r.retryAfterSec) })
}

/** Gateway config, or a 503 Response when the key is not configured. */
export function config(): GatewayConfig | Response {
	const cfg = gatewayConfigFromEnv()
	return cfg ?? json({ error: 'Generation is not configured on this server.' }, 503)
}

export async function readJson(req: Request, maxBytes: number): Promise<Record<string, unknown> | Response> {
	try {
		const text = await readBodyCapped(req, maxBytes)
		const parsed = JSON.parse(text)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ error: 'Expected a JSON object.' }, 400)
		return parsed as Record<string, unknown>
	} catch (e) {
		if (e instanceof BodyTooLargeError) return json({ error: e.message }, 413)
		return json({ error: 'Invalid JSON body.' }, 400)
	}
}

export function readPrompt(v: unknown): string | null {
	if (typeof v !== 'string') return null
	const p = v.trim()
	if (!p || p.length > MAX_PROMPT_CHARS) return null
	return p
}

/**
 * Maps a failed gateway call to the browser-facing response: a FIXED message per status.
 * The gateway's own error text is logged server-side only, never forwarded.
 */
export function upstreamError(status: number, detail: string, where: string): Response {
	console.warn(`[draw-fast] gateway ${where} failed: status=${status} ${detail.slice(0, 300)}`)
	const pub = publicErrorFor(status)
	return json({ error: pub.error }, pub.status)
}
