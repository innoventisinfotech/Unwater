/**
 * Pure CV to turn a detector's per-pixel confidence map into a clean binary inpaint mask.
 * No ONNX/sharp here — just typed-array math (mirrors engines/tiling.ts). Unit-tested offline.
 */

export interface DetectedBox {
  x0: number
  y0: number
  x1: number // exclusive
  y1: number // exclusive
  area: number
}

export interface Region {
  x: number
  y: number
  w: number
  h: number
  kind: 'text' | 'logo'
  score: number
}

export interface BuildMaskOptions {
  /** 0..255 threshold on the confidence map (≈0.3*255 = 77 for DBNet). */
  threshold: number
  /** Connected components smaller than this (pixels) are discarded as noise. */
  minArea: number
  kind: 'text' | 'logo'
  /**
   * Fixed square-SE dilation radius. If omitted, the radius is derived adaptively from the
   * detected text thickness (DBNet emits a SHRUNK kernel, so a thin raw mask under-covers the
   * watermark — we must expand it to the full glyph extent).
   */
  dilateRadius?: number
  /** When deriving the radius: radius = clamp(thickness * expandFactor, minDilate, maxDilate). */
  expandFactor?: number
  minDilate?: number
  maxDilate?: number
}

/**
 * Estimate how far to dilate a detected text region. Thickness ≈ area / longest side (the long
 * side ≈ the text run length, so area/length ≈ the perpendicular stroke-band thickness). We
 * expand by `factor` to recover the full glyph extent from DBNet's shrunk kernel.
 */
export function adaptiveDilateRadius(
  box: DetectedBox,
  factor: number,
  minRadius: number,
  maxRadius: number
): number {
  const longSide = Math.max(box.x1 - box.x0, box.y1 - box.y0, 1)
  const thickness = box.area / longSide
  return Math.max(minRadius, Math.min(maxRadius, Math.round(thickness * factor)))
}

export interface BuildMaskResult {
  /** Source-resolution binary mask (0/255), length width*height. */
  mask: Uint8Array
  regions: Region[]
  found: boolean
}

export function binarizeConfidence(conf: Uint8Array, threshold: number): Uint8Array {
  const out = new Uint8Array(conf.length)
  for (let i = 0; i < conf.length; i++) out[i] = conf[i] >= threshold ? 255 : 0
  return out
}

/** Separable square-SE dilation (horizontal max then vertical max). O(W*H). */
export function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice()
  const horiz = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let on = 0
      for (let dx = -radius; dx <= radius && !on; dx++) {
        const nx = x + dx
        if (nx >= 0 && nx < width && mask[row + nx] === 255) on = 255
      }
      horiz[row + x] = on
    }
  }
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0
      for (let dy = -radius; dy <= radius && !on; dy++) {
        const ny = y + dy
        if (ny >= 0 && ny < height && horiz[ny * width + x] === 255) on = 255
      }
      out[y * width + x] = on
    }
  }
  return out
}

/** 4-connected component labeling; returns the label map and per-label bounding boxes. */
export function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number
): { labels: Int32Array; boxes: DetectedBox[] } {
  const labels = new Int32Array(width * height).fill(0)
  const boxes: DetectedBox[] = []
  const stack: number[] = []
  let current = 0
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 255 || labels[i] !== 0) continue
    current++
    let x0 = width
    let y0 = height
    let x1 = 0
    let y1 = 0
    let area = 0
    stack.push(i)
    labels[i] = current
    while (stack.length) {
      const p = stack.pop()!
      const px = p % width
      const py = (p - px) / width
      area++
      if (px < x0) x0 = px
      if (py < y0) y0 = py
      if (px + 1 > x1) x1 = px + 1
      if (py + 1 > y1) y1 = py + 1
      const neighbors = [
        px > 0 ? p - 1 : -1,
        px < width - 1 ? p + 1 : -1,
        py > 0 ? p - width : -1,
        py < height - 1 ? p + width : -1
      ]
      for (const n of neighbors) {
        if (n >= 0 && mask[n] === 255 && labels[n] === 0) {
          labels[n] = current
          stack.push(n)
        }
      }
    }
    boxes.push({ x0, y0, x1, y1, area })
  }
  return { labels, boxes }
}

export function buildMask(
  conf: Uint8Array,
  width: number,
  height: number,
  opts: BuildMaskOptions
): BuildMaskResult {
  const bin = binarizeConfidence(conf, opts.threshold)
  // Find components BEFORE dilation so noise filtering uses true blob area.
  const { labels, boxes } = connectedComponents(bin, width, height)
  const kept = new Set<number>()
  const regions: Region[] = []
  let largestKept: DetectedBox | undefined
  for (let b = 0; b < boxes.length; b++) {
    const box = boxes[b]
    if (box.area < opts.minArea) continue
    kept.add(b + 1) // labels are 1-based in component order
    if (!largestKept || box.area > largestKept.area) largestKept = box
    regions.push({
      x: box.x0,
      y: box.y0,
      w: box.x1 - box.x0,
      h: box.y1 - box.y0,
      kind: opts.kind,
      score: 1
    })
  }
  // Rebuild a mask containing only kept components, then dilate for inpaint padding.
  const filtered = new Uint8Array(width * height)
  for (let i = 0; i < filtered.length; i++) if (kept.has(labels[i])) filtered[i] = 255

  // DBNet emits a shrunk kernel — a fixed tiny dilation under-covers the watermark. Derive a
  // generous radius from the detected text thickness unless an explicit radius is given.
  let radius = opts.dilateRadius ?? 0
  if (opts.dilateRadius === undefined && largestKept) {
    radius = adaptiveDilateRadius(
      largestKept,
      opts.expandFactor ?? 1.5,
      opts.minDilate ?? 4,
      opts.maxDilate ?? 64
    )
  }
  const mask = dilate(filtered, width, height, radius)
  return { mask, regions, found: regions.length > 0 }
}
