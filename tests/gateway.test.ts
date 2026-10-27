import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
	clientStatusFor,
	decodeImageDataUrl,
	generateImageWithBurst,
	gatewayConfigFromEnv,
	shouldBurstFailedJob,
	submitVideoWithBurst,
	type FetchLike,
	type GatewayConfig,
} from '../src/lib/gateway.ts'

const FAKE_KEY = 'test-key-not-real'
type Call = { url: string; init?: RequestInit; body: any }

function mockFetch(responders: Array<(call: Call) => Response | Promise<Response>>) {
	const calls: Call[] = []
	const fetch: FetchLike = async (url, init) => {
		const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
		const call = { url, init, body }
		calls.push(call)
		const r = responders[calls.length - 1]
		if (!r) throw new Error(`unexpected fetch #${calls.length} to ${url}`)
		return r(call)
	}
	return { fetch, calls }
}

const cfg = (fetch: FetchLike): GatewayConfig => ({ baseUrl: 'https://gw.test/v1', apiKey: FAKE_KEY, fetch })
const okImage = () => Response.json({ data: [{ b64_json: 'iVBORw0KGgo=' }] })
const status = (s: number, msg = 'x') => () => Response.json({ error: { message: msg } }, { status: s })
const body = { prompt: 'a cat', size: '512x512' }

