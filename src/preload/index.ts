import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  Channels,
  type InputFile,
  type JobProgress,
  type ModelStatus,
  type ProcessImageReq,
  type ProcessResult
} from '../shared/types'

/**
 * The typed bridge exposed to the renderer as `window.api.*`.
 * This is the ONLY surface the sandboxed renderer may use to reach the main process.
 */
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke(Channels.ping),

  listModels: (): Promise<ModelStatus[]> => ipcRenderer.invoke(Channels.modelsList),

  openInput: (): Promise<InputFile | null> => ipcRenderer.invoke(Channels.dialogOpenInput),

  chooseOutputDir: (): Promise<string | null> => ipcRenderer.invoke(Channels.dialogChooseOutputDir),

  processImage: (req: ProcessImageReq): Promise<ProcessResult> =>
    ipcRenderer.invoke(Channels.jobProcessImage, req),

  cancelJob: (jobId: string): Promise<void> => ipcRenderer.invoke(Channels.jobCancel, jobId),

  /** Subscribe to job progress; returns an unsubscribe function. */
  onProgress: (cb: (p: JobProgress) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, p: JobProgress): void => cb(p)
    ipcRenderer.on(Channels.jobProgress, listener)
    return () => ipcRenderer.removeListener(Channels.jobProgress, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
