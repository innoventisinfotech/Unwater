# Implementation Plan — Unwater (Open-Source Watermark Remover)

> **Audience:** Claude Code. This is the authoritative build spec. Follow it phase by phase.
> Do not skip phases. Each phase has acceptance criteria that must pass before moving on.
> When something here conflicts with a passing thought, **this document wins** unless the
> user explicitly overrides it.

---

## 1. Product Summary

**Unwater** is a cross-platform (Windows + macOS) **Electron desktop app** that removes
watermarks / unwanted regions from **images, GIFs, and videos** using AI inpainting.

### Non-negotiable constraints
1. **No API keys. Ever.** All inference runs locally on the user's machine. (A BYOK escape
   hatch is explicitly **out of scope for v1** — do not add it.)
2. **Fully offline** after model download. The only network call permitted is downloading
   open-weight models from public hosts (e.g. Hugging Face) — no auth, no telemetry.
3. **Runs for everyone.** Must work on a CPU-only laptop (Tier 1) and scale up on a GPU
   (Tier 2). Auto-detect hardware and recommend the right tier.
4. **Open source, license-clean.** Only bundle permissively licensed models (Apache/MIT/
   SD-class). **Never** bundle ProPainter or FLUX (non-commercial licenses). See §12.
5. **Privacy.** No file ever leaves the machine. No analytics.

---

## 2. The Tier System (core mental model)

| Tier | Models | Runtime | Hardware | Bundled? |
|------|--------|---------|----------|----------|
| **Tier 1** | LaMa, MI-GAN | `onnxruntime-node` (in-process, CPU) | Any machine | **Yes — in installer** |
| **Tier 2 (default)** | PowerPaint (SD1.5 backbone) | IOPaint Python sidecar | GPU ≥4–6 GB VRAM, or Apple Silicon | Downloaded on demand |
| **Tier 2 (high-VRAM)** | SDXL Inpainting | IOPaint Python sidecar | GPU ≥8 GB VRAM (12 GB comfortable) | Downloaded on demand |

### Hardware → recommended default
| Profile | Default | Tier 2 viable |
|---|---|---|
| Integrated GPU / old laptop | Tier 1 | No |
| Intel Mac | Tier 1 | No |
| Apple Silicon (M-series, 16 GB+ unified) | Tier 1 | PowerPaint via MPS; SDXL workable but slower |
| NVIDIA 4–6 GB | Tier 1 | PowerPaint yes, SDXL no |
| NVIDIA 8 GB | Tier 2 | PowerPaint great; SDXL ~30s |
| NVIDIA 12 GB+ | Tier 2 | Everything, fast |
| AMD (Windows) | Tier 1 | Limited (DirectML), treat one step below equivalent NVIDIA |

### Rules
- On first launch, detect hardware and **pre-select** the tier, but always let the user override.
- If the user forces Tier 2 on weak hardware, show a clear "this will be slow" warning.
- **CPU fallback for Tier 2** is allowed but hidden behind an explicit "Advanced — I know it'll be slow" toggle. Never offer it as a normal option.
- **Video uses Tier 1 (per-frame LaMa) only** in v1. GPU video inpainting (ProPainter) is deferred (§13) because of the non-commercial license.

---

## 3. Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ Electron App                                                   │
│                                                                │
│  Renderer (React + TS + Tailwind)   <-- UI, canvas, mask draw  │
│        │  contextBridge (preload, typed IPC)                   │
│        ▼                                                        │
│  Main process (Node)                                           │
│    ├─ HardwareDetector   (systeminformation)                   │
│    ├─ ModelManager       (download + SHA-256 verify + cache)   │
│    ├─ Tier1Engine        (onnxruntime-node, LaMa/MI-GAN tiling)│
│    ├─ SidecarManager     (spawn/monitor IOPaint, Tier 2)       │
│    ├─ MediaPipeline      (ffmpeg: frames, audio, gif, remux)   │
│    └─ JobQueue           (cancellable jobs + progress events)  │
│                                                                │
└──────────────┬─────────────────────────────────────────────────┘
               │ localhost HTTP (only when Tier 2 active)
               ▼
        IOPaint sidecar (bundled Python, PyInstaller-frozen)
