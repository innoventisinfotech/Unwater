import { contextBridge, ipcRenderer } from 'electron'

/**
 * The typed bridge exposed to the renderer as `window.api.*`.
 * This is the ONLY surface the sandboxed renderer may use to reach the main process.
 * It grows one method group per phase.
 */
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('app:ping')
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
