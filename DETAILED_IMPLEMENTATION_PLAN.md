# Detailed Implementation Plan — Unwater (Execution Playbook)

> Companion to `IMPLEMENTATION_PLAN.md`. That file is the **spec** (what/why); this is the
> **playbook** (exact how). Work top-to-bottom. Every task is a checkbox. Do not start a
> phase until the previous phase's "Phase gate" passes. All code below is a starting skeleton
> — implement, don't just paste; keep it typed and tested.

---

## 0. Conventions for this document
- `[ ]` = a discrete, commit-sized task.
- **Phase gate** = the demoable result that must work before moving on.
- File paths are relative to repo root.
- TypeScript is **strict**. No `any` without a `// reason:` comment.
- Every IPC channel is typed in `src/shared/types.ts` first, then implemented in main, then exposed in preload.

---

## 1. Prerequisites & toolchain
- [ ] Node.js LTS (≥ 20), npm ≥ 10.
- [ ] Python 3.11 (for the sidecar, Phase 5 only) — used at build time, never shipped as source.
- [ ] Git, plus platform build tools: Xcode CLT (macOS), Visual Studio Build Tools / windows-build-tools (Windows) for native module compilation.
- [ ] Verify `npx electron-rebuild` works for native modules against the Electron version.

---

## PHASE 0 — Scaffold

### Tasks
- [ ] `npm create @quick-start/electron@latest unwater -- --template react-ts` (electron-vite React+TS), or scaffold electron-vite manually.
- [ ] Add Tailwind: `npm i -D tailwindcss postcss autoprefixer && npx tailwindcss init -p`; wire `index.css`.
- [ ] Add tooling: ESLint + Prettier + Vitest.
- [ ] Lock the security model in the window config.
- [ ] Implement a typed `window.api.ping()` round-trip to prove preload IPC.

### `package.json` (scripts + core deps)
```jsonc
{
  "name": "unwater",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "tsc --noEmit && electron-vite build",
    "lint": "eslint . --ext .ts,.tsx",
    "format": "prettier --write .",
    "test": "vitest run",
    "package": "npm run build && electron-builder",
    "postinstall": "electron-builder install-app-deps"
  },
  "dependencies": {
    "onnxruntime-node": "*",
    "sharp": "*",
    "fluent-ffmpeg": "*",
    "ffmpeg-static": "*",
    "ffprobe-static": "*",
    "systeminformation": "*",
    "electron-updater": "*"
  },
  "devDependencies": {
    "electron": "*", "electron-vite": "*", "electron-builder": "*",
    "typescript": "*", "vitest": "*",
    "react": "*", "react-dom": "*",
    "tailwindcss": "*", "postcss": "*", "autoprefixer": "*"
  }
}
```
> Pin exact versions once installed; `*` here just lists intent.

### `src/main/index.ts` (window + security)
```ts
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'

function createWindow() {
  const win = new BrowserWindow({
    width: 1200, height: 800, show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win.show())
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  ipcMain.handle('app:ping', () => 'pong')
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
```

### `src/preload/index.ts` (typed bridge)
```ts
import { contextBridge, ipcRenderer } from 'electron'
const api = {
  ping: () => ipcRenderer.invoke('app:ping') as Promise<string>
  // grows phase by phase
}
contextBridge.exposeInMainWorld('api', api)
export type Api = typeof api
```
Add `src/renderer/env.d.ts`: `interface Window { api: import('../preload').Api }`.

### Phase gate
- [ ] `npm run dev` opens a window on Win + macOS; clicking a button calls `window.api.ping()` and renders "pong". No `require` in renderer. Lint + a trivial Vitest pass.

---

## PHASE 1 — Image remover, Tier 1 (MVP)

### 1a. Shared IPC types — `src/shared/types.ts`
```ts
export type Tier = 'tier1' | 'tier2'
export type ModelId = 'lama' | 'migan' | 'powerpaint' | 'sdxl'

export interface JobProgress {
  jobId: string; phase: string; current: number; total: number; message?: string
}
export interface ProcessImageReq {
  inputPath: string; maskPng: string /* base64 */; tier: Tier; model: ModelId
}
export interface ProcessResult { outputPath: string }

export interface ModelEntry {
  id: ModelId; tier: Tier; license: string
  files: { url: string; sha256: string; sizeBytes: number; dest: string }[]
}
```

