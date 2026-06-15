import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { PING_RESPONSE } from '../shared/constants'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Security model (mandatory — see IMPLEMENTATION_PLAN §3): renderer is fully sandboxed,
      // no Node integration, context isolated. All native access goes through the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // Dev: load the Vite dev server. Prod: load the built renderer from disk.
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // Phase 0 IPC: a single typed ping handler proves the main<->preload<->renderer round-trip.
  ipcMain.handle('app:ping', () => PING_RESPONSE)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
