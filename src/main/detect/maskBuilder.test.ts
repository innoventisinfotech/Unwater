import { describe, it, expect } from 'vitest'
import {
  binarizeConfidence,
  dilate,
  connectedComponents,
  buildMask,
  adaptiveDilateRadius
} from './maskBuilder'

describe('binarizeConfidence', () => {
  it('thresholds 0..255 confidence to 0/255', () => {
    expect(Array.from(binarizeConfidence(new Uint8Array([0, 76, 78, 200]), 77))).toEqual([0, 0, 255, 255])
  })
})

describe('dilate', () => {
  it('expands a single set pixel by the given radius (square SE)', () => {
    // 5x5 with center pixel set; radius 1 → 3x3 block set
    const W = 5
    const H = 5
    const m = new Uint8Array(W * H)
    m[2 * W + 2] = 255
    const out = dilate(m, W, H, 1)
    let count = 0
    for (const v of out) if (v === 255) count++
    expect(count).toBe(9)
    expect(out[2 * W + 2]).toBe(255)
    expect(out[1 * W + 1]).toBe(255)
    expect(out[0 * W + 0]).toBe(0) // outside the 3x3
  })
})

describe('connectedComponents', () => {
  it('finds separate blobs and their bounding boxes', () => {
    const W = 6
    const H = 3
    const m = new Uint8Array(W * H)
    // blob A: (0,0),(1,0)  blob B: (4,2)
    m[0] = 255
    m[1] = 255
    m[2 * W + 4] = 255
    const { boxes } = connectedComponents(m, W, H)
    expect(boxes.length).toBe(2)
    const a = boxes.find((b) => b.x0 === 0)!
    expect(a).toMatchObject({ x0: 0, y0: 0, x1: 2, y1: 1, area: 2 })
    const b = boxes.find((b) => b.x0 === 4)!
    expect(b).toMatchObject({ x0: 4, y0: 2, x1: 5, y1: 3, area: 1 })
  })
})

describe('adaptiveDilateRadius', () => {
  it('derives the radius from a region\'s thickness (area / longest side) * factor', () => {
    // a 40x4 horizontal bar: thickness = 160/40 = 4 → 4*1.5 = 6
    expect(adaptiveDilateRadius({ x0: 0, y0: 0, x1: 40, y1: 4, area: 160 }, 1.5, 4, 64)).toBe(6)
  })

  it('clamps to the min and max bounds', () => {
    expect(adaptiveDilateRadius({ x0: 0, y0: 0, x1: 100, y1: 1, area: 100 }, 1.5, 8, 64)).toBe(8) // thin → min
    expect(adaptiveDilateRadius({ x0: 0, y0: 0, x1: 10, y1: 10, area: 100 }, 1.5, 4, 12)).toBe(12) // thick → max
  })
})

describe('buildMask adaptive dilation', () => {
  it('expands a thin detected bar well beyond its own thickness when no fixed radius is given', () => {
    const W = 80
    const H = 40
    const conf = new Uint8Array(W * H)
    // a 40-wide x 4-tall bar at y=18..21, x=20..59 (area 160, thickness 4 → radius 6)
    for (let y = 18; y < 22; y++) for (let x = 20; x < 60; x++) conf[y * W + x] = 200
    const res = buildMask(conf, W, H, { threshold: 77, minArea: 16, kind: 'text', expandFactor: 1.5 })
    expect(res.found).toBe(true)
    // bar center is masked
    expect(res.mask[20 * W + 40]).toBe(255)
    // 6px above the bar top (y=18-6=12) is now masked thanks to adaptive dilation
    expect(res.mask[12 * W + 40]).toBe(255)
    // far above (y=5) is NOT masked
    expect(res.mask[5 * W + 40]).toBe(0)
  })
})

describe('buildMask', () => {
  it('returns found=false and an empty mask when nothing passes threshold', () => {
    const W = 8
    const H = 8
    const conf = new Uint8Array(W * H) // all zero
    const res = buildMask(conf, W, H, { threshold: 77, dilateRadius: 1, minArea: 2, kind: 'text' })
    expect(res.found).toBe(false)
    expect(res.regions).toEqual([])
    expect(res.mask.every((v) => v === 0)).toBe(true)
    expect(res.mask.length).toBe(W * H)
  })

  it('drops tiny noise below minArea but keeps a real region (with dilation padding)', () => {
    const W = 20
    const H = 20
    const conf = new Uint8Array(W * H)
    // a 4x4 solid block of high confidence at (8,8)-(11,11) = area 16
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) conf[y * W + x] = 200
    // a single stray pixel of noise far away
    conf[0] = 200
    const res = buildMask(conf, W, H, { threshold: 77, dilateRadius: 2, minArea: 8, kind: 'text' })
    expect(res.found).toBe(true)
    expect(res.regions.length).toBe(1)
    expect(res.regions[0].kind).toBe('text')
    // noise pixel was below minArea → not in mask
    expect(res.mask[0]).toBe(0)
    // the real block is masked
    expect(res.mask[9 * W + 9]).toBe(255)
    // dilation expanded it outward by ~radius
    expect(res.mask[7 * W + 9]).toBe(255)
  })
})
