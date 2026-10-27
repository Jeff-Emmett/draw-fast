// HTTP Range for the MP4 route. Safari/iOS <video> will not play (or seek) media that is
// not served with byte ranges. Self-contained so node:test can load it.

export type RangeResult = { start: number; end: number } | 'unsatisfiable' | null

/**
 * Parses a single `bytes=` range against `size`. Returns null when there is no usable
 * Range header (serve the whole body with 200) — including multi-range requests, which
 * a 200 answers correctly. `end` is inclusive.
 */
export function parseRange(header: string | null, size: number): RangeResult {
	if (!header) return null
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
	if (!m) return null
	const [, a, b] = m
	if (a === '' && b === '') return null
	if (a === '') {
		// suffix: last N bytes
		const n = Number(b)
		if (n === 0) return 'unsatisfiable'
		return { start: Math.max(0, size - n), end: size - 1 }
	}
	const start = Number(a)
	if (start >= size) return 'unsatisfiable'
	const end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
	if (end < start) return 'unsatisfiable'
	return { start, end }
}
