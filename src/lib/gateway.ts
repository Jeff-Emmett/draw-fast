// Server-only client for our LiteLLM media gateway (rspace TASK-1727).
//
// The gateway key (LITELLM_MEDIA_KEY) lives ONLY here, on the server. Browser code calls
// this app's own /api/* routes; it never sees the key and never reaches the gateway.
//
// Self-contained on purpose (no relative imports) so the node:test suite can load it
// with --experimental-strip-types.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const DEFAULT_BASE_URL = 'https://llm.jeffemmett.com/v1'

export const MODELS = {
	localImage: 'local-image-flux',
	rentedImage: 'rented-image-flux',
	localVideo: 'local-video-ltxv',
	rentedVideo: 'rented-video-ltxv',
} as const

// ── Time budgets ───────────────────────────────────────────────────────────────
// Every browser request goes through Cloudflare, which answers 524 after ~100 s. So the
// WORST CASE of each route (all its sequential gateway calls) must stay under 90 s.
// GX10 refuses in ~20 s when it has no room, so 35 s is enough for a refusal; a slow but
// working local job is abandoned in favour of the rented lane — accepted trade-off.
export const BROWSER_REQUEST_BUDGET_MS = 90_000
/** /api/image: local, then (on >= 500 / network / timeout) rented once. */
export const LOCAL_TIMEOUT_MS = 35_000
export const RENTED_TIMEOUT_MS = 50_000
/** /api/live: local only, short — the sketch will have moved on anyway. */
export const LIVE_TIMEOUT_MS = 40_000
/** Video submit answers at once with a job id; a burst is two submits. */
export const VIDEO_SUBMIT_TIMEOUT_MS = 30_000
/** One status poll; a capacity_error burst adds one rented submit to the same request. */
export const VIDEO_POLL_TIMEOUT_MS = 25_000
/** Time to the first byte of the MP4 (the body then streams). */
export const VIDEO_CONTENT_TIMEOUT_MS = 60_000

export interface GatewayConfig {
	baseUrl: string
	apiKey: string
	fetch: FetchLike
}

/** Reads config from env. Returns null when the key is not set (routes answer 503). */
export function gatewayConfigFromEnv(env: Record<string, string | undefined> = process.env): GatewayConfig | null {
	const apiKey = env.LITELLM_MEDIA_KEY
	if (!apiKey) return null
	const baseUrl = (env.LITELLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
	return { baseUrl, apiKey, fetch: (input, init) => fetch(input, { cache: 'no-store', ...init }) }
}

export type GatewayResult<T> =
	| { ok: true; status: number; data: T; model: string }
	| {
			ok: false
			status: number
			error: string
			model: string
			/** True only for what the burst rule names: HTTP >= 500, or no HTTP answer (status 0). */
			burstable?: boolean
	  }

/** Turns an upstream failure into a status the BROWSER should see. */
export function clientStatusFor(upstream: number): number {
	// 401/403 from the gateway mean OUR key is wrong or not allowed that model — a server
	// misconfiguration, not the caller's fault.
	if (upstream === 401 || upstream === 403) return 502
	return upstream
}

async function errorMessage(res: Response): Promise<string> {
	try {
		const text = await res.text()
		try {
			const j = JSON.parse(text)
			const m = j?.error?.message ?? j?.error ?? j?.detail ?? j?.message
			if (typeof m === 'string') return m.slice(0, 300)
		} catch {
			// not JSON
		}
		return text.slice(0, 300) || `HTTP ${res.status}`
	} catch {
		return `HTTP ${res.status}`
	}
}

async function httpFailure(res: Response, model: string) {
	return { ok: false as const, status: res.status, error: await errorMessage(res), model, burstable: res.status >= 500 }
}

async function fetchWithTimeout(
	cfg: GatewayConfig,
	path: string,
	init: RequestInit,
	timeoutMs: number,
	outerSignal?: AbortSignal
): Promise<Response> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
	const onOuterAbort = () => ctrl.abort(outerSignal?.reason)
	outerSignal?.addEventListener('abort', onOuterAbort)
	try {
		return await cfg.fetch(cfg.baseUrl + path, {
			...init,
			headers: { Authorization: `Bearer ${cfg.apiKey}`, ...(init.headers || {}) },
			signal: ctrl.signal,
		})
	} finally {
		clearTimeout(timer)
		outerSignal?.removeEventListener('abort', onOuterAbort)
	}
}

// ── Images ──────────────────────────────────────────────────────────────────────

export interface ImageRequestBody {
	prompt: string
	size: string
	n?: 1
	seed?: number
	steps?: number
	/** base64 PNG/JPEG (raw or data: URL) → img2img */
	image?: string
	strength?: number
}

/**
 * The contract's burst rule, exactly: call `local` first; on status >= 500 or a network
 * level failure (incl. timeout) call `rented` ONCE with the same body. A 4xx is the
 * request's own fault: surfaced, never retried. `rented: null` disables burst (live mode).
 */
