/**
 * End-to-end auto-detect test against the REAL PP-OCRv4 model.
 * Gated behind RUN_MODEL_IT=1 (downloads ~4.7 MB once into <project>/models). Run with:
 *   RUN_MODEL_IT=1 npx vitest run src/main/detect/autoDetector.model.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'

const RUN = process.env.RUN_MODEL_IT === '1'
const W = 640
const H = 360

/** White image with bold black "WATERMARK" text drawn via an SVG overlay. */
async function makeTextFixture(dir: string): Promise<string> {
  const svg = `<svg width="${W}" height="${H}"><rect width="100%" height="100%" fill="white"/>
    <text x="50%" y="55%" font-family="Arial" font-size="64" font-weight="bold"
      text-anchor="middle" fill="black">WATERMARK</text></svg>`
  const p = join(dir, 'text.png')
  await sharp(Buffer.from(svg)).png().toFile(p)
  return p
}

/** Textured (non-flat) background with a FAINT semi-transparent diagonal text watermark. */
async function makeFaintWatermarkFixture(dir: string): Promise<string> {
  const buf = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      buf[i] = Math.max(0, Math.min(255, Math.round(90 + 70 * Math.sin(x / 90))))
      buf[i + 1] = Math.max(0, Math.min(255, Math.round(110 + 60 * Math.sin(y / 70))))
      buf[i + 2] = Math.max(0, Math.min(255, Math.round(130 + 50 * Math.cos((x + y) / 100))))
    }
  }
  const svg = `<svg width="${W}" height="${H}"><text x="50%" y="50%" font-family="Arial" font-size="44" font-weight="bold" text-anchor="middle" fill="white" fill-opacity="0.30" transform="rotate(-25 ${W / 2} ${H / 2})">© WATERMARK</text></svg>`
  const p = join(dir, 'faint.png')
  await sharp(buf, { raw: { width: W, height: H, channels: 3 } })
    .composite([{ input: Buffer.from(svg), blend: 'over' }])
    .png()
    .toFile(p)
  return p
}

describe.runIf(RUN)('autoDetect end-to-end (real PP-OCRv4 model)', () => {
  it('detects a FAINT semi-transparent watermark and builds a generously-covering mask', async () => {
    // Regression for the under-coverage bug: faint watermark must be found AND the mask must be
    // much bigger than the raw shrunk DBNet kernel (adaptive dilation), else inpaint leaves it.
    const { autoDetect } = await import('./autoDetector')
    const dir = await mkdtemp(join(tmpdir(), 'unwater-faint-'))
    try {
      const imagePath = await makeFaintWatermarkFixture(dir)
      const res = await autoDetect(imagePath, undefined, join(process.cwd(), 'models'))
      expect(res.found).toBe(true)

      const base64 = res.maskPng.replace(/^data:image\/png;base64,/, '')
      const { data, info } = await sharp(Buffer.from(base64, 'base64'))
        .raw()
        .toBuffer({ resolveWithObject: true })
      let white = 0
      for (let i = 0; i < info.width * info.height; i++) if (data[i * info.channels] === 255) white++
      // The dilated mask should cover a substantial band (well beyond a thin centerline kernel).
      expect(white).toBeGreaterThan(4000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 600_000)

  it('produces a mask that covers the text and leaves the corners clean', async () => {
    // Import lazily so the heavy model code is only touched when the gate is on.
    const { autoDetect } = await import('./autoDetector')
    const dir = await mkdtemp(join(tmpdir(), 'unwater-det-'))
    try {
      const imagePath = await makeTextFixture(dir)
      const res = await autoDetect(imagePath, undefined, join(process.cwd(), 'models'))
      expect(res.found).toBe(true)
      expect(res.regions.length).toBeGreaterThan(0)

      // Decode the returned mask and check coverage.
      const base64 = res.maskPng.replace(/^data:image\/png;base64,/, '')
      const { data, info } = await sharp(Buffer.from(base64, 'base64'))
        .raw()
        .toBuffer({ resolveWithObject: true })
      expect(info.width).toBe(W)
      expect(info.height).toBe(H)

      const px = (x: number, y: number): number => data[(y * info.width + x) * info.channels]
      // Center (where the text is) should be masked (white).
      expect(px(Math.round(W / 2), Math.round(H / 2))).toBe(255)
      // A corner (clean white background) should NOT be masked.
      expect(px(5, 5)).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 600_000)
})
