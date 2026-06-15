import { describe, it, expect } from 'vitest'
import { PING_RESPONSE } from './constants'

describe('PING_RESPONSE', () => {
  it('is "pong"', () => {
    expect(PING_RESPONSE).toBe('pong')
  })
})
