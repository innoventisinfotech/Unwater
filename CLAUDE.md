# CLAUDE.md — Unwater

Cross-platform (Windows + macOS) **Electron** desktop app that removes watermarks from
**images, GIFs, and videos** using **local AI inpainting**. Open source.

Full build spec lives in the plan — read it before non-trivial work:
@IMPLEMENTATION_PLAN.md

---

## Non-negotiables (never violate)
- **No API keys, no cloud, no telemetry.** All inference is local. (BYOK is out of scope — do not add.)
- **Offline after model download.** Only permitted network call: downloading open-weight models from public hosts (no auth).
- **License-clean:** bundle ONLY permissive models (LaMa, MI-GAN, IOPaint, PowerPaint, SDXL).
  **Never** bundle ProPainter or FLUX (non-commercial licenses).
- **Runs for everyone:** must work CPU-only (Tier 1) and scale up on GPU (Tier 2).
- No file ever leaves the user's machine.

## Tier model
- **Tier 1 — LaMa + MI-GAN** via `onnxruntime-node`, CPU, in-process. Bundled in installer. Default for low-end/CPU/Intel-Mac.
- **Tier 2 — PowerPaint (default), SDXL (high-VRAM)** via a frozen **IOPaint Python sidecar**, GPU/MPS. Downloaded on demand.
- **Video = Tier 1 per-frame only** in v1 (GPU video inpainting deferred — license).
- Auto-detect hardware → pre-select tier, user can override. CPU-fallback for Tier 2 is hidden behind an "advanced, will be slow" toggle.

## Tech stack
- `electron-vite` + **React + TypeScript + Tailwind**.
- Inference: `onnxruntime-node`. Images: `sharp`. Media: `fluent-ffmpeg` + `ffmpeg-static` + `ffprobe-static`. Hardware: `systeminformation`.
- Sidecar: `iopaint` (+torch), frozen with **PyInstaller** (never shipped as source).
- Packaging: `electron-builder` (Win NSIS, macOS dmg), `electron-updater`.

## Architecture rules
- Renderer is sandboxed: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- All native/Node access via the **typed preload bridge** (`window.api.*`). No `require` in renderer.
- Heavy work (inference, ffmpeg, downloads) runs in **main** or the **sidecar**, never the renderer.
- IPC contract is typed in `src/shared/types.ts` — keep main and renderer in sync there.
- Sidecar binds `127.0.0.1` on a random free port, starts lazily, and is **always killed on app quit**.

## Repo map
- `src/main/` — lifecycle, IPC, `hardware/`, `models/`, `engines/tier1.ts`, `engines/sidecar.ts`, `media/pipeline.ts`, `jobs/`
- `src/preload/` — contextBridge
- `src/renderer/` — React UI (canvas, mask tools, tier selector, progress)
- `src/shared/` — IPC types
- `sidecar/` — IOPaint launcher + PyInstaller spec
- `resources/` — bundled Tier-1 model + icons

## Commands
- `npm run dev` — run app in dev
- `npm run build` — typecheck + bundle
- `npm run lint` / `npm run format`
- `npm test` — Vitest
- `npm run package` — electron-builder for current OS (sidecar must be frozen first on that OS)

## Hard gotchas (caused real crashes — respect them)
- Native binaries (`onnxruntime-node`, `sharp`, ffmpeg) must be **unpacked from asar**. Verify in the **packaged** build, not just dev.
- In production, set ffmpeg paths with `require('ffmpeg-static').replace('app.asar','app.asar.unpacked')` (same for ffprobe).
- **LaMa ONNX input is fixed 512×512** — always tile; never feed arbitrary sizes.
- GIF/video: reuse **one shared mask** across all frames (watermark is fixed) — re-detecting per frame causes flicker.
- Video: extract audio and **re-mux it back**, or output is silent.
- **macOS has no CUDA** — Tier 2 on Apple Silicon uses `--device mps`; Intel Macs are CPU/Tier 1 only.
- Python sidecar **cannot be cross-compiled** — build the PyInstaller binary on each target OS in CI.

## Workflow expectations
- Build strictly in the phase order in the plan (§10). Each phase must meet its acceptance criteria before the next.
- Verify model SHA-256 after download; reject + re-download on mismatch.
- Keep `THIRD_PARTY_LICENSES.md` updated whenever a model/library is added.
- README must keep the legitimate-use notice.

## Current status
- Phase: **1 (image remover, Tier 1) — COMPLETE.** Next: Phase 2 (model lifecycle UX). Update this line as phases complete.
- Model cache dir is `<project>/models/` (in-project, per user requirement — NOT C:/userData). Revisit for packaging in Phase 6.
