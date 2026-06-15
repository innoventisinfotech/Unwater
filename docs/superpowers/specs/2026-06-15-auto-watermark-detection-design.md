# Design — Automatic Watermark Detection (text + logo)

> Status: approved (2026-06-15). Companion feature to the Phase-1 manual masking MVP.
> Slots in as **Phase 2: Auto-detection**, pushing the original plan's "model-lifecycle UX"
> to Phase 3 (the new models exercise much of that lifecycle work anyway).

## 1. Goal

Let the app **detect** a watermark automatically and remove it, in addition to the existing
manual rectangle/brush masking. Auto-detection produces the *same* white-on-black mask a user
would have painted, so the entire Phase-1 inpaint pipeline (Tier1Engine tiling → composite →
save) is reused unchanged.

Two UX modes, both requested:
- **Auto-detect → review/edit → Remove:** paint the detected mask onto the existing MaskCanvas
  so the user can correct it, then run the existing Remove flow.
- **Auto-remove (one-click):** detect → mask → feed straight into `job:processImage`, no pause.

## 2. Non-negotiable constraints (inherited)

- Fully local, offline after model download. No cloud, no telemetry, no API keys.
- License-clean: only permissively-licensed models (Apache/MIT/SD-class). Each new model's
  license recorded in `THIRD_PARTY_LICENSES.md`.
- Models downloaded on demand, **SHA-256 verified**, cached to `<project>/models/` (NOT C:
  userData) — reuse the existing ModelManager.
- Must run CPU-only (Tier 1). Detection is in-process via `onnxruntime-node`.

## 3. Scope

**In scope (v1):**
- Text watermarks (words, URLs, dates, © lines).
- Logo / graphic / semi-transparent badge watermarks.
- Both UX modes above.
- A single unioned mask (multiple detected regions merged into one mask).

**Deferred (explicitly out of scope this round):**
- **Tiled / repeated full-image overlays.** These do not fit detect-mask-then-inpaint: there is
  no small region to mask, and inpainting cannot reconstruct an entire image. Removing them is
  *de-watermarking* (signal subtraction), a separate future feature. Documented, not built.
- Multi-watermark UI beyond the merged mask. Auto-tier-2 routing (sidecar) — unchanged from
  the existing tier plan.

## 4. Architecture

A new `AutoDetector` stage sits *before* the existing pipeline and only produces a mask:

```
image → AutoDetector ──> binary mask ──> [review/edit on MaskCanvas]? ──> Tier1Engine → save
                  ▲                          (only in Auto-detect mode)
        ┌─────────┴───────────┐
   TextDetector   Logo/Watermark      →  MaskBuilder (pure CV: union + dilate + clean)
   (small ONNX)   segmentation (ONNX)
```

Everything downstream of "binary mask" already exists. The detector is the only new inference.

### Components (each isolated, single-purpose, testable)

| File | Responsibility | Depends on |
|---|---|---|
| `src/main/detect/textDetector.ts` | Run a small permissive text-region ONNX; return boxes/polygons for text watermarks. | onnxruntime-node, sharp |
| `src/main/detect/logoDetector.ts` | Run a per-pixel watermark **segmentation** ONNX; return a grayscale confidence map for logos/semi-transparent badges. | onnxruntime-node, sharp |
| `src/main/detect/maskBuilder.ts` | **Pure, unit-tested.** Rasterize text boxes + union with seg map → binarize → morphological **dilate** (pad so the inpaint fully covers the watermark) → drop tiny noise components → output mask at source resolution. | none (pure typed-array math) |
| `src/main/detect/autoDetector.ts` | Orchestrate both detectors + maskBuilder; return `{ maskPng, regions, confidence }`. | the three above, ModelManager |
| `src/main/models/registry.ts` | Add the two new model entries (license + SHA-256). | — |

The "CV" component of the hybrid is `maskBuilder` (union + dilation + connected-component
noise filtering) — pure typed-array operations, no model, mirroring how `tiling.ts` is pure and
tested separately from ONNX/sharp.

## 5. Models

| Role | Candidate | License | Size | Notes |
|---|---|---|---|---|
| Text detection | PaddleOCR DB detector (ONNX) | Apache-2.0 | ~5 MB | Outputs text-region boxes; fast on CPU. |
| Logo/watermark segmentation | A permissively-licensed watermark-segmentation ONNX (per-pixel mask) | TBD-in-plan | TBD | **Open risk — resolved in the plan.** |

**Open risk (resolved during planning, NOT invented here):** pin a *specific* permissively-
licensed segmentation model with exact URL + SHA-256 + license. If no clean segmentation model
is found, the logo path **falls back to Florence-2 open-vocabulary detection (MIT)** — boxes
→ mask via the same `maskBuilder`. The design tolerates either because `maskBuilder` consumes
boxes and/or a confidence map uniformly.

## 6. IPC contract additions (`src/shared/types.ts`)

```ts
export interface DetectRegion { x: number; y: number; w: number; h: number; kind: 'text' | 'logo'; score: number }
export interface AutoDetectReq { jobId: string; inputPath: string }
export interface AutoDetectResult { maskPng: string /* base64 */; regions: DetectRegion[]; found: boolean }
// Channels: add detect:auto
```
`JobProgress` gains a new `phase: 'detect'` value (download → detect → inpaint). Cancellation
runs through the existing JobQueue.

## 7. Renderer changes

- Two new buttons in the toolbar when an image is loaded: **Auto-detect** and **Auto-remove**.
- **Auto-detect:** calls `window.api.autoDetect({inputPath})`; on success, loads the returned
  mask into `MaskCanvas` (new imperative `loadMaskDataUrl(url)` handle method) so the user can
  edit it; then the existing Remove button runs as today.
- **Auto-remove:** calls autoDetect, then immediately `processImage` with the returned mask
  (skipping review). Reuses the existing progress/cancel/before-after UI.
- `found === false`: inline notice "No watermark detected — draw it manually." (Not an error.)

## 8. Error handling

- No detection → friendly empty-state message, fall back to manual masking. Never throw.
- Model download / checksum failure → reuse ModelManager reject-and-retry behavior.
- OOM / inference error → readable message; manual masking still available.
- Auto-remove always runs through the cancellable JobQueue (single active job).

## 9. Testing

- **Pure unit tests** (`maskBuilder.test.ts`, offline, fast): box rasterization, union of
  boxes + seg map, dilation padding amount, tiny-component noise filtering, output dims ==
  source dims, empty-input → empty mask.
- **Gated real-model integration test** (`RUN_MODEL_IT=1`): on a fixture with a known text
  string and a known logo box, assert the produced mask covers the watermark regions and leaves
  clean corners unmasked (analogous to the existing Tier1 model test).
- typecheck + lint + build stay green; default `npm test` remains fast (heavy tests gated).

## 10. Definition of done

- Auto-detect paints a sensible mask for a text watermark and for a logo watermark; user can
  edit it; Remove produces a clean result — fully offline after model download.
- Auto-remove does the same in one click.
- New models are permissively licensed, SHA-256-verified, cached in `<project>/models/`, and
  listed in `THIRD_PARTY_LICENSES.md`.
- Tiled/repeated overlays remain documented-as-deferred.
