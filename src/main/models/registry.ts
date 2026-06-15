import type { ModelEntry, ModelId } from '../../shared/types'

/**
 * Hardcoded model registry. Only permissively licensed models (see THIRD_PARTY_LICENSES.md).
 * Tier-2 models (PowerPaint/SDXL) are downloaded by IOPaint itself in Phase 5 and are not
 * listed here as direct downloads.
 */
export const MODEL_REGISTRY: Record<'lama' | 'ppocr_det', ModelEntry> = {
  lama: {
    id: 'lama',
    tier: 'tier1',
    license: 'Apache-2.0 (LaMa) — ONNX export from Carve/LaMa-ONNX',
    // LaMa ONNX is a FIXED 512x512, opset-17 model — the engine MUST tile.
    inputSize: 512,
    files: [
      {
        url: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
        sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
        sizeBytes: 205_000_000, // approximate; real size comes from the response header
        fileName: 'lama_fp32.onnx'
      }
    ]
  },
  ppocr_det: {
    id: 'ppocr_det',
    tier: 'tier1',
    license: 'Apache-2.0 (RapidOCR PP-OCRv4 detection, converted from PaddleOCR)',
    files: [
      {
        url: 'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx',
        sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
        sizeBytes: 4745517,
        fileName: 'ppocrv4_det.onnx'
      }
    ]
  }
}

export function getModel(id: ModelId): ModelEntry {
  const entry = (MODEL_REGISTRY as Record<string, ModelEntry | undefined>)[id]
  if (!entry) throw new Error(`Unknown or not-yet-registered model: ${id}`)
  return entry
}
