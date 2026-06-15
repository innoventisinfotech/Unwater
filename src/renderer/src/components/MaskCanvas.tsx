import { forwardRef, useEffect, useImperativeHandle, useRef, type PointerEvent } from 'react'

export interface MaskCanvasHandle {
  /** Export the mask as a white-on-black PNG data URL at source resolution. */
  exportMaskDataUrl: () => string
  clear: () => void
}

interface Props {
  src: string
  width: number
  height: number
  tool: 'brush' | 'rect'
  brushSize: number
}

/**
 * Two stacked canvases: the source image (base) and a transparent mask layer painted in white.
 * The mask layer is shown semi-transparent for visibility but exported as solid white-on-black.
 */
const MaskCanvas = forwardRef<MaskCanvasHandle, Props>(function MaskCanvas(
  { src, width, height, tool, brushSize },
  ref
) {
  const imgRef = useRef<HTMLCanvasElement>(null)
  const maskRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const startPt = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const c = imgRef.current
    const m = maskRef.current
    if (!c || !m) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const image = new Image()
    image.onload = () => ctx.drawImage(image, 0, 0, width, height)
    image.src = src
    m.getContext('2d')?.clearRect(0, 0, width, height)
  }, [src, width, height])

  useImperativeHandle(
    ref,
    () => ({
      exportMaskDataUrl: () => {
        const tmp = document.createElement('canvas')
        tmp.width = width
        tmp.height = height
        const t = tmp.getContext('2d')
        if (!t) return ''
        t.fillStyle = 'black'
        t.fillRect(0, 0, width, height)
        const m = maskRef.current
        if (m) t.drawImage(m, 0, 0)
        return tmp.toDataURL('image/png')
      },
      clear: () => maskRef.current?.getContext('2d')?.clearRect(0, 0, width, height)
    }),
    [width, height]
  )

  function toCanvasCoords(e: PointerEvent): { x: number; y: number } {
    const c = maskRef.current
    if (!c) return { x: 0, y: 0 }
    const r = c.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) / r.width) * width,
      y: ((e.clientY - r.top) / r.height) * height
    }
  }

  function paintDab(x: number, y: number): void {
    const ctx = maskRef.current?.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2)
    ctx.fill()
  }

  function onPointerDown(e: PointerEvent): void {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    drawing.current = true
    const p = toCanvasCoords(e)
    startPt.current = p
    if (tool === 'brush') paintDab(p.x, p.y)
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drawing.current || tool !== 'brush') return
    const p = toCanvasCoords(e)
    paintDab(p.x, p.y)
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drawing.current) return
    drawing.current = false
    if (tool === 'rect' && startPt.current) {
      const p = toCanvasCoords(e)
      const ctx = maskRef.current?.getContext('2d')
      if (ctx) {
        const s = startPt.current
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(Math.min(s.x, p.x), Math.min(s.y, p.y), Math.abs(p.x - s.x), Math.abs(p.y - s.y))
      }
    }
    startPt.current = null
  }

  return (
    <div className="relative inline-block max-w-full" style={{ aspectRatio: `${width} / ${height}` }}>
      <canvas ref={imgRef} width={width} height={height} className="block h-auto max-w-full select-none" />
      <canvas
        ref={maskRef}
        width={width}
        height={height}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="absolute left-0 top-0 h-full w-full cursor-crosshair opacity-50 touch-none"
      />
    </div>
  )
})

export default MaskCanvas
