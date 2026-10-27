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
/** Whole MP4 download (buffered once, then served from memory with Range support). */
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

/**
 * Fixed, browser-safe message for an upstream failure (status 0 = no answer). Gateway
 * error text never reaches the browser — it is logged server-side instead.
 */
export function publicErrorFor(upstream: number): { status: number; error: string } {
	if (upstream === 0) return { status: 502, error: 'The image service could not be reached. Try again shortly.' }
	if (upstream === 401 || upstream === 403) return { status: 502, error: 'The image service is misconfigured.' }
	if (upstream === 413) return { status: 413, error: 'Input too large.' }
	if (upstream === 429 || upstream === 503) return { status: upstream, error: 'GPU busy — try again shortly.' }
	if (upstream === 504) return { status: 504, error: 'Generation timed out. Try again.' }
	if (upstream >= 400 && upstream < 500) return { status: 400, error: 'The generator could not use this prompt or image.' }
	return { status: 502, error: 'Generation failed. Try again.' }
}

/** Fixed, browser-safe message for a video job that ended `failed`. */
export function publicVideoFailure(code: string | undefined): string {
	return code === 'capacity_error' ? 'No GPU capacity right now — try again later.' : 'Video generation failed.'
}

/** Upstream error detail, for SERVER logs only (never sent to the browser). */
function detailOf(status: number, bytes: Uint8Array): string {
	const text = new TextDecoder().decode(bytes.subarray(0, 2000))
	try {
		const j = JSON.parse(text)
		const m = j?.error?.message ?? j?.error ?? j?.detail ?? j?.message
		if (typeof m === 'string') return m.slice(0, 300)
	} catch {
		// not JSON
	}
	return text.slice(0, 300) || `HTTP ${status}`
}

export class BodyCapError extends Error {}

type Raw =
	| { kind: 'http'; status: number; ok: boolean; body: Uint8Array<ArrayBuffer>; contentType: string }
	| { kind: 'net'; error: string }

/**
 * One gateway call with ONE deadline covering connect, headers AND the whole body: a
 * gateway that stalls mid-body is cut off at the same time limit as one that never answers.
 * `maxBytes` bounds what we buffer.
 */
export async function gatewayCall(
	cfg: GatewayConfig,
	path: string,
	init: RequestInit,
	timeoutMs: number,
	opts: { signal?: AbortSignal; maxBytes?: number } = {}
): Promise<Raw> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs)
	const outer = opts.signal
	const onOuterAbort = () => ctrl.abort(outer?.reason)
	if (outer?.aborted) ctrl.abort(outer.reason)
	outer?.addEventListener('abort', onOuterAbort)
	const maxBytes = opts.maxBytes ?? 32 * 1024 * 1024
	try {
		const res = await cfg.fetch(cfg.baseUrl + path, {
			...init,
			headers: { Authorization: `Bearer ${cfg.apiKey}`, ...(init.headers || {}) },
			signal: ctrl.signal,
		})
		const declared = Number(res.headers.get('content-length') || '')
		if (Number.isFinite(declared) && declared > maxBytes) throw new BodyCapError(`body over ${maxBytes} bytes`)
		const chunks: Uint8Array[] = []
		let total = 0
		if (res.body) {
			const reader = res.body.getReader()
			const onAbort = () => reader.cancel(ctrl.signal.reason).catch(() => {})
			ctrl.signal.addEventListener('abort', onAbort)
			try {
				for (;;) {
					if (ctrl.signal.aborted) throw ctrl.signal.reason ?? new Error('aborted')
					const { done, value } = await reader.read()
					if (done) break
					total += value.byteLength
					if (total > maxBytes) throw new BodyCapError(`body over ${maxBytes} bytes`)
					chunks.push(value)
				}
				if (ctrl.signal.aborted) throw ctrl.signal.reason ?? new Error('aborted')
			} finally {
				ctrl.signal.removeEventListener('abort', onAbort)
				if (total > maxBytes || ctrl.signal.aborted) reader.cancel().catch(() => {})
			}
		}
		const body = new Uint8Array(total)
		let off = 0
		for (const c of chunks) {
			body.set(c, off)
			off += c.byteLength
		}
		return { kind: 'http', status: res.status, ok: res.ok, body, contentType: res.headers.get('content-type') || '' }
	} catch (e) {
		// Network failure, our deadline, an outer abort, or an oversize body: no usable answer.
		return { kind: 'net', error: e instanceof Error ? e.message : 'network error' }
	} finally {
		clearTimeout(timer)
		outer?.removeEventListener('abort', onOuterAbort)
	}
}

/** Raw → failure result. Burstable only for what the contract names: no answer, or HTTP >= 500. */
function failureOf(raw: Raw, model: string) {
	if (raw.kind === 'net') return { ok: false as const, status: 0, error: raw.error, model, burstable: true }
	return { ok: false as const, status: raw.status, error: detailOf(raw.status, raw.body), model, burstable: raw.status >= 500 }
}

function parseJson(raw: Raw & { kind: 'http' }): any {
	try {
		return JSON.parse(new TextDecoder().decode(raw.body))
	} catch {
		return null
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
		const raw = await gatewayCall(
			cfg,
			'/images/generations',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ n: 1, ...body, model }),
			},
			timeoutMs,
			{ signal: opts.signal }
		)
		if (raw.kind === 'net' || !raw.ok) return failureOf(raw, model)
		const b64 = parseJson(raw)?.data?.[0]?.b64_json
		if (typeof b64 !== 'string' || !b64) return { ok: false, status: 502, error: 'gateway returned no image', model }
		return { ok: true, status: raw.status, data: { b64 }, model }
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
	const raw = await gatewayCall(cfg, '/videos', { method: 'POST', body: form }, timeoutMs, { maxBytes: 1024 * 1024 })
	if (raw.kind === 'net' || !raw.ok) return failureOf(raw, model)
	const job = parseJson(raw) as VideoJob | null
	if (!job || typeof job.id !== 'string') return { ok: false, status: 502, error: 'gateway returned no job id', model }
	return { ok: true, status: raw.status, data: job, model }
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
	const raw = await gatewayCall(cfg, `/videos/${encodeURIComponent(id)}`, { method: 'GET' }, VIDEO_POLL_TIMEOUT_MS, {
		maxBytes: 1024 * 1024,
	})
	if (raw.kind === 'net' || !raw.ok) return failureOf(raw, '')
	const job = parseJson(raw) as VideoJob | null
	if (!job || typeof job.status !== 'string') return { ok: false, status: 502, error: 'bad job status', model: '' }
	return { ok: true, status: raw.status, data: job, model: '' }
}

/** Largest MP4 we will buffer (an 8 s LTXV clip is a few MB). */
export const MAX_VIDEO_BYTES = 40 * 1024 * 1024

/** Downloads the finished MP4 in full, under one deadline and a size cap. */
export async function getVideoContent(cfg: GatewayConfig, id: string): Promise<GatewayResult<Uint8Array<ArrayBuffer>>> {
	const raw = await gatewayCall(cfg, `/videos/${encodeURIComponent(id)}/content`, { method: 'GET' }, VIDEO_CONTENT_TIMEOUT_MS, {
		maxBytes: MAX_VIDEO_BYTES,
	})
	if (raw.kind === 'net' || !raw.ok) return failureOf(raw, '')
	if (raw.body.byteLength === 0) return { ok: false, status: 502, error: 'empty video', model: '' }
	return { ok: true, status: raw.status, data: raw.body, model: '' }
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
