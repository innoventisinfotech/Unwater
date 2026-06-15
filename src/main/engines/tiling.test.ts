import { describe, it, expect } from 'vitest'
import {
  binarizeMask,
  maskBounds,
  axisOrigins,
  buildTileGrid,
  tileHasMask,
  featherWeight1D,
  createAccumulator,
  accumulateTile,
  finalizeComposite,
  type Tile
} from './tiling'

describe('binarizeMask', () => {
  it('thresholds to 0/255 at >127', () => {
    const out = binarizeMask(new Uint8Array([0, 127, 128, 200, 255]))
    expect(Array.from(out)).toEqual([0, 0, 255, 255, 255])
  })
})

describe('maskBounds', () => {
  it('returns null when nothing is masked', () => {
    expect(maskBounds(new Uint8Array(16), 4, 4)).toBeNull()
  })

  it('returns the tight half-open box of masked pixels', () => {
    // 4x4 with a single masked pixel at (2,1)
    const m = new Uint8Array(16)
    m[1 * 4 + 2] = 255
    expect(maskBounds(m, 4, 4)).toEqual({ x0: 2, y0: 1, x1: 3, y1: 2 })
  })
})

describe('axisOrigins', () => {
  it('returns a single origin 0 when the image is smaller than a tile', () => {
    expect(axisOrigins(0, 300, 300, 512, 448)).toEqual([0])
  })

  it('keeps every origin within [0, dim-tile]', () => {
    const dim = 2000
    const tile = 512
    const origins = axisOrigins(100, 1500, dim, tile, tile - 64)
    for (const o of origins) {
      expect(o).toBeGreaterThanOrEqual(0)
      expect(o).toBeLessThanOrEqual(dim - tile)
    }
  })

  it('covers the whole requested region', () => {
    const dim = 2000
    const tile = 512
    const start = 100
    const end = 1500
    const origins = axisOrigins(start, end, dim, tile, tile - 64)
    // first tile starts at/before the region start
    expect(origins[0]).toBeLessThanOrEqual(start)
    // last tile reaches the region end
    const last = origins[origins.length - 1]
    expect(last + tile).toBeGreaterThanOrEqual(end)
    // no gaps: consecutive tiles overlap (next origin within a tile of the previous)
    for (let i = 1; i < origins.length; i++) {
      expect(origins[i]).toBeLessThanOrEqual(origins[i - 1] + tile)
    }
  })

  it('uses one tile when a single tile already covers the region', () => {
    expect(axisOrigins(100, 300, 2000, 512, 448)).toEqual([100])
  })
})

describe('buildTileGrid', () => {
  it('builds a single tile for a small fully-masked image', () => {
    const tiles = buildTileGrid({ x0: 0, y0: 0, x1: 300, y1: 200 }, 300, 200)
    expect(tiles).toEqual([{ x: 0, y: 0, size: 512 }])
  })

  it('builds a grid covering a region in a large image', () => {
    const tiles = buildTileGrid({ x0: 0, y0: 0, x1: 1200, y1: 700 }, 2000, 1000)
    expect(tiles.length).toBeGreaterThan(1)
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0)
      expect(t.y).toBeGreaterThanOrEqual(0)
      expect(t.x).toBeLessThanOrEqual(2000 - 512)
      expect(t.y).toBeLessThanOrEqual(1000 - 512)
    }
  })
})

describe('tileHasMask', () => {
  const width = 1024
  const height = 1024
  const mask = new Uint8Array(width * height)
  mask[10 * width + 10] = 255 // a single masked pixel near top-left

  it('is true for a tile containing a masked pixel', () => {
    const t: Tile = { x: 0, y: 0, size: 512 }
    expect(tileHasMask(mask, width, height, t)).toBe(true)
  })

  it('is false for a tile with no masked pixels', () => {
    const t: Tile = { x: 512, y: 512, size: 512 }
    expect(tileHasMask(mask, width, height, t)).toBe(false)
  })
})

describe('featherWeight1D', () => {
  it('peaks at the interior and is smaller at the edges', () => {
    const size = 512
    const overlap = 64
    const edge = featherWeight1D(0, size, overlap)
    const mid = featherWeight1D(256, size, overlap)
    expect(edge).toBeGreaterThan(0)
    expect(edge).toBeLessThan(mid)
    expect(mid).toBe(1)
  })

  it('is symmetric about the center', () => {
    const size = 512
    const overlap = 64
    expect(featherWeight1D(5, size, overlap)).toBeCloseTo(featherWeight1D(size - 1 - 5, size, overlap))
  })

  it('is always 1 when there is no overlap', () => {
    expect(featherWeight1D(0, 100, 0)).toBe(1)
  })
})

describe('composite (accumulate + finalize)', () => {
  // A 3x3 image, fully covered by one 3x3 "tile".
  const width = 3
  const height = 3
  const original = new Uint8Array([
    // r,g,b per pixel, all gray 100
    100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
    100, 100, 100, 100, 100, 100, 100, 100, 100
  ])

  it('leaves unmasked pixels exactly unchanged', () => {
    const mask = new Uint8Array(9)
    mask[4] = 255 // only the center pixel is masked
    const acc = createAccumulator(width, height)
    // tile fills every pixel with 200, but only the masked one should be written
    const tileRgb = new Float32Array(width * height * 3).fill(200)
    accumulateTile(acc, mask, { x: 0, y: 0, size: width }, tileRgb, 0)
    const out = finalizeComposite(original, mask, acc)

    for (let i = 0; i < 9; i++) {
      if (i === 4) {
        expect(out[i * 3]).toBe(200)
      } else {
        expect(out[i * 3]).toBe(100)
        expect(out[i * 3 + 1]).toBe(100)
        expect(out[i * 3 + 2]).toBe(100)
      }
    }
  })

  it('reproduces tile values for a fully-masked single tile (no feather distortion)', () => {
    const mask = new Uint8Array(9).fill(255)
    const acc = createAccumulator(width, height)
    const tileRgb = new Float32Array(width * height * 3)
    for (let i = 0; i < tileRgb.length; i++) tileRgb[i] = (i % 3) === 0 ? 50 : 150
    accumulateTile(acc, mask, { x: 0, y: 0, size: width }, tileRgb, 0)
    const out = finalizeComposite(original, mask, acc)
    for (let i = 0; i < 9; i++) {
      expect(out[i * 3]).toBe(50)
      expect(out[i * 3 + 1]).toBe(150)
      expect(out[i * 3 + 2]).toBe(150)
    }
  })

  it('averages two overlapping tiles by their feather weights', () => {
    const mask = new Uint8Array(9).fill(255)
    const acc = createAccumulator(width, height)
    const tileA = new Float32Array(width * height * 3).fill(0)
    const tileB = new Float32Array(width * height * 3).fill(255)
    accumulateTile(acc, mask, { x: 0, y: 0, size: width }, tileA, 1)
    accumulateTile(acc, mask, { x: 0, y: 0, size: width }, tileB, 1)
    const out = finalizeComposite(original, mask, acc)
    // equal weights at every pixel → exact average of 0 and 255
    for (let i = 0; i < 9; i++) expect(out[i * 3]).toBe(128)
  })
})
