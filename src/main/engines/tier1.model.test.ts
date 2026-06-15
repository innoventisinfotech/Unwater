/**
 * End-to-end engine test against the REAL LaMa model.
 *
 * Gated behind RUN_MODEL_IT=1 because it downloads ~205 MB (once) into <project>/models and
 * runs CPU inference — too heavy for the default `npm test`. Run with:
 *   RUN_MODEL_IT=1 npx vitest run src/main/engines/tier1.model.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { Tier1Engine } from './tier1'
import { ensureModel } from '../models/manager'
import { getModel } from '../models/registry'

const RUN = process.env.RUN_MODEL_IT === '1'
const MODELS_DIR = join(process.cwd(), 'models')

const W = 600
const H = 400

/** Build a smooth gradient image with a solid black "watermark" rectangle in the middle. */
async function makeFixture(): Promise<{ imagePath: string; maskPng: Buffer; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'unwater-it-'))
  const rgb = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      rgb[i] = Math.round((x / W) * 255)
      rgb[i + 1] = Math.round((y / H) * 255)
      rgb[i + 2] = 128
    }
  }
  // Watermark: black box [200..400) x [150..250)
  for (let y = 150; y < 250; y++) {
    for (let x = 200; x < 400; x++) {
      const i = (y * W + x) * 3
      rgb[i] = rgb[i + 1] = rgb[i + 2] = 0
    }
  }
  const imagePath = join(dir, 'fixture.png')
  await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toFile(imagePath)

  // Mask: white over the watermark box, black elsewhere.
  const mask = Buffer.alloc(W * H, 0)
  for (let y = 150; y < 250; y++) for (let x = 200; x < 400; x++) mask[y * W + x] = 255
  const maskPng = await sharp(mask, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer()

  return { imagePath, maskPng, dir }
}

describe.runIf(RUN)('Tier1Engine end-to-end (real LaMa model)', () => {
  let engine: Tier1Engine

  beforeAll(async () => {
    const modelPath = await ensureModel(getModel('lama'), { destDir: MODELS_DIR })
    engine = new Tier1Engine()
    await engine.load(modelPath)
  }, 600_000)

  it('preserves dimensions, leaves unmasked pixels unchanged, and fills the masked region', async () => {
    const { imagePath, maskPng, dir } = await makeFixture()
    try {
      const outPng = await engine.inpaint(imagePath, maskPng)
      const { data, info } = await sharp(outPng).raw().toBuffer({ resolveWithObject: true })

      // 1. Original resolution preserved.
      expect(info.width).toBe(W)
      expect(info.height).toBe(H)
      expect(info.channels).toBe(3)

      // 2. A pixel far from the mask is byte-identical to the original gradient.
      const px = (x: number, y: number) => (y * W + x) * info.channels
      const corner = px(10, 10)
      expect(data[corner]).toBe(Math.round((10 / W) * 255))
      expect(data[corner + 1]).toBe(Math.round((10 / H) * 255))
      expect(data[corner + 2]).toBe(128)

      // 3. The masked region is no longer the black watermark (it got inpainted).
      const center = px(300, 200)
      const filledLuma = data[center] + data[center + 1] + data[center + 2]
      expect(filledLuma).toBeGreaterThan(30)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 600_000)
})
