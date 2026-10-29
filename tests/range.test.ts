import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseRange } from '../src/lib/range.ts'

describe('parseRange (Safari/iOS <video>)', () => {
	const size = 1000
	it('no / unusable header → null (serve 200 full)', () => {
		assert.equal(parseRange(null, size), null)
		assert.equal(parseRange('items=0-1', size), null)
		assert.equal(parseRange('bytes=0-1,5-9', size), null)
		assert.equal(parseRange('bytes=-', size), null)
	})
	it('Safari probe bytes=0-1', () => {
		assert.deepEqual(parseRange('bytes=0-1', size), { start: 0, end: 1 })
	})
	it('open-ended and clamped ranges', () => {
		assert.deepEqual(parseRange('bytes=500-', size), { start: 500, end: 999 })
		assert.deepEqual(parseRange('bytes=900-5000', size), { start: 900, end: 999 })
	})
	it('suffix ranges', () => {
		assert.deepEqual(parseRange('bytes=-100', size), { start: 900, end: 999 })
		assert.deepEqual(parseRange('bytes=-5000', size), { start: 0, end: 999 })
		assert.equal(parseRange('bytes=-0', size), 'unsatisfiable')
	})
	it('unsatisfiable', () => {
		assert.equal(parseRange('bytes=1000-', size), 'unsatisfiable')
		assert.equal(parseRange('bytes=10-5', size), 'unsatisfiable')
	})
})
