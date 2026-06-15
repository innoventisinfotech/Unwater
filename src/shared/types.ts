/**
 * IPC contract shared between main and renderer.
 * Channels are typed here first, then implemented in main, then exposed in preload.
 */

export type Tier = 'tier1' | 'tier2'
export type ModelId = 'lama' | 'migan' | 'powerpaint' | 'sdxl'

/** A single downloadable file belonging to a model. */
export interface ModelFile {
  url: string
  sha256: string
  sizeBytes: number
  /** Filename within the models cache dir (not an absolute path). */
  fileName: string
}

export interface ModelEntry {
  id: ModelId
  tier: Tier
  license: string
  /** Fixed square input size for tiled ONNX models (e.g. LaMa = 512). */
  inputSize?: number
  files: ModelFile[]
}

/** Install status reported to the UI for a model. */
export interface ModelStatus {
  id: ModelId
  installed: boolean
  valid: boolean
  sizeBytes: number
}

/** A single progress update emitted during a long-running job or download. */
export interface JobProgress {
  jobId: string
  phase: string
  /** 0..total — use fractional/percent semantics consistently per phase. */
  current: number
  total: number
  message?: string
}

export interface ProcessImageReq {
  jobId: string
  inputPath: string
  /** PNG mask as a base64 data string (white = inpaint, black = keep), source dimensions. */
  maskPng: string
  tier: Tier
  model: ModelId
  /** Optional output directory; defaults to alongside the input. */
  outputDir?: string
}

export interface ProcessResult {
  outputPath: string
  /** PNG data URL of the result, for immediate before/after display in the renderer. */
  outputDataUrl: string
}

/** A picked input file, with a displayable data URL and natural dimensions. */
export interface InputFile {
  path: string
  dataUrl: string
  width: number
  height: number
}

/** IPC channel names — single source of truth to avoid stringly-typed drift. */
export const Channels = {
  ping: 'app:ping',
  modelsList: 'models:list',
  dialogOpenInput: 'dialog:openInput',
  dialogChooseOutputDir: 'dialog:chooseOutputDir',
  jobProcessImage: 'job:processImage',
  jobCancel: 'job:cancel',
  jobProgress: 'job:progress'
} as const
