import { describe, it, expect } from 'vitest'
import { dbInputSize } from './textDetector'

describe('dbInputSize', () => {
  it('rounds dimensions to a multiple of 32 and caps the long side at maxSide', () => {
    // 1000x500, maxSide 960 → scale 0.96 → 960x480, both already /32
    expect(dbInputSize(1000, 500, 960)).toEqual({ w: 960, h: 480 })
  })

  it('rounds to the nearest multiple of 32 for small images', () => {
    // 100x70 under maxSide → 96x64
    expect(dbInputSize(100, 70, 960)).toEqual({ w: 96, h: 64 })
  })

  it('never returns less than 32', () => {
    expect(dbInputSize(10, 5, 960)).toEqual({ w: 32, h: 32 })
  })
})
