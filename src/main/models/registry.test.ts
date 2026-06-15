import { describe, it, expect } from 'vitest'
import { getModel } from './registry'

describe('registry', () => {
  it('has the LaMa Tier-1 model', () => {
    expect(getModel('lama').files[0].fileName).toBe('lama_fp32.onnx')
  })

  it('has the PP-OCRv4 text detector with verified checksum and size', () => {
    const m = getModel('ppocr_det')
    expect(m.tier).toBe('tier1')
    expect(m.license).toMatch(/Apache-2\.0/)
    expect(m.files[0]).toMatchObject({
      fileName: 'ppocrv4_det.onnx',
      sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
      sizeBytes: 4745517
    })
  })
})
