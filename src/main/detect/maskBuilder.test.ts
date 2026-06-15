import { describe, it, expect } from 'vitest'
import { binarizeConfidence, dilate, connectedComponents, buildMask } from './maskBuilder'

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
