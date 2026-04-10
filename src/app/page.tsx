/* eslint-disable @next/next/no-img-element */
'use client'

import { LiveImageShape, LiveImageShapeUtil } from '@/components/LiveImageShapeUtil'
import { LiveImageTool, MakeLiveButton } from '@/components/LiveImageTool'
import { LiveImageProvider } from '@/hooks/useLiveImage'
import * as fal from '@fal-ai/serverless-client'
import {
	AssetRecordType,
	DefaultSizeStyle,
	Editor,
	TLUiOverrides,
	Tldraw,
	track,
	useEditor,
} from '@tldraw/tldraw'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

fal.config({
	requestMiddleware: fal.withProxy({
		targetUrl: '/api/fal/proxy',
	}),
})

const overrides: TLUiOverrides = {
	tools(editor, tools) {
		tools.liveImage = {
			id: 'live-image',
			icon: 'tool-frame',
			label: 'Frame',
			kbd: 'f',
			readonlyOk: false,
			onSelect: () => {
				editor.setCurrentTool('live-image')
			},
		}
		tools.textToImage = {
			id: 'text-to-image',
			icon: 'text',
			label: 'Text to Image',
			kbd: 't',
			readonlyOk: false,
			onSelect: () => {
				editor.setCurrentTool('text-to-image')
			},
		}
		tools.imageToVideo = {
			id: 'image-to-video',
			icon: 'video',
			label: 'Image to Video',
			kbd: 'v',
			readonlyOk: false,
			onSelect: () => {
				editor.setCurrentTool('image-to-video')
			},
		}
		return tools
	},
}

const shapeUtils = [LiveImageShapeUtil]
const tools = [LiveImageTool]

export default function Home() {
	const [generationType, setGenerationType] = useState<'sketch-to-image' | 'text-to-image' | 'image-to-video'>('sketch-to-image')

	const onEditorMount = (editor: Editor) => {
		// We need the editor to think that the live image shape is a frame
		// @ts-expect-error: patch
		editor.isShapeOfType = function (arg, type) {
			const shape = typeof arg === 'string' ? this.getShape(arg)! : arg
			if (shape.type === 'live-image' && type === 'frame') {
				return true
			}
			return shape.type === type
		}

		// If there isn't a live image shape, create one
		if (!editor.getCurrentPageShapes().some((shape) => shape.type === 'live-image')) {
			editor.createShape<LiveImageShape>({
				type: 'live-image',
				x: 120,
				y: 180,
				props: {
					w: 512,
					h: 512,
					name: '',
				},
			})
		}

		editor.setStyleForNextShapes(DefaultSizeStyle, 'xl')

		// Trigger initial image generation after a short delay
		setTimeout(() => {
			editor.emit('update-drawings' as any)
		}, 100)
	}

	return (
		<LiveImageProvider appId="110602490-lcm-sd15-i2i">
			<main className="tldraw-wrapper">
				<div className="tldraw-wrapper__inner">
					<Tldraw
						persistenceKey="draw-fast"
						onMount={onEditorMount}
						shapeUtils={shapeUtils}
						tools={tools}
						components={{
							SharePanel: MakeLiveButton,
						}}
						overrides={overrides}
					>
						<SneakySideEffects />
						<LiveImageAssets />
					</Tldraw>
				</div>
			</main>
		</LiveImageProvider>
	)
}

function SneakySideEffects() {
	const editor = useEditor()

	useEffect(() => {
		// Only emit update-drawings when shapes that could affect a live-image frame change.
		// Skip changes to the live-image shape itself (handled by prompt change detection in useLiveImage).
		function shouldEmitForShape(shape: { type: string; id: string }) {
			if (shape.type === 'live-image') {
				// Do emit for prompt/name changes on the live-image frame
				return true
			}
			// Check if this shape touches any live-image frame
			const liveFrames = editor.getCurrentPageShapes().filter(s => s.type === 'live-image')
			for (const frame of liveFrames) {
				const frameBounds = editor.getShapePageBounds(frame.id)
				const shapeBounds = editor.getShapePageBounds(shape.id as any)
				if (frameBounds && shapeBounds && shapeBounds.collides(frameBounds)) {
					return true
				}
			}
			return false
		}

		const removers = [
			editor.sideEffects.registerAfterChangeHandler('shape', (_prev, next) => {
				if (shouldEmitForShape(next)) {
					editor.emit('update-drawings' as any)
				}
			}),
			editor.sideEffects.registerAfterCreateHandler('shape', (shape) => {
				if (shouldEmitForShape(shape)) {
					editor.emit('update-drawings' as any)
				}
			}),
			editor.sideEffects.registerAfterDeleteHandler('shape', (shape) => {
				// Always emit on delete — deleted shape may have been touching a frame
				editor.emit('update-drawings' as any)
			}),
		]

		return () => {
			removers.forEach(remove => remove())
		}
	}, [editor])

	return null
}

const LiveImageAssets = track(function LiveImageAssets() {
	const editor = useEditor()

	return (
		<Inject selector=".tl-overlays .tl-html-layer">
			{editor
				.getCurrentPageShapes()
				.filter((shape): shape is LiveImageShape => shape.type === 'live-image')
				.map((shape) => (
					<LiveImageAsset key={shape.id} shape={shape} />
				))}
		</Inject>
	)
})

const LiveImageAsset = track(function LiveImageAsset({ shape }: { shape: LiveImageShape }) {
	const editor = useEditor()

	if (!shape.props.overlayResult) return null

	const transform = editor.getShapePageTransform(shape).toCssString()
	const assetId = AssetRecordType.createId(shape.id.split(':')[1])
	const asset = editor.getAsset(assetId)
	return (
		asset &&
		asset.props.src && (
			<img
				src={asset.props.src!}
				alt={shape.props.name}
				width={shape.props.w}
				height={shape.props.h}
				style={{
					position: 'absolute',
					top: 0,
					left: 0,
					width: shape.props.w,
					height: shape.props.h,
					maxWidth: 'none',
					transform,
					transformOrigin: 'top left',
					opacity: shape.opacity,
					transition: 'opacity 0.15s ease-in-out',
				}}
			/>
		)
	)
})

function Inject({ children, selector }: { children: React.ReactNode; selector: string }) {
	const [parent, setParent] = useState<Element | null>(null)
	const target = useMemo(() => parent?.querySelector(selector) ?? null, [parent, selector])

	return (
		<>
			<div ref={(el) => setParent(el?.parentElement ?? null)} style={{ display: 'none' }} />
			{target && createPortal(children, target)}
		</>
	)
}
