import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BodyTooLargeError, clientIp, RateLimiter, readBodyCapped } from '../src/lib/rateLimit.ts'

describe('RateLimiter', () => {
	it('allows a burst of `capacity`, then refuses with Retry-After', () => {
		let t = 0
		const rl = new RateLimiter({ capacity: 3, refillPerSec: 0.5, now: () => t })
		assert.equal(rl.take('a').allowed, true)
		assert.equal(rl.take('a').allowed, true)
		assert.equal(rl.take('a').allowed, true)
		const r = rl.take('a')
		assert.equal(r.allowed, false)
		assert.equal(r.retryAfterSec, 2)
	})

	it('refills over time, never above capacity', () => {
		let t = 0
		const rl = new RateLimiter({ capacity: 2, refillPerSec: 1, now: () => t })
		rl.take('a')
		rl.take('a')
		assert.equal(rl.take('a').allowed, false)
		t += 1000
		assert.equal(rl.take('a').allowed, true)
		assert.equal(rl.take('a').allowed, false)
		t += 60_000
		assert.equal(rl.take('a').allowed, true)
		assert.equal(rl.take('a').allowed, true)
		assert.equal(rl.take('a').allowed, false)
	})

	it('buckets are per key', () => {
		const rl = new RateLimiter({ capacity: 1, refillPerSec: 0.001, now: () => 0 })
		assert.equal(rl.take('1.1.1.1').allowed, true)
		assert.equal(rl.take('1.1.1.1').allowed, false)
		assert.equal(rl.take('2.2.2.2').allowed, true)
	})

	it('evicts the stalest key beyond maxKeys (memory bound)', () => {
		const rl = new RateLimiter({ capacity: 1, refillPerSec: 0.001, maxKeys: 2, now: () => 0 })
		rl.take('a')
		rl.take('b')
		rl.take('c')
		assert.equal(rl.size, 2)
		// 'a' was evicted, so it gets a fresh bucket
		assert.equal(rl.take('a').allowed, true)
	})
})

describe('clientIp', () => {
	it('prefers cf-connecting-ip, then first x-forwarded-for, then x-real-ip', () => {
		assert.equal(clientIp(new Headers({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' })), '9.9.9.9')
		assert.equal(clientIp(new Headers({ 'x-forwarded-for': '1.1.1.1, 10.0.0.1' })), '1.1.1.1')
		assert.equal(clientIp(new Headers({ 'x-real-ip': '2.2.2.2' })), '2.2.2.2')
		assert.equal(clientIp(new Headers()), 'unknown')
	})
})

describe('readBodyCapped', () => {
	it('reads a body under the cap', async () => {
		const req = new Request('http://x/', { method: 'POST', body: '{"a":1}' })
		assert.equal(await readBodyCapped(req, 100), '{"a":1}')
	})

	it('refuses a declared content-length over the cap', async () => {
		const req = new Request('http://x/', { method: 'POST', body: 'x'.repeat(50), headers: { 'content-length': '50' } })
		await assert.rejects(readBodyCapped(req, 10), BodyTooLargeError)
	})

	it('refuses a streamed body that passes the cap (no content-length)', async () => {
		const stream = new ReadableStream({
			start(c) {
				for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(10))
				c.close()
			},
		})
		const req = new Request('http://x/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
		await assert.rejects(readBodyCapped(req, 25), BodyTooLargeError)
	})
})