```

### Process/security rules (mandatory)
- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- All Node/native access goes through a **typed preload bridge** (`window.api.*`). No `require` in renderer.
- All heavy work (inference, ffmpeg, downloads) runs in **main** or the **sidecar**, never the renderer.
- The sidecar binds to `127.0.0.1` on a random free port, started lazily only when Tier 2 is used, and killed on app quit.

---

## 4. Tech Stack & Dependencies

**Scaffold:** `electron-vite` (React + TypeScript template).

**Runtime (npm):**
- `electron`, `electron-builder`, `electron-updater`
- `onnxruntime-node` — Tier 1 inference
- `sharp` — image decode/encode, mask compositing, tiling
- `fluent-ffmpeg`, `ffmpeg-static`, `ffprobe-static` — media I/O
- `systeminformation` — GPU/VRAM/platform detection
- React, `tailwindcss`

**Sidecar (Python, frozen with PyInstaller, NOT shipped as source):**
- `iopaint` (+ torch). Provides PowerPaint, SDXL inpainting, model downloads, local API.

**Dev:** TypeScript strict, ESLint + Prettier, Vitest (unit), Playwright (e2e optional).

---

## 5. Repository Structure

```
unwater/
├─ CLAUDE.md                      # standing rules (separate file)
├─ IMPLEMENTATION_PLAN.md         # this file
├─ README.md                      # incl. legitimate-use notice (§12)
├─ LICENSE                        # MIT (app code)
├─ THIRD_PARTY_LICENSES.md        # every bundled model + lib license
├─ package.json
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ tsconfig.json
├─ resources/                     # bundled at build (icons, Tier-1 onnx if pre-shipped)
│   └─ models/                    # (Tier-1 models may live here or download on first run)
├─ sidecar/                       # IOPaint launcher + PyInstaller spec
│   ├─ server.py
│   └─ unwater-sidecar.spec
└─ src/
    ├─ main/
    │   ├─ index.ts               # app lifecycle, window, IPC registration
    │   ├─ ipc/                   # one file per channel group, typed handlers
    │   ├─ hardware/detector.ts
    │   ├─ models/manager.ts      # registry, download, checksum, cache paths
    │   ├─ engines/tier1.ts       # onnxruntime-node + tiling
    │   ├─ engines/sidecar.ts     # spawn/monitor IOPaint, HTTP client
    │   ├─ media/pipeline.ts      # ffmpeg image/gif/video
    │   └─ jobs/queue.ts
    ├─ preload/
    │   └─ index.ts               # contextBridge: window.api.* (typed)
    ├─ shared/
    │   └─ types.ts               # IPC contract types shared main<->renderer
    └─ renderer/
        ├─ App.tsx
        ├─ components/            # Canvas, MaskTools, TierSelector, ProgressBar, etc.
        └─ state/                 # job + settings state
