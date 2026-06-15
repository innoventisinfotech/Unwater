import * as ort from 'onnxruntime-node'
import sharp from 'sharp'
import {
  binarizeMask,
  maskBounds,
  buildTileGrid,
  tileHasMask,
  createAccumulator,
  accumulateTile,
  finalizeComposite,
  TILE,
  OVERLAP,
  type Tile
} from './tiling'

interface RawImage {
  data: Uint8Array
  width: number
  height: number
}

/**
 * Tier-1 inpainting engine: LaMa via onnxruntime-node.
 * The model is a FIXED 512x512, so we tile over the masked region and feather-blend the
 * results back (see ./tiling). CPU execution provider; runs fully in-process and offline.
 */
export class Tier1Engine {
  private session?: ort.InferenceSession
  private imageInput = 'image'
  private maskInput = 'mask'
  private outputName = 'output'

  async load(modelPath: string): Promise<void> {
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu']
    })
    const inputs = this.session.inputNames
    const outputs = this.session.outputNames
    // LaMa exports usually name these "image"/"mask"/"output", but detect to be safe.
    this.maskInput = inputs.find((n) => /mask/i.test(n)) ?? inputs[1] ?? inputs[0]
    this.imageInput = inputs.find((n) => n !== this.maskInput) ?? inputs[0]
    this.outputName = outputs[0]
  }

  get loaded(): boolean {
    return this.session !== undefined
  }

  /**
   * Inpaint `imagePath` using `maskPng` (PNG buffer; white = remove). Returns encoded PNG bytes
   * at the original resolution. `onProgress` reports fractional progress 0..1.
   */
  async inpaint(
    imagePath: string,
    maskPng: Buffer,
    onProgress?: (fraction: number) => void,
    shouldCancel?: () => boolean
  ): Promise<Buffer> {
    if (!this.session) throw new Error('Tier1Engine: model not loaded')

    const img = await this.loadImageRgb(imagePath)
    const mask = await this.loadMaskGray(maskPng, img.width, img.height)
    const binary = binarizeMask(mask)

    const bounds = maskBounds(binary, img.width, img.height)
    if (!bounds) {
      // Nothing masked — return the original image untouched.
      return sharp(img.data, {
        raw: { width: img.width, height: img.height, channels: 3 }
      })
        .png()
        .toBuffer()
    }

    const allTiles = buildTileGrid(bounds, img.width, img.height)
    const tiles = allTiles.filter((t) => tileHasMask(binary, img.width, img.height, t))
    const acc = createAccumulator(img.width, img.height)

    for (let i = 0; i < tiles.length; i++) {
      if (shouldCancel?.()) throw new Error('cancelled')
      const tileRgb = await this.runTile(img, binary, tiles[i])
      accumulateTile(acc, binary, tiles[i], tileRgb, OVERLAP)
      onProgress?.((i + 1) / tiles.length)
    }

    const composited = finalizeComposite(img.data, binary, acc)
    return sharp(Buffer.from(composited.buffer, composited.byteOffset, composited.byteLength), {
      raw: { width: img.width, height: img.height, channels: 3 }
    })
      .png()
      .toBuffer()
  }

  /** Run a single 512 tile through the model and return its inpainted RGB (size*size*3, 0..255). */
  private async runTile(img: RawImage, binary: Uint8Array, t: Tile): Promise<Float32Array> {
    const size = t.size
    const imageData = new Float32Array(size * size * 3)
    const maskData = new Float32Array(size * size)

    // Build NCHW tensors. Sample source with edge-clamping so tiles near/over a border are
    // padded by replication rather than reading out of bounds.
    const plane = size * size
    for (let ly = 0; ly < size; ly++) {
      const sy = clampIndex(t.y + ly, img.height)
      for (let lx = 0; lx < size; lx++) {
        const sx = clampIndex(t.x + lx, img.width)
        const si = (sy * img.width + sx) * 3
        const li = ly * size + lx
        imageData[li] = img.data[si] / 255 // R plane
        imageData[plane + li] = img.data[si + 1] / 255 // G plane
        imageData[2 * plane + li] = img.data[si + 2] / 255 // B plane
        maskData[li] = binary[sy * img.width + sx] > 0 ? 1 : 0
      }
    }

    const imageTensor = new ort.Tensor('float32', imageData, [1, 3, size, size])
    const maskTensor = new ort.Tensor('float32', maskData, [1, 1, size, size])
    const result = await this.session!.run({
      [this.imageInput]: imageTensor,
      [this.maskInput]: maskTensor
    })
    const out = result[this.outputName].data as Float32Array

    // Convert NCHW → HWC (size*size*3) and normalize to 0..255 if the model emitted 0..1.
    const hwc = new Float32Array(size * size * 3)
    const scale = detectScale(out)
    for (let p = 0; p < plane; p++) {
      hwc[p * 3] = out[p] * scale
      hwc[p * 3 + 1] = out[plane + p] * scale
      hwc[p * 3 + 2] = out[2 * plane + p] * scale
    }
    return hwc
  }

  private async loadImageRgb(path: string): Promise<RawImage> {
    const { data, info } = await sharp(path)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height }
  }

  private async loadMaskGray(maskPng: Buffer, width: number, height: number): Promise<Uint8Array> {
    const data = await sharp(maskPng)
      .resize(width, height, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer()
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
}

function clampIndex(v: number, dim: number): number {
  if (v < 0) return 0
  if (v >= dim) return dim - 1
  return v
}

/** LaMa exports differ: some emit 0..255, some 0..1. Pick a scale from the observed range. */
function detectScale(out: Float32Array): number {
  let max = 0
  for (let i = 0; i < out.length; i += 997) if (out[i] > max) max = out[i] // sparse sample
  return max <= 1.5 ? 255 : 1
}

export { TILE }
