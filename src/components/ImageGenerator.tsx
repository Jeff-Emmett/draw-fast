/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from 'react'

// Text-to-image and image-to-video through this app's own server routes (/api/image,
// /api/video), which talk to our LiteLLM gateway. No credential ever reaches the browser.

interface ImageGeneratorProps {
	generationType: 'sketch-to-image' | 'text-to-image' | 'image-to-video'
}

type Result = { kind: 'image'; url: string } | { kind: 'video'; url: string }

const POLL_MS = 4000
const MAX_POLL_MS = 10 * 60 * 1000

async function errorOf(res: Response): Promise<string> {
	const body = await res.json().catch(() => null)
	if (res.status === 429) return 'Too many requests — try again in a minute.'
	if (res.status === 503) return 'The GPU is busy right now — try again shortly.'
	return (body && typeof body.error === 'string' && body.error) || `Request failed (${res.status})`
}

function readAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const r = new FileReader()
		r.onload = () => (typeof r.result === 'string' ? resolve(r.result) : reject(new Error('read failed')))
		r.onerror = () => reject(r.error)
		r.readAsDataURL(file)
	})
}

/** Picks the gateway video size closest to the source image's aspect. */
function videoSizeFor(dataUrl: string): Promise<string> {
	return new Promise((resolve) => {
		const img = new Image()
		img.onload = () => {
			const a = img.naturalWidth / Math.max(1, img.naturalHeight)
			resolve(a > 1.2 ? '768x512' : a < 1 / 1.2 ? '512x768' : '512x512')
		}
		img.onerror = () => resolve('768x512')
		img.src = dataUrl
	})
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function ImageGenerator({ generationType }: ImageGeneratorProps) {
	const [prompt, setPrompt] = useState('')
	const [inputImage, setInputImage] = useState<string | null>(null)
	const [isLoading, setIsLoading] = useState(false)
	const [progress, setProgress] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [result, setResult] = useState<Result | null>(null)
	const cancelled = useRef(false)

	useEffect(() => {
		cancelled.current = false
		return () => {
			cancelled.current = true
		}
	}, [])

	async function textToImage() {
		const res = await fetch('/api/image', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt }),
		})
		if (!res.ok) throw new Error(await errorOf(res))
		const { image } = (await res.json()) as { image: string }
		setResult({ kind: 'image', url: image })
	}

	async function imageToVideo() {
		if (!inputImage) throw new Error('Choose a source image first.')
		const size = await videoSizeFor(inputImage)
		const res = await fetch('/api/video', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ prompt, image: inputImage, size }),
		})
		if (!res.ok) throw new Error(await errorOf(res))
		const { id } = (await res.json()) as { id: string }

		const started = Date.now()
		while (!cancelled.current) {
			if (Date.now() - started > MAX_POLL_MS) throw new Error('Video took too long — gave up waiting.')
			await sleep(POLL_MS)
			const poll = await fetch(`/api/video/${encodeURIComponent(id)}`, { cache: 'no-store' })
			if (poll.status === 429) continue // over the poll budget: just wait another tick
			if (!poll.ok) throw new Error(await errorOf(poll))
			const job = (await poll.json()) as {
				status: string
				progress?: number
				lane?: string
				error?: { message?: string }
			}
			if (job.status === 'completed') {
				setResult({ kind: 'video', url: `/api/video/${encodeURIComponent(id)}/content` })
				return
			}
			if (job.status === 'failed') throw new Error(job.error?.message || 'Video generation failed.')
			const pct = typeof job.progress === 'number' ? ` ${Math.round(job.progress)}%` : ''
			setProgress(`${job.status === 'queued' ? 'Queued' : 'Rendering'}${pct}${job.lane === 'rented' ? ' (burst GPU)' : ''}…`)
		}
	}

	const generateOutput = async () => {
		setIsLoading(true)
		setError(null)
		setProgress(null)
		try {
			if (!prompt.trim()) throw new Error('Enter a prompt.')
			if (generationType === 'text-to-image') await textToImage()
			else if (generationType === 'image-to-video') await imageToVideo()
		} catch (e) {
			setError(e instanceof Error ? e.message : 'Generation failed.')
		} finally {
			setIsLoading(false)
			setProgress(null)
		}
	}

	if (generationType === 'sketch-to-image') {
		return <p>Sketch to image runs live in the Draw Fast frame on the canvas.</p>
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
			<textarea
				style={{ width: '100%', padding: 8, border: '1px solid #ccc', borderRadius: 4 }}
				placeholder="Enter your prompt..."
				maxLength={1000}
				value={prompt}
				onChange={(e) => setPrompt(e.target.value)}
			/>

			{generationType === 'image-to-video' && (
				<label style={{ border: '2px dashed #ccc', padding: 12, textAlign: 'center', cursor: 'pointer' }}>
					<input
						type="file"
						accept="image/png,image/jpeg"
						style={{ display: 'none' }}
						onChange={async (e) => {
							const f = e.target.files?.[0]
							if (!f) return
							if (f.size > 5 * 1024 * 1024) {
								setError('Source image must be under 5 MB.')
								return
							}
							setInputImage(await readAsDataUrl(f))
						}}
					/>
					{inputImage ? (
						<img src={inputImage} alt="Source" style={{ maxWidth: '100%', maxHeight: 200 }} />
					) : (
						'Choose a source image (PNG or JPEG)'
					)}
				</label>
			)}

			<button
				style={{ background: '#3b82f6', color: 'white', padding: '8px 16px', borderRadius: 4 }}
				onClick={generateOutput}
				disabled={isLoading}
			>
				{isLoading ? progress || 'Generating…' : `Generate ${generationType.replace(/-/g, ' ')}`}
			</button>

			{error && <div style={{ color: '#dc2626' }}>{error}</div>}
			{result && (
				<div style={{ border: '1px solid #ccc', borderRadius: 4, padding: 12 }}>
					{result.kind === 'video' ? (
						<video controls autoPlay loop playsInline src={result.url} style={{ width: '100%' }} />
					) : (
						<img src={result.url} alt="Generated output" style={{ width: '100%' }} />
					)}
				</div>
			)}
		</div>
	)
}