export async function generateImageWithBurst(
	cfg: GatewayConfig,
	body: ImageRequestBody,
	opts: {
		local?: string
		rented?: string | null
		localTimeoutMs?: number
		rentedTimeoutMs?: number
		signal?: AbortSignal
	} = {}
): Promise<GatewayResult<{ b64: string }>> {
	const local = opts.local ?? MODELS.localImage
	const rented = opts.rented === undefined ? MODELS.rentedImage : opts.rented

	// A 200 with a malformed body is reported as 502 but is NOT burstable: only a real
	// HTTP >= 500 or a network-level failure is a reason to rent a GPU.
	const attempt = async (model: string, timeoutMs: number): Promise<GatewayResult<{ b64: string }>> => {
		let res: Response
		try {
			res = await fetchWithTimeout(
				cfg,
				'/images/generations',
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ n: 1, ...body, model }),
				},
				timeoutMs,
				opts.signal
			)
		} catch (e) {
			// Network-level failure or our own timeout. Status 0 marks "no HTTP answer".
			return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error', model, burstable: true }
		}
		if (!res.ok) return httpFailure(res, model)
		let json: any
		try {
			json = await res.json()
		} catch {
			return { ok: false, status: 502, error: 'gateway returned non-JSON', model }
		}
		const b64 = json?.data?.[0]?.b64_json
		if (typeof b64 !== 'string' || !b64) return { ok: false, status: 502, error: 'gateway returned no image', model }
		return { ok: true, status: res.status, data: { b64 }, model }
	}

	const first = await attempt(local, opts.localTimeoutMs ?? LOCAL_TIMEOUT_MS)
	if (first.ok) return first
	if (!first.burstable || !rented || opts.signal?.aborted) return first
	return attempt(rented, opts.rentedTimeoutMs ?? RENTED_TIMEOUT_MS)
}

// ── Video (OpenAI Videos API, async) ───────────────────────────────────────────

export interface VideoSubmit {
	prompt: string
	seconds: string
	size: string
	image: { bytes: Uint8Array; mime: string }
}

export interface VideoJob {
	id: string
	status: 'queued' | 'in_progress' | 'completed' | 'failed' | string
	progress?: number
	error?: { code?: string; message?: string }
}

export async function submitVideo(
	cfg: GatewayConfig,
	model: string,
	req: VideoSubmit,
	timeoutMs = VIDEO_SUBMIT_TIMEOUT_MS
): Promise<GatewayResult<VideoJob>> {
	const form = new FormData()
	form.set('model', model)
	form.set('prompt', req.prompt)
	form.set('seconds', req.seconds)
	form.set('size', req.size)
	const ext = req.image.mime === 'image/jpeg' ? 'jpg' : 'png'
	form.set('input_reference', new Blob([new Uint8Array(req.image.bytes)], { type: req.image.mime }), `input.${ext}`)
	let res: Response
	try {
		res = await fetchWithTimeout(cfg, '/videos', { method: 'POST', body: form }, timeoutMs)
	} catch (e) {
		return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error', model, burstable: true }
	}
	if (!res.ok) return httpFailure(res, model)
	const job = (await res.json().catch(() => null)) as VideoJob | null
	if (!job || typeof job.id !== 'string') return { ok: false, status: 502, error: 'gateway returned no job id', model }
	return { ok: true, status: res.status, data: job, model }
}

/** Video burst rule, submit half: local first; a submit >= 500 or network failure → rented once. */
export async function submitVideoWithBurst(cfg: GatewayConfig, req: VideoSubmit): Promise<GatewayResult<VideoJob>> {
	const first = await submitVideo(cfg, MODELS.localVideo, req)
	if (first.ok) return first
	if (first.burstable) return submitVideo(cfg, MODELS.rentedVideo, req)
	return first
}

/** Video burst rule, job half: a LOCAL job that failed for capacity should go to rented. */
export function shouldBurstFailedJob(model: string, job: VideoJob): boolean {
	return model === MODELS.localVideo && job.status === 'failed' && job.error?.code === 'capacity_error'
}

export async function getVideo(cfg: GatewayConfig, id: string): Promise<GatewayResult<VideoJob>> {
	let res: Response
	try {
		res = await fetchWithTimeout(cfg, `/videos/${encodeURIComponent(id)}`, { method: 'GET' }, VIDEO_POLL_TIMEOUT_MS)
	} catch (e) {
		return { ok: false, status: 0, error: e instanceof Error ? e.message : 'network error', model: '' }
	}
	if (!res.ok) return { ok: false, status: res.status, error: await errorMessage(res), model: '' }
	const job = (await res.json().catch(() => null)) as VideoJob | null
	if (!job || typeof job.status !== 'string') return { ok: false, status: 502, error: 'bad job status', model: '' }
	return { ok: true, status: res.status, data: job, model: '' }
}

export async function getVideoContent(cfg: GatewayConfig, id: string): Promise<Response> {
	return fetchWithTimeout(cfg, `/videos/${encodeURIComponent(id)}/content`, { method: 'GET' }, VIDEO_CONTENT_TIMEOUT_MS)
}

// ── Input helpers ──────────────────────────────────────────────────────────────

/** Decodes a `data:image/png|jpeg;base64,...` URL. Returns null for anything else. */
export function decodeImageDataUrl(dataUrl: unknown): { bytes: Uint8Array; mime: string } | null {
	if (typeof dataUrl !== 'string') return null
	const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
	if (!m) return null
	const bytes = Uint8Array.from(Buffer.from(m[2], 'base64'))
	if (bytes.length === 0) return null
	return { bytes, mime: m[1] }
}
