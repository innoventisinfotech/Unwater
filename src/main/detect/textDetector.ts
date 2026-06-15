import * as ort from 'onnxruntime-node'
import sharp from 'sharp'

const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

/** Compute DBNet input dims: scale so the long side ≤ maxSide, round each to a multiple of 32 (min 32). */
export function dbInputSize(
  width: number,
  height: number,
  maxSide: number
): { w: number; h: number } {
  const longSide = Math.max(width, height)
  const scale = longSide > maxSide ? maxSide / longSide : 1
  const round32 = (v: number): number => Math.max(32, Math.round((v * scale) / 32) * 32)
  return { w: round32(width), h: round32(height) }
}

/**
 * RapidOCR PP-OCRv4 DBNet text detector. Returns a SOURCE-resolution grayscale (0..255)
 * text-probability map suitable for maskBuilder. Single ONNX graph, CPU, in-process.
 */
export class TextDetector {
  private session?: ort.InferenceSession
  private inputName = 'x'
  private outputName = 'sigmoid_0.tmp_0'
  private readonly maxSide = 960

  async load(modelPath: string): Promise<void> {
    this.session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })
    this.inputName = this.session.inputNames[0]
    this.outputName = this.session.outputNames[0]
  }

  get loaded(): boolean {
    return this.session !== undefined
  }

  /** @returns { conf, width, height } where conf is the source-res probability map (0..255). */
  async detect(imagePath: string): Promise<{ conf: Uint8Array; width: number; height: number }> {
    if (!this.session) throw new Error('TextDetector: model not loaded')

    const meta = await sharp(imagePath).metadata()
    const srcW = meta.width ?? 0
    const srcH = meta.height ?? 0
    const { w, h } = dbInputSize(srcW, srcH, this.maxSide)

    // Resize to the network input and read raw RGB.
    const { data } = await sharp(imagePath)
      .removeAlpha()
      .resize(w, h, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })

    // HWC uint8 → NCHW float32, normalized.
    const plane = w * h
    const input = new Float32Array(3 * plane)
    for (let i = 0; i < plane; i++) {
      input[i] = (data[i * 3] / 255 - MEAN[0]) / STD[0]
      input[plane + i] = (data[i * 3 + 1] / 255 - MEAN[1]) / STD[1]
      input[2 * plane + i] = (data[i * 3 + 2] / 255 - MEAN[2]) / STD[2]
    }

    const tensor = new ort.Tensor('float32', input, [1, 3, h, w])
    const result = await this.session.run({ [this.inputName]: tensor })
    const probF = result[this.outputName].data as Float32Array // [1,1,h,w] in 0..1

    // prob (0..1) → grayscale bytes, then resize back to source resolution.
    const probBytes = new Uint8Array(plane)
    for (let i = 0; i < plane; i++) {
      probBytes[i] = Math.round(Math.min(Math.max(probF[i], 0), 1) * 255)
    }
    const { data: resized, info } = await sharp(Buffer.from(probBytes), {
      raw: { width: w, height: h, channels: 1 }
    })
      .resize(srcW, srcH, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })

    // sharp may emit the resized raw with >1 channel; de-interleave to a single-channel map.
    const ch = info.channels
    const conf = new Uint8Array(srcW * srcH)
    if (ch === 1) {
      conf.set(resized.subarray(0, srcW * srcH))
    } else {
      for (let i = 0; i < srcW * srcH; i++) conf[i] = resized[i * ch]
    }
    return { conf, width: srcW, height: srcH }
  }
}