### 1b. ModelManager — `src/main/models/manager.ts`
- [ ] Hardcode the registry. LaMa entry uses Carve/LaMa-ONNX `lama_fp32.onnx`, **input fixed 512×512, opset 17**, sha256 `1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6`.
- [ ] Cache dir: `join(app.getPath('userData'), 'models')`.
- [ ] `ensureModel(id, onProgress)`: if file exists and checksum matches → return path; else download streaming with progress, then verify; on mismatch delete + throw.

```ts
import { createHash } from 'crypto'
import { createWriteStream, existsSync } from 'fs'
import { stat, unlink } from 'fs/promises'

async function sha256(path: string): Promise<string> {
  const h = createHash('sha256')
  const { createReadStream } = await import('fs')
  await new Promise<void>((res, rej) =>
    createReadStream(path).on('data', d => h.update(d)).on('end', () => res()).on('error', rej))
  return h.digest('hex')
}

export async function ensureFile(f: ModelEntry['files'][number], onProgress: (p: number)=>void) {
  if (existsSync(f.dest) && (await sha256(f.dest)) === f.sha256) return f.dest
  const resp = await fetch(f.url)                       // public host, no auth
  if (!resp.ok || !resp.body) throw new Error(`download failed: ${f.url}`)
  const total = Number(resp.headers.get('content-length') ?? f.sizeBytes)
  let done = 0
  const out = createWriteStream(f.dest)
  const reader = resp.body.getReader()
  for (;;) {
    const { value, done: d } = await reader.read(); if (d) break
    out.write(Buffer.from(value)); done += value.length; onProgress(done / total)
  }
  out.end()
  if ((await sha256(f.dest)) !== f.sha256) { await unlink(f.dest); throw new Error('checksum mismatch') }
  return f.dest
}
```

### 1c. Tier1Engine (the tiling core) — `src/main/engines/tier1.ts`
This is the most important algorithm in the app. LaMa input is **fixed 512×512**, so you tile.

```
Algorithm: inpaintTier1(imagePath, maskPng):
  1. Load image (sharp) -> RGB raw + {W,H}. Load mask -> grayscale raw, binarize (>127 => 255).
  2. If nothing masked, return original.
  3. Compute tile grid covering the masked bbox(es):
       TILE = 512, OVERLAP = 64, STRIDE = TILE - OVERLAP
       For each tile origin (x,y) stepping by STRIDE over the masked region:
         - crop 512x512 image tile + mask tile (pad with edge-reflect if near border)
         - skip tiles whose mask crop is empty
  4. For each kept tile:
       - to tensor NCHW float32 /255 ; mask tensor (mask>0)*1.0
       - ort session.run -> output 512x512 RGB float
  5. Composite back:
       - only write masked pixels
       - in OVERLAP zones, feather-blend (linear alpha ramp) to avoid seams
  6. Encode result at original {W,H} + original color profile (sharp). Return outputPath.
```

```ts
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'

export class Tier1Engine {
  private session?: ort.InferenceSession
  async load(modelPath: string) { this.session = await ort.InferenceSession.create(modelPath) }

  async inpaint(imagePath: string, maskPng: Buffer, onProgress: (p:number)=>void): Promise<Buffer> {
    // 1. decode image + mask via sharp.raw(); binarize mask
    // 2. build tile list (TILE=512, OVERLAP=64); skip empty-mask tiles
    // 3. per tile: toTensor -> session.run({image, mask}) -> collect
    // 4. feather-composite masked pixels back over original
    // 5. report progress per tile; return encoded buffer
    throw new Error('implement per algorithm above')
  }
}
```
- [ ] Implement the tile builder + feather blend as pure functions and **unit-test them** (input dims, overlap math, "unmasked pixels unchanged").
- [ ] Confirm the model's actual input/output tensor names via `session.inputNames` and feed accordingly.

### 1d. IPC + JobQueue
- [ ] `src/main/jobs/queue.ts`: single active job, `{id,status,progress,cancel}`; `emit('job:progress', JobProgress)`.
- [ ] Register `job:processImage` handler: ensure model → run Tier1Engine → write to chosen output dir → return `{outputPath}`.
- [ ] Extend preload: `processImage(req)`, `onProgress(cb)`, `cancel(id)`, `openInput()`, `chooseOutputDir()`.

### 1e. Renderer
- [ ] Drop zone / file picker (accept image types).
- [ ] `MaskCanvas`: render image on `<canvas>`, rectangle + brush tools painting a white-on-black mask layer; export mask as PNG matching source dimensions.
- [ ] Process button → progress bar (cancellable) → before/after slider → Save.

### Phase gate
- [ ] A watermarked PNG/JPG, masked by hand, comes out cleanly inpainted — fully offline (kill wifi to prove it), original resolution, no visible tile seams.