describe('generateImageWithBurst (contract burst rule)', () => {
	it('local ok → one call to local, no rented', async () => {
		const m = mockFetch([okImage])
		const r = await generateImageWithBurst(cfg(m.fetch), body)
		assert.equal(r.ok, true)
		assert.equal(r.model, 'local-image-flux')
		assert.equal(m.calls.length, 1)
		assert.equal(m.calls[0].url, 'https://gw.test/v1/images/generations')
		assert.equal(m.calls[0].body.model, 'local-image-flux')
		assert.equal(m.calls[0].body.prompt, 'a cat')
		assert.equal((m.calls[0].init?.headers as Record<string, string>).Authorization, `Bearer ${FAKE_KEY}`)
	})

	it('local 503 → rented once, same body', async () => {
		const m = mockFetch([status(503, 'no room'), okImage])
		const r = await generateImageWithBurst(cfg(m.fetch), { ...body, image: 'data:image/png;base64,AA==', strength: 0.65 })
		assert.equal(r.ok, true)
		assert.equal(r.model, 'rented-image-flux')
		assert.equal(m.calls.length, 2)
		const { model: m0, ...rest0 } = m.calls[0].body
		const { model: m1, ...rest1 } = m.calls[1].body
		assert.equal(m0, 'local-image-flux')
		assert.equal(m1, 'rented-image-flux')
		assert.deepEqual(rest1, rest0)
	})

	it('local 500 → rented', async () => {
		const m = mockFetch([status(500), okImage])
		const r = await generateImageWithBurst(cfg(m.fetch), body)
		assert.equal(r.ok && r.model, 'rented-image-flux')
	})

	it('local 4xx → surfaced, NO rented call', async () => {
		for (const s of [400, 413, 422, 429]) {
			const m = mockFetch([status(s, 'bad prompt')])
			const r = await generateImageWithBurst(cfg(m.fetch), body)
			assert.equal(r.ok, false)
			assert.equal(r.status, s)
			assert.equal(m.calls.length, 1, `status ${s} must not burst`)
			if (!r.ok) assert.equal(r.error, 'bad prompt')
		}
	})

	it('network error → rented', async () => {
		const m = mockFetch([
			() => {
				throw new TypeError('fetch failed')
			},
			okImage,
		])
		const r = await generateImageWithBurst(cfg(m.fetch), body)
		assert.equal(r.ok && r.model, 'rented-image-flux')
		assert.equal(m.calls.length, 2)
	})

	it('local timeout → rented', async () => {
		const hang: (c: Call) => Promise<Response> = (c) =>
			new Promise((_, reject) => c.init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
		const m = mockFetch([hang, okImage])
		const r = await generateImageWithBurst(cfg(m.fetch), body, { localTimeoutMs: 20 })
		assert.equal(r.ok && r.model, 'rented-image-flux')
	})

	it('rented fails too → that failure, exactly 2 calls (no further retry)', async () => {
		const m = mockFetch([status(503), status(502, 'worker down')])
		const r = await generateImageWithBurst(cfg(m.fetch), body)
		assert.equal(r.ok, false)
		assert.equal(r.status, 502)
		assert.equal(r.model, 'rented-image-flux')
		assert.equal(m.calls.length, 2)
	})

	it('rented: null (live mode) → 503 is surfaced, rented never called', async () => {
		const m = mockFetch([status(503)])
		const r = await generateImageWithBurst(cfg(m.fetch), body, { rented: null })
		assert.equal(r.ok, false)
		assert.equal(r.status, 503)
		assert.equal(m.calls.length, 1)
	})

	it('200 without an image → 502, no burst', async () => {
		const m = mockFetch([() => Response.json({ data: [] })])
		const r = await generateImageWithBurst(cfg(m.fetch), body)
		assert.equal(r.status, 502)
		assert.equal(m.calls.length, 1)
	})
})

describe('video burst rule', () => {
	const req = { prompt: 'waves', seconds: '4', size: '768x512', image: { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' } }
	const job = (id: string) => () => Response.json({ id, object: 'video', status: 'queued' })

	it('submit ok on local', async () => {
		const m = mockFetch([job('vid_local')])
		const r = await submitVideoWithBurst(cfg(m.fetch), req)
		assert.equal(r.ok && r.data.id, 'vid_local')
		assert.equal(r.model, 'local-video-ltxv')
		const form = m.calls[0].body as FormData
		assert.equal(form.get('model'), 'local-video-ltxv')
		assert.ok(form.get('input_reference') instanceof Blob)
	})

	it('submit 5xx → rented once', async () => {
		const m = mockFetch([status(503), job('vid_rented')])
		const r = await submitVideoWithBurst(cfg(m.fetch), req)
		assert.equal(r.model, 'rented-video-ltxv')
		assert.equal((m.calls[1].body as FormData).get('model'), 'rented-video-ltxv')
	})

	it('submit network error → rented once', async () => {
		const m = mockFetch([
			() => {
				throw new TypeError('fetch failed')
			},
			job('vid_rented'),
		])
		const r = await submitVideoWithBurst(cfg(m.fetch), req)
		assert.equal(r.model, 'rented-video-ltxv')
	})

	it('submit 4xx → no rented', async () => {
		const m = mockFetch([status(400)])
		const r = await submitVideoWithBurst(cfg(m.fetch), req)
		assert.equal(r.ok, false)
		assert.equal(m.calls.length, 1)
	})

	it('only a LOCAL job failed with capacity_error bursts', () => {
		const failed = (code: string) => ({ id: 'x', status: 'failed', error: { code } })
		assert.equal(shouldBurstFailedJob('local-video-ltxv', failed('capacity_error')), true)
		assert.equal(shouldBurstFailedJob('local-video-ltxv', failed('content_policy')), false)
		assert.equal(shouldBurstFailedJob('rented-video-ltxv', failed('capacity_error')), false)
		assert.equal(shouldBurstFailedJob('local-video-ltxv', { id: 'x', status: 'in_progress' }), false)
	})
})

describe('config and helpers', () => {
	it('no key → null config; base URL default and trailing slash', () => {
		assert.equal(gatewayConfigFromEnv({}), null)
		assert.equal(gatewayConfigFromEnv({ LITELLM_MEDIA_KEY: FAKE_KEY })!.baseUrl, 'https://llm.jeffemmett.com/v1')
		assert.equal(gatewayConfigFromEnv({ LITELLM_MEDIA_KEY: FAKE_KEY, LITELLM_BASE_URL: 'http://x/v1/' })!.baseUrl, 'http://x/v1')
	})

	it('gateway 401/403 → 502 for the browser (our key, not their fault)', () => {
		assert.equal(clientStatusFor(401), 502)
		assert.equal(clientStatusFor(403), 502)
		assert.equal(clientStatusFor(400), 400)
		assert.equal(clientStatusFor(503), 503)
	})

	it('decodeImageDataUrl accepts only png/jpeg base64', () => {
		assert.deepEqual(decodeImageDataUrl('data:image/png;base64,AQID')?.bytes, new Uint8Array([1, 2, 3]))
		assert.equal(decodeImageDataUrl('data:image/svg+xml;base64,AQID'), null)
		assert.equal(decodeImageDataUrl('https://example.com/a.png'), null)
		assert.equal(decodeImageDataUrl(42), null)
	})
})

describe('video submit: malformed 200 is not burstable', () => {
	it('200 without a job id → 502, no rented call', async () => {
		const m = mockFetch([() => Response.json({ object: 'video' })])
		const r = await submitVideoWithBurst(cfg(m.fetch), {
			prompt: 'p',
			seconds: '4',
			size: '768x512',
			image: { bytes: new Uint8Array([1]), mime: 'image/png' },
		})
		assert.equal(r.ok, false)
		assert.equal(r.status, 502)
		assert.equal(m.calls.length, 1)
	})
})
