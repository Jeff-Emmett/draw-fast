import { LiveImageShape } from '@/components/LiveImageShapeUtil'
import { fastGetSvgAsImage } from '@/utils/screenshot'
import { AssetRecordType, Editor, FileHelpers, TLShape, TLShapeId, getHashForObject, useEditor } from '@tldraw/tldraw'
import { useEffect } from 'react'

// Live "draw → image" on our own compute (rspace TASK-1727).
//
// There is no realtime LCM stream on our stack, so this is debounced img2img through
// /api/live (local-image-flux on GX10 only — never the rented burst lane):
//   - fires DEBOUNCE_MS after the last change to the sketch or prompt;
//   - latest wins: a newer render aborts the one in flight (at most one per shape);
//   - on failure (503 = GX10 busy, 429, network) the last image stays and a retry is
//     scheduled with backoff; any new stroke resets the backoff.

export type LiveImageStatus = 'idle' | 'rendering' | 'busy'

const DEBOUNCE_MS = 1750
const MAX_SIDE = 512
const MAX_BACKOFF_MS = 30_000

/** Longest side → 512, both sides multiples of 16 (what /api/live accepts). */
export function liveRenderSize(w: number, h: number) {
	const scale = MAX_SIDE / Math.max(w, h, 1)
	const round = (n: number) => Math.min(768, Math.max(128, Math.round((n * scale) / 16) * 16))
	return { w: round(w), h: round(h) }
}

export function useLiveImage(shapeId: TLShapeId, { debounceMs = DEBOUNCE_MS }: { debounceMs?: number } = {}) {
	const editor = useEditor()

	useEffect(() => {
		if (typeof window === 'undefined') return

		let renderedKey = '' // key of the sketch last rendered (or being rendered)
		let inflight: AbortController | null = null
		let timer: ReturnType<typeof setTimeout> | null = null
		let backoffMs = 0
		let disposed = false

		const setStatus = (status: LiveImageStatus) =>
			editor.emit('generation-state' as any, { shapeId, status, generating: status === 'rendering' })

		function schedule(delay: number) {
			if (disposed) return
			if (timer !== null) clearTimeout(timer)
			timer = setTimeout(() => {
				timer = null
				void render()
			}, delay)
		}

		function onChange() {
			backoffMs = 0
			schedule(debounceMs)
		}

		function retryLater(retryAfterSec?: number) {
			renderedKey = '' // the sketch is still unrendered
			backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(backoffMs * 2, debounceMs * 2))
			const delay = retryAfterSec ? Math.max(backoffMs, retryAfterSec * 1000) : backoffMs
			setStatus('busy')
			schedule(delay)
		}

		async function render() {
			const frame = editor.getShape<LiveImageShape>(shapeId)
			if (!frame) return
			const shapes = getShapesTouching(shapeId, editor)
			const key = getHashForObject([...shapes]) + `|${frame.props.name}|${frame.props.w}x${frame.props.h}`
			if (key === renderedKey) return
			// Empty frame, no prompt: nothing to draw from. Don't spend GPU on every page load.
			if (shapes.length === 0 && !frame.props.name) {
				inflight?.abort()
				renderedKey = key
				setStatus('idle')
				return
			}

			inflight?.abort() // latest wins
			const ctrl = new AbortController()
			inflight = ctrl
			renderedKey = key
			setStatus('rendering')

			try {
				const size = liveRenderSize(frame.props.w, frame.props.h)
				const svg = await editor.getSvgString([...shapes], {
					background: true,
					padding: 0,
					darkMode: editor.user.getIsDarkMode(),
					bounds: editor.getShapePageBounds(shapeId)!,
					scale: size.w / frame.props.w,
				})
				if (ctrl.signal.aborted) return
				if (!svg) {
					updateImage(editor, shapeId, null)
					setStatus('idle')
					return
				}

				const blob = await fastGetSvgAsImage(svg.svg, { type: 'png', quality: 1, width: size.w, height: size.h })
				if (ctrl.signal.aborted) return
				if (!blob) {
					setStatus('idle')
					return
				}
				const image = await FileHelpers.blobToDataUrl(blob)
				if (ctrl.signal.aborted) return

				const prompt = frame.props.name
					? frame.props.name + ' hd award-winning impressive'
					: 'A random image that is safe for work and not surprising—something boring like a city or shoe watercolor'

				const res = await fetch('/api/live', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ prompt, image, size: `${size.w}x${size.h}`, strength: 0.65 }),
					signal: ctrl.signal,
				})
				if (ctrl.signal.aborted) return
				if (!res.ok) {
					// 4xx other than 429 is our own bad request: don't hammer, wait for a change.
					if (res.status >= 400 && res.status < 500 && res.status !== 429) {
						console.warn('live render rejected', res.status)
						setStatus('idle')
						return
					}
					retryLater(Number(res.headers.get('retry-after')) || undefined)
					return
				}
				const { image: url } = (await res.json()) as { image: string }
				await preloadImage(url)
				if (ctrl.signal.aborted || disposed) return
				updateImage(editor, shapeId, url)
				backoffMs = 0
				setStatus('idle')
			} catch (e) {
				if (ctrl.signal.aborted || disposed) return
				console.warn('live render failed', e)
				retryLater()
			} finally {
				if (inflight === ctrl) inflight = null
			}
		}

		editor.on('update-drawings' as any, onChange)
		return () => {
			disposed = true
			editor.off('update-drawings' as any, onChange)
			if (timer !== null) clearTimeout(timer)
			inflight?.abort()
		}
	}, [editor, shapeId, debounceMs])
}

function preloadImage(url: string): Promise<void> {
	return new Promise((resolve) => {
		const img = new Image()
		img.onload = () => resolve()
		img.onerror = () => resolve() // don't block on preload failure
		img.src = url
	})
}

function updateImage(editor: Editor, shapeId: TLShapeId, url: string | null) {
	const shape = editor.getShape<LiveImageShape>(shapeId)
	if (!shape) return
	const id = AssetRecordType.createId(shape.id.split(':')[1])
	const asset = editor.getAsset(id)

	if (!asset) {
		editor.createAssets([
			AssetRecordType.create({
				id,
				type: 'image',
				props: {
					name: shape.props.name,
					w: shape.props.w,
					h: shape.props.h,
					src: url,
					isAnimated: false,
					mimeType: 'image/png',
				},
			}),
		])
	} else {
		editor.updateAssets([
			{
				...asset,
				type: 'image',
				props: { ...asset.props, w: shape.props.w, h: shape.props.h, src: url },
			},
		])
	}
}

function getShapesTouching(shapeId: TLShapeId, editor: Editor) {
	const shapesTouching: TLShape[] = []
	const targetBounds = editor.getShapePageBounds(shapeId)
	if (!targetBounds) return shapesTouching
	for (const id of [...editor.getCurrentPageShapeIds()]) {
		if (id === shapeId) continue
		const bounds = editor.getShapePageBounds(id)
		if (bounds && bounds.collides(targetBounds)) shapesTouching.push(editor.getShape(id)!)
	}
	return shapesTouching
}
