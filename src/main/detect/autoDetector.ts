import sharp from 'sharp'
import type { AutoDetectResult } from '../../shared/types'
import { getModel } from '../models/registry'
import { ensureModel } from '../models/manager'
import { getModelsDir } from '../models/paths'
import { TextDetector } from './textDetector'
import { buildMask } from './maskBuilder'

// Reuse a single loaded detector across calls.
let textDetector: TextDetector | undefined

async function ensureTextDetector(
  destDir: string,
  onProgress?: (f: number) => void
): Promise<TextDetector> {
  const modelPath = await ensureModel(getModel('ppocr_det'), { destDir, onProgress })
  if (!textDetector || !textDetector.loaded) {
    textDetector = new TextDetector()
    await textDetector.load(modelPath)
  }
  return textDetector
}

/**
 * Auto-detect text watermarks in an image and return a white-on-black PNG mask (base64 data URL)
 * at source resolution, plus the detected regions. `onDownload` reports model-download progress.
 * `modelsDir` defaults to the app's project-local models dir; tests pass it explicitly so the
 * detector can run outside the Electron runtime.
 */
export async function autoDetect(
  imagePath: string,
  onDownload?: (f: number) => void,
  modelsDir?: string
): Promise<AutoDetectResult> {
  const destDir = modelsDir ?? getModelsDir()
  const detector = await ensureTextDetector(destDir, onDownload)
  const { conf, width, height } = await detector.detect(imagePath)

  const { mask, regions, found } = buildMask(conf, width, height, {
    threshold: 77, // ≈ 0.3 * 255
    dilateRadius: Math.max(2, Math.round(Math.min(width, height) * 0.004)),
    minArea: Math.max(16, Math.round(width * height * 0.00002)),
    kind: 'text'
  })

  if (!found) {
    return { maskPng: '', regions: [], found: false }
  }

  const png = await sharp(Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength), {
    raw: { width, height, channels: 1 }
  })
    .png()
    .toBuffer()

  return {
    maskPng: `data:image/png;base64,${png.toString('base64')}`,
    regions,
    found: true
  }
}