---

## PHASE 2 — Model lifecycle UX

### Tasks
- [ ] `models:list` returns registry + `{installed, valid, sizeBytes}` per model.
- [ ] First-run download modal: progress %, speed, cancel.
- [ ] Checksum-failure path: user-friendly retry; never leave a half/corrupt file.
- [ ] Settings: model cache location (show path, "open folder", "clear cache").
- [ ] Cached-skip verified (no re-download when valid).

### Phase gate
- [ ] Delete the cached model → app re-downloads + verifies. Corrupt the file → app detects + re-fetches. No crash, clear messaging.

---

## PHASE 3 — GIF support

### Tasks
- [ ] `MediaPipeline.gif(inputPath, mask, ...)`:
  - explode: `ffmpeg -i in.gif frames/%06d.png`
  - inpaint each frame with the **same mask** (watermark fixed) via Tier1Engine
  - read per-frame delays (ffprobe) and palette; reassemble preserving timing + loop
- [ ] Use a palettegen/paletteuse pass on reassembly for quality:
  `ffmpeg -i frames/%06d.png -vf "palettegen" palette.png` then `paletteuse`.
- [ ] Progress = frame N / total; cancellable; temp dir cleaned.

### Phase gate
- [ ] A watermarked GIF outputs clean, correct timing, correct looping, **no flicker** in the filled region.

---

## PHASE 4 — Video support (Tier 1 per-frame)

### `MediaPipeline.video()` steps
- [ ] `ffprobe` → `{fps, width, height, duration, hasAudio, codec, container}`.
- [ ] Extract audio (if present): `ffmpeg -i in.mp4 -vn -acodec copy audio.m4a`.
- [ ] Demux frames: `ffmpeg -i in.mp4 frames/%06d.png` (or fps-limited for speed).
- [ ] Inpaint each frame with the **shared mask** (Tier1Engine), progress per frame.
- [ ] Remux: `ffmpeg -framerate <fps> -i frames/%06d.png -i audio.m4a -c:v libx264 -pix_fmt yuv420p -c:a copy -shortest out.mp4`.
- [ ] If no audio, skip the audio input. Match original container where feasible.
- [ ] Cancellation must kill the spawned ffmpeg child + the inpaint loop, then clean temp.

### ffmpeg path setup (do once, main process)
```ts
import ffmpeg from 'fluent-ffmpeg'
const ffmpegPath = (require('ffmpeg-static') as string).replace('app.asar','app.asar.unpacked')
const ffprobePath = (require('ffprobe-static').path as string).replace('app.asar','app.asar.unpacked')
ffmpeg.setFfmpegPath(ffmpegPath); ffmpeg.setFfprobePath(ffprobePath)
```

### Phase gate
- [ ] A short MP4 outputs **with audio**, original fps/duration, watermark removed on static-background regions. Cancel mid-job leaves no orphaned process or temp files.

---

## PHASE 5 — Hardware detection + Tier 2 sidecar

### 5a. HardwareDetector — `src/main/hardware/detector.ts`
```ts
import si from 'systeminformation'
import os from 'os'

export async function detect() {
  const g = await si.graphics()
  const gpus = g.controllers.map(c => ({ vendor: c.vendor, model: c.model, vramMB: c.vram ?? 0 }))
  const arch = os.arch(); const platform = os.platform()
  const appleSilicon = platform === 'darwin' && arch === 'arm64'
  const maxVram = Math.max(0, ...gpus.map(x => x.vramMB))
  const tier2Capable = appleSilicon || maxVram >= 4096
  // recommendedTier + notes per IMPLEMENTATION_PLAN §2 table
  return { platform, arch, gpus, totalRamMB: os.totalmem()/1e6, appleSilicon, tier2Capable,
           recommendedTier: tier2Capable && maxVram >= 6144 ? 'tier2' : 'tier1' }
}
```
- [ ] Unit-test the hardware→tier mapping against the §2 matrix (NVIDIA 4/8/12 GB, Apple Silicon, Intel Mac, integrated).

### 5b. Sidecar — `sidecar/server.py`
```python
# Thin launcher around IOPaint's local API.
# Started by SidecarManager with: --host 127.0.0.1 --port <free> --model <id> --device <cuda|mps|cpu>
import sys
from iopaint import api  # launch IOPaint's server; see IOPaint docs for exact entrypoint
if __name__ == "__main__":
    api.main(sys.argv[1:])
```
- [ ] Confirm IOPaint's real programmatic entrypoint/CLI and adapt. PowerPaint = default Tier-2 model id; SDXL = high-VRAM option.

