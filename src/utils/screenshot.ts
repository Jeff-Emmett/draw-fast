'use client'

import { type } from 'os'
import { blobToDataUri } from './blob'

let _canvas: HTMLCanvasElement | null = null
let _ctx: CanvasRenderingContext2D | null = null

function getFileReader() {
	if (typeof window === 'undefined') return null
	return new FileReader()
}

async function fastGetSvgAsString(svg: SVGElement) {
	if (typeof window === 'undefined') {
		return ''
	}

	const clone = svg.cloneNode(true) as SVGGraphicsElement

	svg.setAttribute('width', +svg.getAttribute('width')! + '')
	svg.setAttribute('height', +svg.getAttribute('height')! + '')

	const imgs = Array.from(clone.querySelectorAll('image')) as SVGImageElement[]

	for (const img of imgs) {
		const src = img.getAttribute('xlink:href')
		if (src) {
			if (!src.startsWith('data:')) {
				try {
					const blob = await (await fetch(src)).blob()
					const base64 = await blobToDataUri(blob)
					img.setAttribute('xlink:href', base64)
				} catch (error) {
					console.error('Error processing image:', error)
				}
			}
		}
	}

	const out = new XMLSerializer()
		.serializeToString(clone)
		.replaceAll('&#10;      ', '')
		.replaceAll(/((\s|")[0-9]*\.[0-9]{2})([0-9]*)(\b|"|\))/g, '$1')

	return out
}

export async function fastGetSvgAsImage(
	svgString: string,
	options: {
		type: 'png' | 'jpeg' | 'webp'
		quality: number
		width: number
		height: number
	}
) {
	if (typeof window === 'undefined') {
		return null
	}

	const svgUrl = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml' }))

	if (!_canvas) {
		_canvas = document.createElement('canvas')
		_ctx = _canvas?.getContext('2d')!
		_ctx.imageSmoothingEnabled = true
		_ctx.imageSmoothingQuality = 'high'
	}

	const canvas = await new Promise<HTMLCanvasElement | null>((resolve) => {
		const image = new Image()
		image.crossOrigin = 'anonymous'

		image.onload = async () => {
			if (!_canvas || !_ctx) {
				throw new Error('Canvas not initialized for fast screenshotting')
			}
			const canvas = _canvas
			const ctx = _ctx

			if (canvas.width !== options.width || canvas.height !== options.height) {
				canvas.width = options.width
				canvas.height = options.height
			}

			ctx.drawImage(image, 0, 0, options.width, options.height)
			URL.revokeObjectURL(svgUrl)
			resolve(canvas)
		}

		image.onerror = () => {
			resolve(null)
		}

		image.src = svgUrl
	})

	if (!canvas) return null

	return new Promise<Blob | null>((resolve) =>
		canvas.toBlob(
			(blob) => {
				resolve(blob)
			},
			`image/${options.type}`,
			options.quality
		)
	)
}
