import { dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import sharp from 'sharp'
import {
  Channels,
  type AutoDetectReq,
  type AutoDetectResult,
  type InputFile,
  type JobProgress,
  type ModelStatus,
  type ProcessImageReq,
  type ProcessResult
} from '../../shared/types'
import { PING_RESPONSE } from '../../shared/constants'
import { getModel } from '../models/registry'
import { ensureModel, probeFile } from '../models/manager'
import { getModelsDir } from '../models/paths'
import { Tier1Engine } from '../engines/tier1'
import { autoDetect } from '../detect/autoDetector'
import { JobQueue } from '../jobs/queue'

const queue = new JobQueue()

// Lazily-loaded Tier-1 engine; the ONNX session is reused across jobs.
let tier1: Tier1Engine | undefined
let tier1Path = ''

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
}

function emit(event: IpcMainInvokeEvent, progress: JobProgress): void {
  event.sender.send(Channels.jobProgress, progress)
}

async function toInputFile(path: string): Promise<InputFile> {
  const bytes = await readFile(path)
  const meta = await sharp(bytes).metadata()
  const mime = MIME[extname(path).toLowerCase()] ?? 'image/png'
  return {
    path,
    dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
    width: meta.width ?? 0,
    height: meta.height ?? 0
  }
}

async function ensureTier1(): Promise<Tier1Engine> {
  const modelPath = join(getModelsDir(), getModel('lama').files[0].fileName)
  if (tier1 && tier1.loaded && tier1Path === modelPath) return tier1
  tier1 = new Tier1Engine()
  await tier1.load(modelPath)
  tier1Path = modelPath
  return tier1
}

export function registerIpc(): void {
  ipcMain.handle(Channels.ping, () => PING_RESPONSE)

  ipcMain.handle(Channels.modelsList, async (): Promise<ModelStatus[]> => {
    const lama = getModel('lama')
    const probe = await probeFile(lama.files[0], getModelsDir())
    return [{ id: 'lama', installed: probe.installed, valid: probe.valid, sizeBytes: probe.sizeBytes }]
  })

  ipcMain.handle(Channels.dialogOpenInput, async (): Promise<InputFile | null> => {
    const res = await dialog.showOpenDialog({
      title: 'Choose an image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    })
    if (res.canceled || res.filePaths.length === 0) return null
    return toInputFile(res.filePaths[0])
  })

  ipcMain.handle(Channels.dialogChooseOutputDir, async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({
      title: 'Choose an output folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle(Channels.jobCancel, (_e, jobId: string) => {
    queue.cancel(jobId)
  })

  ipcMain.handle(
    Channels.detectAuto,
    async (event, req: AutoDetectReq): Promise<AutoDetectResult> => {
      queue.begin(req.jobId)
      try {
        emit(event, { jobId: req.jobId, phase: 'detect', current: 0, total: 100, message: 'Detecting watermark' })
        const result = await autoDetect(req.inputPath, (f) =>
          emit(event, {
            jobId: req.jobId,
            phase: 'download',
            current: Math.round(f * 100),
            total: 100,
            message: 'Downloading detector model'
          })
        )
        emit(event, { jobId: req.jobId, phase: 'detect', current: 100, total: 100, message: 'Detection complete' })
        return result
      } finally {
        queue.end(req.jobId)
      }
    }
  )

  ipcMain.handle(
    Channels.jobProcessImage,
    async (event, req: ProcessImageReq): Promise<ProcessResult> => {
      queue.begin(req.jobId)
      try {
        // 1. Ensure the Tier-1 model is downloaded + verified (only network call the app makes).
        emit(event, { jobId: req.jobId, phase: 'download', current: 0, total: 100, message: 'Preparing model' })
        // Phase 1: Tier-1 LaMa only. (MI-GAN / Tier-2 routing arrives in later phases.)
        await ensureModel(getModel('lama'), {
          destDir: getModelsDir(),
          onProgress: (f) =>
            emit(event, {
              jobId: req.jobId,
              phase: 'download',
              current: Math.round(f * 100),
              total: 100,
              message: 'Downloading model'
            })
        })

        // 2. Load engine + run tiled inpaint.
        const engine = await ensureTier1()
        const maskBuf = Buffer.from(req.maskPng.replace(/^data:image\/\w+;base64,/, ''), 'base64')
        const pngOut = await engine.inpaint(
          req.inputPath,
          maskBuf,
          (f) =>
            emit(event, {
              jobId: req.jobId,
              phase: 'inpaint',
              current: Math.round(f * 100),
              total: 100,
              message: 'Removing watermark'
            }),
          () => queue.isCancelled(req.jobId)
        )

        // 3. Write the result next to the input (or to a chosen dir).
        const outDir = req.outputDir ?? dirname(req.inputPath)
        const stem = basename(req.inputPath, extname(req.inputPath))
        const outputPath = join(outDir, `${stem}-unwater.png`)
        await writeFile(outputPath, pngOut)

        return { outputPath, outputDataUrl: `data:image/png;base64,${pngOut.toString('base64')}` }
      } catch (err) {
        if (queue.isCancelled(req.jobId)) throw new Error('Job cancelled', { cause: err })
        throw err
      } finally {
        queue.end(req.jobId)
      }
    }
  )
}