```

---

## 6. Component Specs

### 6.1 HardwareDetector (`src/main/hardware/detector.ts`)
- Use `systeminformation` to read `graphics()` (GPU model, VRAM) and `os` for platform/arch.
- Output: `{ platform, arch, gpus:[{vendor,model,vramMB}], totalRamMB, recommendedTier, tier2Capable, notes }`.
- Logic mirrors the table in §2. Apple Silicon detected via `arch === 'arm64'` + Apple GPU → MPS-capable.

### 6.2 ModelManager (`src/main/models/manager.ts`)
- **Model registry** (hardcoded JSON): each entry `{ id, tier, files:[{url, sha256, sizeBytes, dest}], license }`.
  - Tier 1 LaMa: `lama_fp32.onnx` from `Carve/LaMa-ONNX`, **fixed input 512×512, opset 17**, SHA-256 `1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6`.
  - Tier 1 MI-GAN: ONNX export entry.
  - Tier 2 PowerPaint / SDXL: downloaded **by IOPaint itself** on first use (manager just triggers + reports progress).
- Download to app userData dir (`app.getPath('userData')/models/`). **Verify SHA-256** after download; delete + error on mismatch. Skip if already present & valid. Emit progress events.
- Never re-download a valid file.

### 6.3 Tier1Engine (`src/main/engines/tier1.ts`)
- Load ONNX via `onnxruntime-node` (CPU EP; optionally try DirectML EP on Windows later).
- **Tiling pipeline** (model is fixed 512×512):
  1. Take image + binary mask.
  2. Compute bounding region(s) of the mask; split into 512×512 tiles covering masked area (with overlap, e.g. 32px, to avoid seams).
  3. For each tile: feed `image_tile` + `mask_tile` (binarized, `(mask>0)*1.0`), run inference.
  4. Composite inpainted tiles back using feathered blending on overlaps; leave unmasked pixels untouched.
- Use `sharp` for all crop/resize/composite. Preserve original resolution & color profile.

### 6.4 SidecarManager (`src/main/engines/sidecar.ts`)
- Spawn the frozen IOPaint binary from `resources/` (path-fixed for asar, see §9), pass `--host 127.0.0.1 --port <free> --model <powerpaint|sdxl> --device <cuda|mps|cpu>`.
- Health-check the HTTP endpoint before sending work; surface "loading model" state to UI.
- Single sidecar instance; switch models by restarting with the new `--model`. Kill on app `before-quit`.
- Send inpaint requests (image + mask) over HTTP; receive result image. Handle OOM errors → friendly message + suggest lower tier.

### 6.5 MediaPipeline (`src/main/media/pipeline.ts`)
- Set ffmpeg path: `require('ffmpeg-static').replace('app.asar','app.asar.unpacked')`; same for `ffprobe-static`.
- **Image:** decode → engine → encode. Done.
- **GIF:** ffmpeg explode to frames → inpaint each frame **with the SAME mask** (watermark assumed fixed) → reassemble preserving frame delays + palette. Shared mask prevents shimmer.
- **Video:**
  1. `ffprobe` for fps, dimensions, duration.
  2. Extract audio track separately.
  3. Demux to frames (PNG sequence) in a temp dir.
  4. Inpaint each frame with the shared mask (Tier 1 per-frame in v1).
  5. Remux frames → video at original fps, **mux audio back**, match container/codec.
  6. Clean temp dir.
- All steps emit progress (frame N / total). All jobs cancellable.

### 6.6 JobQueue (`src/main/jobs/queue.ts`)
- One active heavy job at a time. Each job has an id, status, progress, cancel token.
- Cancel must actually kill ffmpeg/inference and clean temp files.

### 6.7 Renderer (UI)
- Drop zone / file picker (image, gif, mp4/mov).
- Canvas with **manual mask tools**: rectangle + brush to paint the watermark region. (Auto-detect is deferred, §13.)
- **TierSelector** showing detected hardware + recommended default + warnings.
- Progress UI with cancel. Before/after preview. Save/export.
- Settings: model tier, output dir, advanced CPU-fallback toggle.

---

## 7. IPC Contract (`src/shared/types.ts`)

Define and type every channel. Minimum set:
- `hardware:detect` → `HardwareInfo`
- `dialog:openInput` → file path(s)
- `models:list` → registry + install status
- `models:download(id)` → progress events → done/error
- `sidecar:ensure(model, device)` → ready/error (+ "loading" events)
- `job:processImage({ inputPath, maskPng, tier, model })` → progress → `{ outputPath }`
- `job:processGif(...)` / `job:processVideo(...)` → same shape
- `job:cancel(jobId)`
- `settings:get` / `settings:set`

Progress events use a single typed `JobProgress { jobId, phase, current, total, message }`.

---

## 8. Processing Pipelines (acceptance behavior)
- **Image (Tier 1):** select → draw mask → process → before/after → save. Output same resolution, no visible seams.
- **Image (Tier 2):** same, but routes to sidecar; first run shows model download + load progress.
- **GIF:** output loops correctly, same timing, no per-frame flicker in the filled region.
- **Video:** output has audio, original fps/duration, watermark region cleanly filled on static backgrounds.

---

## 9. Build & Packaging

### electron-builder.yml essentials
- Targets: Windows **NSIS** (x64), macOS **dmg** (arm64 + x64 / universal).
- `asar: true`. Native modules (`onnxruntime-node`, sharp, ffmpeg binaries) are auto-unpacked to `app.asar.unpacked` — verify after first build; add explicit `asarUnpack` globs only if something crashes at runtime.
- `extraResources`: the frozen IOPaint sidecar binary, app icons. (Tier-1 ONNX either bundled here or downloaded on first run — prefer download to keep installer small, but Tier 1 must work offline-first-run only if pre-bundled. **Decision: bundle Tier-1 LaMa in installer** so the app is usable with zero network on first launch.)
- **ffmpeg path fix is mandatory at runtime** (see §6.5) or video/gif crash in production.

### Sidecar freezing
- `pyinstaller sidecar/unwater-sidecar.spec` produces a per-platform binary. Build on each target OS (no cross-compile). CI matrix: windows-latest + macos-latest.

### Signing (required for distribution)
- **macOS:** Apple Developer ID cert + **notarization** (electron-builder `afterSign` notarize), else Gatekeeper blocks launch.
- **Windows:** code-signing cert to avoid SmartScreen warnings (can ship unsigned for early testing).

### Auto-update
- `electron-updater` against GitHub Releases (or self-hosted). Wire after Phase 5.

---

## 10. Implementation Phases (build in this order)

> Each phase ends with a working, demoable app. Do not start a phase until the prior phase's
> acceptance criteria pass.

### Phase 0 — Scaffold
- `electron-vite` React+TS app boots on Win + macOS. Tailwind wired. Strict TS, ESLint/Prettier, preload contextBridge stub.
- **Done when:** `npm run dev` opens a window with a typed `window.api.ping()` round-trip.

### Phase 1 — Image remover, Tier 1 (the MVP)
- ModelManager downloads + verifies LaMa ONNX (or loads bundled). Tier1Engine tiling. Manual rectangle+brush mask. Process → before/after → save.
- **Done when:** a watermarked PNG/JPG has its watermark removed locally, no network, no seams.

### Phase 2 — Model lifecycle UX
- First-run download progress, checksum failure handling, cached-skip, model location in settings.
- **Done when:** deleting the cached model re-triggers a verified re-download; corrupt file is rejected.

### Phase 3 — GIF support
- ffmpeg explode/reassemble, shared mask, palette/timing preserved.
- **Done when:** a watermarked GIF outputs clean, correctly timed, no flicker.

### Phase 4 — Video support (Tier 1 per-frame)
- ffprobe, frame demux, audio extract, per-frame inpaint, remux + audio mux, cancellable, progress.
- **Done when:** a short MP4 outputs with audio intact, original fps, watermark removed.

### Phase 5 — Hardware detection + Tier 2 sidecar
- HardwareDetector + TierSelector with recommended default + warnings. Freeze IOPaint sidecar. SidecarManager spawn/health/switch. PowerPaint as Tier 2 default; SDXL as high-VRAM option. Advanced CPU-fallback toggle.
- **Done when:** on a GPU machine, Tier 2 PowerPaint produces visibly better fills; on CPU-only, app defaults to Tier 1 and Tier 2 is gated with a warning.

### Phase 6 — Packaging, signing, auto-update
- electron-builder Win NSIS + macOS dmg, native-module unpack verified, ffmpeg path fix verified in packaged build, sidecar bundled via extraResources, macOS notarization, electron-updater.
- **Done when:** signed installers on both OSes launch and run all features from a clean machine.

---

## 11. Testing Strategy
- **Unit (Vitest):** tiling math, mask binarization, checksum verify, hardware→tier mapping, ffmpeg arg builders.
- **Integration:** run Tier1Engine on a fixture image+mask; assert output dims + unmasked pixels unchanged.
- **Packaged smoke test (manual per phase 6):** clean Win + macOS VM, install, run image/gif/video with no dev tools present (validates asar-unpack + ffmpeg path).
- Keep sample fixtures (small watermarked image, gif, 2–3s video) in `test/fixtures/`.

---

## 12. Licensing & Legal (enforce strictly)
- **App code:** MIT.
- **Bundle only permissive models:** LaMa, MI-GAN, IOPaint, PowerPaint (SD1.5), SDXL Inpainting — all permissive/SD-class. Keep each model's LICENSE in `THIRD_PARTY_LICENSES.md`.
- **Never bundle** ProPainter (NTU S-Lab, non-commercial) or FLUX.1 Fill (non-commercial). If video GPU inpainting is added later, revisit licensing first (§13).
- **README must include a legitimate-use notice:** tool is for removing your own watermarks / restoring footage; users are responsible for respecting copyright. This keeps the project from being pulled.
- ffmpeg is LGPL/GPL depending on build — use an LGPL static build via `ffmpeg-static` and document it.

---

## 13. Deferred / Out of Scope for v1 (do NOT build yet)
- **Tier 3** (FLUX.1 Fill, OmniEraser) — too large, GPU-prohibitive, non-commercial.
- **GPU video inpainting** (ProPainter / DiffuEraser) — license + VRAM; needs a separate decision.
- **Auto-detection of watermarks** (Florence-2 open-vocabulary detection) — v2 feature; ship manual masking first.
- **BYOK / any cloud API** — explicitly excluded.
- **SDXL quantization** (FP8/GGUF) — only revisit if users request SDXL-quality on small cards.

---

## 14. Known Pitfalls (read before coding the relevant part)
- **asar:** native binaries (onnxruntime-node, sharp, ffmpeg) crash inside `app.asar`; they must be unpacked. electron-builder usually auto-detects — verify in the packaged build, not just dev.
- **ffmpeg path:** always `.replace('app.asar','app.asar.unpacked')` on the static paths in production.
- **LaMa input is fixed 512×512** — you MUST tile; don't feed arbitrary sizes.
- **GIF/video flicker:** reuse ONE mask across frames; do not re-detect per frame.
- **Video audio:** extract and re-mux, or the output is silent.
- **macOS has no CUDA:** Tier 2 on Apple Silicon uses MPS (`--device mps`); Intel Macs → CPU/Tier 1.
- **No cross-compile for the Python sidecar:** build the PyInstaller binary on each target OS in CI.
- **Sidecar lifecycle:** always kill it on quit; never leave an orphaned Python process or open port.