### 5c. SidecarManager — `src/main/engines/sidecar.ts`
- [ ] Find a free port; spawn the **frozen** sidecar binary (path from `process.resourcesPath`, asar-unpacked).
- [ ] Choose `--device`: `cuda` (NVIDIA), `mps` (Apple Silicon), else `cpu` (only if advanced fallback on).
- [ ] Poll health endpoint; expose `loading`/`ready`/`error` to UI.
- [ ] Inpaint over HTTP (multipart: image + mask) → result image.
- [ ] Switch model = restart sidecar with new `--model`.
- [ ] **Kill on `app.on('before-quit')`** and on crash; never orphan.

```ts
spawn(sidecarBinaryPath, ['--host','127.0.0.1','--port',String(port),'--model',model,'--device',device])
```

### 5d. PyInstaller spec — `sidecar/unwater-sidecar.spec`
- [ ] Freeze to a single binary per OS. **Build on each target OS in CI** (no cross-compile).
- [ ] Output goes to `resources/` → `extraResources` in electron-builder.

### 5e. UI — TierSelector
- [ ] Show detected GPU/VRAM + recommended default (pre-selected).
- [ ] Tier 2 disabled with explanation on incapable hardware; "advanced CPU fallback" toggle gated behind a warning.
- [ ] Route `processImage` to Tier 1 (in-process) or Tier 2 (sidecar HTTP) by selected tier.

### Phase gate
- [ ] On a GPU machine, Tier 2 PowerPaint yields visibly better fills than Tier 1; first run shows model download + load. On CPU-only, app defaults to Tier 1 and Tier 2 is gated with a clear warning. Sidecar dies cleanly on quit.

---

## PHASE 6 — Packaging, signing, auto-update

### `electron-builder.yml`
```yaml
appId: com.unwater.app
productName: Unwater
asar: true
files: ["out/**/*", "resources/**/*"]
extraResources:
  - from: "resources/sidecar/${os}"
    to: "sidecar"
  - from: "resources/models"
    to: "models"        # bundle Tier-1 LaMa for offline first run
win:
  target: nsis
  artifactName: "Unwater-${version}-win-x64.${ext}"
mac:
  target: dmg
  category: public.app-category.photography
  hardenedRuntime: true
  gatekeeperAssess: false
nsis:
  oneClick: false
  allowToChangeInstallationDirectory: true
afterSign: scripts/notarize.js   # macOS notarization
publish:
  provider: github               # for electron-updater
```

### Tasks
- [ ] Build packaged app; **inspect `app.asar.unpacked`** — confirm `onnxruntime-node`, `sharp`, ffmpeg binaries are unpacked. Add explicit `asarUnpack` globs only if a runtime crash proves auto-detect missed something.
- [ ] Verify the **ffmpeg path `.replace` works in the packaged build** (run a video job from the installed app, not dev).
- [ ] macOS: Developer ID signing + `notarize.js` (`@electron/notarize`) in `afterSign`. Confirm Gatekeeper lets it launch on a clean Mac.
- [ ] Windows: code-sign installer (unsigned OK for early test builds; expect SmartScreen).
- [ ] Wire `electron-updater` (check on launch, download, prompt to restart).

### Phase gate
- [ ] Signed installers on Win + macOS install on a **clean machine** and run image/GIF/video end-to-end with no dev environment present.

---

## 7. Cross-cutting requirements (apply in every phase)
- [ ] **Temp files:** all under `app.getPath('temp')/unwater/<jobId>/`; always cleaned on success, failure, and cancel.
- [ ] **Cancellation:** every long job exposes a cancel token that kills child processes + stops loops.
- [ ] **Errors:** never crash the app on a bad input; surface a readable message. OOM from sidecar → suggest a lower tier.
- [ ] **Logging:** structured logs to a rotating file in userData (no PII, no file contents).
- [ ] **No network** except model downloads from the registry's public URLs. Assert this in review.
- [ ] **Licenses:** update `THIRD_PARTY_LICENSES.md` whenever a model/lib is added; keep README's legitimate-use notice.

## 8. Definition of Done (v1)
- [ ] Images, GIFs, videos all processed locally, offline, no API key.
- [ ] Tier 1 works on any machine; Tier 2 (PowerPaint default, SDXL optional) works on GPU/MPS with auto-detected recommendation.
- [ ] Signed, notarized installers for Windows + macOS.
- [ ] Only permissively licensed models bundled; no ProPainter/FLUX.
- [ ] Every phase gate above is green.
