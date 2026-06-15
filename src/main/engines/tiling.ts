/**
 * Pure tiling math for Tier-1 inpainting.
 *
 * LaMa ONNX has a FIXED 512x512 input, so an arbitrary-sized image must be split into
 * overlapping 512 tiles covering the masked region, inpainted per-tile, then feather-blended
 * back so overlaps don't show a seam. Everything here is side-effect free and unit tested.
 */

export interface Tile {
  x: number
  y: number
  size: number
}

/** Half-open bounding box: covers pixels with x in [x0,x1), y in [y0,y1). */
export interface Bounds {
  x0: number
  y0: number
  x1: number
  y1: number
}

export const TILE = 512
export const OVERLAP = 64

/** Convert a grayscale mask to a binary 0/255 mask (white = inpaint). */
export function binarizeMask(gray: Uint8Array, threshold = 127): Uint8Array {
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] > threshold ? 255 : 0
  return out
}

/** Tight bounding box of all masked (>0) pixels, or null if nothing is masked. */
export function maskBounds(mask: Uint8Array, width: number, height: number): Bounds | null {
  let x0 = width
  let y0 = height
  let x1 = 0
  let y1 = 0
  let any = false
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (mask[row + x] > 0) {
        any = true
        if (x < x0) x0 = x
        if (y < y0) y0 = y
        if (x + 1 > x1) x1 = x + 1
        if (y + 1 > y1) y1 = y + 1
      }
    }
  }
  return any ? { x0, y0, x1, y1 } : null
}

/**
 * Tile origins along one axis covering [start,end) within a dimension of `dim`.
 * Origins are clamped to [0, dim-tile] so every tile is fully in-bounds when the image is
 * larger than a tile; when the image is smaller than a tile, a single origin 0 is returned
 * (the caller pads the crop up to `tile`). Stepping stops as soon as the region is covered.
 */
export function axisOrigins(
  start: number,
  end: number,
  dim: number,
  tile: number,
  stride: number
): number[] {
  const maxOrigin = Math.max(0, dim - tile)
  const origins: number[] = []
  let o = Math.min(Math.max(0, start), maxOrigin)
  for (;;) {
    const clamped = Math.min(Math.max(0, o), maxOrigin)
    if (origins.length === 0 || origins[origins.length - 1] !== clamped) origins.push(clamped)
    if (clamped + tile >= end) break // region fully covered
    if (clamped >= maxOrigin) break // can't advance further
    o = clamped + stride
  }
  return origins
}

/** Build the 2D grid of tiles covering the masked bounding box. */
export function buildTileGrid(
  b: Bounds,
  width: number,
  height: number,
  tile = TILE,
  overlap = OVERLAP
): Tile[] {
  const stride = tile - overlap
  const xs = axisOrigins(b.x0, b.x1, width, tile, stride)
  const ys = axisOrigins(b.y0, b.y1, height, tile, stride)
  const tiles: Tile[] = []
  for (const y of ys) for (const x of xs) tiles.push({ x, y, size: tile })
  return tiles
}

/** Does any masked pixel fall inside this tile's in-bounds area? Empty tiles are skipped. */
export function tileHasMask(
  mask: Uint8Array,
  width: number,
  height: number,
  t: Tile
): boolean {
  const x1 = Math.min(t.x + t.size, width)
  const y1 = Math.min(t.y + t.size, height)
  for (let y = t.y; y < y1; y++) {
    const row = y * width
    for (let x = t.x; x < x1; x++) if (mask[row + x] > 0) return true
  }
  return false
}

/**
 * Linear feather weight in (0,1] for a position within a tile. Pixels near a tile edge get a
 * low weight so that, when two tiles overlap, the weighted average ramps smoothly between them.
 * Border tiles (covered by a single tile) are normalized by their own weight, so the ramp there
 * has no visible effect.
 */
export function featherWeight1D(pos: number, size: number, overlap: number): number {
  if (overlap <= 0) return 1
  const distFromStart = pos + 1
  const distFromEnd = size - pos
  const ramp = Math.min(distFromStart, distFromEnd, overlap + 1)
  return ramp / (overlap + 1)
}

export function featherWeight2D(
  localX: number,
  localY: number,
  size: number,
  overlap: number
): number {
  return featherWeight1D(localX, size, overlap) * featherWeight1D(localY, size, overlap)
}

export interface CompositeAccumulator {
  width: number
  height: number
  /** Per-pixel RGB weighted sums (length = width*height*3). */
  accum: Float32Array
  /** Per-pixel total weight (length = width*height). */
  weight: Float32Array
}

export function createAccumulator(width: number, height: number): CompositeAccumulator {
  return {
    width,
    height,
    accum: new Float32Array(width * height * 3),
    weight: new Float32Array(width * height)
  }
}

/**
 * Accumulate one inpainted tile's RGB into the feathered accumulator, but only at pixels the
 * binary mask marks for inpainting. `tileRgb` is row-major RGB of length size*size*3.
 */
export function accumulateTile(
  acc: CompositeAccumulator,
  binaryMask: Uint8Array,
  tile: Tile,
  tileRgb: Float32Array | Uint8Array,
  overlap = OVERLAP
): void {
  const { width, height, accum, weight } = acc
  const size = tile.size
  for (let ly = 0; ly < size; ly++) {
    const gy = tile.y + ly
    if (gy < 0 || gy >= height) continue
    for (let lx = 0; lx < size; lx++) {
      const gx = tile.x + lx
      if (gx < 0 || gx >= width) continue
      const gi = gy * width + gx
      if (binaryMask[gi] === 0) continue
      const w = featherWeight2D(lx, ly, size, overlap)
      const ti = (ly * size + lx) * 3
      accum[gi * 3] += tileRgb[ti] * w
      accum[gi * 3 + 1] += tileRgb[ti + 1] * w
      accum[gi * 3 + 2] += tileRgb[ti + 2] * w
      weight[gi] += w
    }
  }
}

/**
 * Produce the final RGB image bytes: original pixels everywhere, replaced by the feathered
 * inpaint result only where the mask is set and a tile contributed.
 */
export function finalizeComposite(
  original: Uint8Array,
  binaryMask: Uint8Array,
  acc: CompositeAccumulator
): Uint8Array {
  const { width, height, accum, weight } = acc
  const out = new Uint8Array(original.length)
  out.set(original)
  for (let i = 0; i < width * height; i++) {
    if (binaryMask[i] === 0 || weight[i] === 0) continue
    const w = weight[i]
    out[i * 3] = clamp255(accum[i * 3] / w)
    out[i * 3 + 1] = clamp255(accum[i * 3 + 1] / w)
    out[i * 3 + 2] = clamp255(accum[i * 3 + 2] / w)
  }
  return out
}

function clamp255(v: number): number {
  if (v <= 0) return 0
  if (v >= 255) return 255
  return Math.round(v)
}
