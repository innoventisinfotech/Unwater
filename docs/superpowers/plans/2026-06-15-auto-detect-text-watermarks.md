# Auto-Detect Text Watermarks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automatic detection of **text** watermarks that produces a mask, then reuse the existing Phase-1 LaMa inpaint to remove it — with two UX modes: "Auto-detect → edit → Remove" and one-click "Auto-remove".

**Architecture:** A new in-process detector stage runs the RapidOCR PP-OCRv4 DBNet text detector (single ONNX graph, Apache-2.0) to get a per-pixel text-probability map. A pure `maskBuilder` module turns that map into a clean binary mask (threshold → dilate → drop noise → bounding boxes). The mask is identical in shape to what the user paints today, so the existing `Tier1Engine`/save pipeline is unchanged. Logo detection (Florence-2) is a separate follow-up plan that plugs into the same `maskBuilder`.

**Tech Stack:** TypeScript (strict), Electron main process, `onnxruntime-node`, `sharp`, React renderer, Vitest. Spec: `docs/superpowers/specs/2026-06-15-auto-watermark-detection-design.md`.

---

## Context the engineer needs (read before starting)

- This is an Electron app (`electron-vite`). Main process code is in `src/main/`, the typed preload bridge in `src/preload/index.ts`, the React UI in `src/renderer/src/`, and the shared IPC contract in `src/shared/types.ts`.
- **Existing pattern to mirror — the tiling engine:** `src/main/engines/tiling.ts` holds *pure* typed-array math, unit-tested in `src/main/engines/tiling.test.ts`; the ONNX/sharp wiring lives separately in `src/main/engines/tier1.ts`. Follow this split: pure math in its own module with fast offline tests, model wiring in a class, heavy real-model tests gated behind `RUN_MODEL_IT=1`.
- **Model management pattern:** models are declared in `src/main/models/registry.ts` and fetched + SHA-256-verified by `src/main/models/manager.ts` (`ensureModel`/`ensureFile`/`probeFile`). Cache dir comes from `src/main/models/paths.ts` → `getModelsDir()` = `<project>/models/` (NOT C: userData — hard user requirement).
- **IPC pattern:** channel names live in the `Channels` const in `src/shared/types.ts`; handlers are registered in `src/main/ipc/handlers.ts` (`registerIpc()`); the preload exposes typed methods on `window.api.*`; progress is pushed via the `Channels.jobProgress` event using the `JobProgress` type.
- **Running things in this environment:** the shell exports `ELECTRON_RUN_AS_NODE=1`, which breaks launching the GUI. To run the app, prefix with `unset ELECTRON_RUN_AS_NODE &&`. Unit tests (`npm test`) are unaffected.
- **The text detector model (verified):**
  - URL: `https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx`
  - SHA-256: `d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9`
  - Size: `4745517` bytes. License: **Apache-2.0**.
  - Input tensor: name `x`, shape `[1,3,H,W]` float32 (dynamic H/W).
  - Output tensor: name `sigmoid_0.tmp_0`, shape `[1,1,H,W]` — sigmoid text-probability map (0..1) at input resolution.
  - Standard DBNet preprocessing: RGB, scale to [0,1], normalize with ImageNet mean `[0.485,0.456,0.406]` / std `[0.229,0.224,0.225]`, resize so both sides are multiples of 32 and the long side ≤ `maxSide` (use 960). Postprocess: threshold the probability map (~0.3), the result is the text region.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `THIRD_PARTY_LICENSES.md` | Create | Record LaMa (Apache-2.0) + RapidOCR/PP-OCRv4 (Apache-2.0) licenses. |
| `src/shared/types.ts` | Modify | Add `ModelId` value `ppocr_det`; add `DetectRegion`, `AutoDetectReq`, `AutoDetectResult`; add `Channels.detectAuto`. |
| `src/main/models/registry.ts` | Modify | Add the `ppocr_det` model entry (real URL/SHA/size). |
| `src/main/detect/maskBuilder.ts` | Create | **Pure** CV: confidence→binary, dilate, connected components + bbox, noise filter, `buildMask` pipeline. |
| `src/main/detect/maskBuilder.test.ts` | Create | Fast offline unit tests for every maskBuilder function. |
| `src/main/detect/textDetector.ts` | Create | DBNet preprocessing (pure `preprocessForDb`) + `TextDetector` ONNX class returning a source-res confidence map. |
| `src/main/detect/textDetector.test.ts` | Create | Pure unit tests for `preprocessForDb`. |
| `src/main/detect/autoDetector.ts` | Create | Orchestrate: ensure model → TextDetector → maskBuilder → encode mask PNG; return `AutoDetectResult`. |
| `src/main/detect/autoDetector.model.test.ts` | Create | Gated (`RUN_MODEL_IT=1`) real-model end-to-end test on a text fixture. |
| `src/main/ipc/handlers.ts` | Modify | Register `detect:auto` handler; emit `phase:'detect'` progress. |
| `src/preload/index.ts` | Modify | Add `autoDetect(req)` method. |
| `src/renderer/src/components/MaskCanvas.tsx` | Modify | Add `loadMaskDataUrl(url)` to the imperative handle. |
| `src/renderer/src/App.tsx` | Modify | Add "Auto-detect" + "Auto-remove" buttons and wiring. |

---

## Task 1: Licenses file + registry entry for the text detector

**Files:**
- Create: `THIRD_PARTY_LICENSES.md`
- Modify: `src/shared/types.ts` (add `ppocr_det` to `ModelId`)
- Modify: `src/main/models/registry.ts`
- Test: `src/main/models/registry.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/main/models/registry.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { getModel } from './registry'

describe('registry', () => {
  it('has the LaMa Tier-1 model', () => {
    expect(getModel('lama').files[0].fileName).toBe('lama_fp32.onnx')
  })

  it('has the PP-OCRv4 text detector with verified checksum and size', () => {
    const m = getModel('ppocr_det')
    expect(m.tier).toBe('tier1')
    expect(m.license).toMatch(/Apache-2\.0/)
    expect(m.files[0]).toMatchObject({
      fileName: 'ppocrv4_det.onnx',
      sha256: 'd2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9',
      sizeBytes: 4745517
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/models/registry.test.ts`
Expected: FAIL — `getModel('ppocr_det')` throws "Unknown or not-yet-registered model".

- [ ] **Step 3a: Add the model id to the shared type**

In `src/shared/types.ts`, change:
```ts
export type ModelId = 'lama' | 'migan' | 'powerpaint' | 'sdxl'
```
to:
```ts
export type ModelId = 'lama' | 'ppocr_det' | 'migan' | 'powerpaint' | 'sdxl'
```

- [ ] **Step 3b: Add the registry entry**

In `src/main/models/registry.ts`, change the `MODEL_REGISTRY` type and add the entry:
```ts
export const MODEL_REGISTRY: Record<'lama' | 'ppocr_det', ModelEntry> = {
  lama: {
    id: 'lama',
    tier: 'tier1',
    license: 'Apache-2.0 (LaMa) — ONNX export from Carve/LaMa-ONNX',
    inputSize: 512,
    files: [
      {
        url: 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx',
        sha256: '1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6',
        sizeBytes: 205_000_000,
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
```

- [ ] **Step 4: Create `THIRD_PARTY_LICENSES.md`**

```markdown
# Third-Party Licenses

Unwater bundles/downloads only permissively-licensed models and libraries.

## Models

### LaMa (image inpainting) — Tier 1
- Source: Carve/LaMa-ONNX (ONNX export). Original LaMa by Samsung Research.
- License: **Apache-2.0**.

### PP-OCRv4 text detection (RapidOCR) — auto-detect (text watermarks)
- Source: SWHL/RapidOCR `PP-OCRv4/ch_PP-OCRv4_det_infer.onnx`, converted from PaddleOCR.
- License: **Apache-2.0** (RapidOCR and PaddleOCR are both Apache-2.0).

## Libraries
See `package.json`. Notable: onnxruntime-node (MIT), sharp (Apache-2.0), Electron (MIT),
ffmpeg via ffmpeg-static (LGPL/GPL build — documented when media features land).
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/models/registry.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add THIRD_PARTY_LICENSES.md src/shared/types.ts src/main/models/registry.ts src/main/models/registry.test.ts
git commit -m "feat(detect): register PP-OCRv4 text detector model + licenses"
```

---

## Task 2: Pure maskBuilder — confidence map → clean binary mask + regions

**Files:**
- Create: `src/main/detect/maskBuilder.ts`
- Test: `src/main/detect/maskBuilder.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/main/detect/maskBuilder.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { binarizeConfidence, dilate, connectedComponents, buildMask } from './maskBuilder'

describe('binarizeConfidence', () => {
  it('thresholds 0..255 confidence to 0/255', () => {
    expect(Array.from(binarizeConfidence(new Uint8Array([0, 76, 78, 200]), 77))).toEqual([0, 0, 255, 255])
  })
})

describe('dilate', () => {
  it('expands a single set pixel by the given radius (square SE)', () => {
    // 5x5 with center pixel set; radius 1 → 3x3 block set
    const W = 5, H = 5
    const m = new Uint8Array(W * H)
    m[2 * W + 2] = 255
    const out = dilate(m, W, H, 1)
    let count = 0
    for (const v of out) if (v === 255) count++
    expect(count).toBe(9)
    expect(out[2 * W + 2]).toBe(255)
    expect(out[1 * W + 1]).toBe(255)
    expect(out[0 * W + 0]).toBe(0) // outside the 3x3
  })
})

describe('connectedComponents', () => {
  it('finds separate blobs and their bounding boxes', () => {
    const W = 6, H = 3
    const m = new Uint8Array(W * H)
    // blob A: (0,0),(1,0)  blob B: (4,2)
    m[0] = 255; m[1] = 255; m[2 * W + 4] = 255
    const { boxes } = connectedComponents(m, W, H)
    expect(boxes.length).toBe(2)
    const a = boxes.find((b) => b.x0 === 0)!
    expect(a).toMatchObject({ x0: 0, y0: 0, x1: 2, y1: 1, area: 2 })
    const b = boxes.find((b) => b.x0 === 4)!
    expect(b).toMatchObject({ x0: 4, y0: 2, x1: 5, y1: 3, area: 1 })
  })
})

describe('buildMask', () => {
  it('returns found=false and an empty mask when nothing passes threshold', () => {
    const W = 8, H = 8
    const conf = new Uint8Array(W * H) // all zero
    const res = buildMask(conf, W, H, { threshold: 77, dilateRadius: 1, minArea: 2, kind: 'text' })
    expect(res.found).toBe(false)
    expect(res.regions).toEqual([])
    expect(res.mask.every((v) => v === 0)).toBe(true)
    expect(res.mask.length).toBe(W * H)
  })

  it('drops tiny noise below minArea but keeps a real region (with dilation padding)', () => {
    const W = 20, H = 20
    const conf = new Uint8Array(W * H)
    // a 4x4 solid block of high confidence at (8,8)-(11,11) = area 16
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) conf[y * W + x] = 200
    // a single stray pixel of noise far away
    conf[0] = 200
    const res = buildMask(conf, W, H, { threshold: 77, dilateRadius: 2, minArea: 8, kind: 'text' })
    expect(res.found).toBe(true)
    expect(res.regions.length).toBe(1)
    expect(res.regions[0].kind).toBe('text')
    // noise pixel was below minArea → not in mask
    expect(res.mask[0]).toBe(0)
    // the real block is masked
    expect(res.mask[9 * W + 9]).toBe(255)
    // dilation expanded it outward by ~radius
    expect(res.mask[7 * W + 9]).toBe(255)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/detect/maskBuilder.test.ts`
Expected: FAIL — module not found / functions undefined.

- [ ] **Step 3: Implement `src/main/detect/maskBuilder.ts`**

```ts
/**
 * Pure CV to turn a detector's per-pixel confidence map into a clean binary inpaint mask.
 * No ONNX/sharp here — just typed-array math (mirrors engines/tiling.ts). Unit-tested offline.
 */

export interface DetectedBox {
  x0: number
  y0: number
  x1: number // exclusive
  y1: number // exclusive
  area: number
}

export interface Region {
  x: number
  y: number
  w: number
  h: number
  kind: 'text' | 'logo'
  score: number
}

export interface BuildMaskOptions {
  /** 0..255 threshold on the confidence map (≈0.3*255 = 77 for DBNet). */
  threshold: number
  /** Square structuring-element radius to pad detections so inpaint fully covers them. */
  dilateRadius: number
  /** Connected components smaller than this (pixels) are discarded as noise. */
  minArea: number
  kind: 'text' | 'logo'
}

export interface BuildMaskResult {
  /** Source-resolution binary mask (0/255), length W*H. */
  mask: Uint8Array
  regions: Region[]
  found: boolean
}

export function binarizeConfidence(conf: Uint8Array, threshold: number): Uint8Array {
  const out = new Uint8Array(conf.length)
  for (let i = 0; i < conf.length; i++) out[i] = conf[i] >= threshold ? 255 : 0
  return out
}

/** Separable square-SE dilation (horizontal max then vertical max). O(W*H). */
export function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice()
  const horiz = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let on = 0
      for (let dx = -radius; dx <= radius && !on; dx++) {
        const nx = x + dx
        if (nx >= 0 && nx < width && mask[row + nx] === 255) on = 255
      }
      horiz[row + x] = on
    }
  }
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0
      for (let dy = -radius; dy <= radius && !on; dy++) {
        const ny = y + dy
        if (ny >= 0 && ny < height && horiz[ny * width + x] === 255) on = 255
      }
      out[y * width + x] = on
    }
  }
  return out
}

/** 4-connected component labeling; returns the label map and per-label bounding boxes. */
export function connectedComponents(
  mask: Uint8Array,
  width: number,
  height: number
): { labels: Int32Array; boxes: DetectedBox[] } {
  const labels = new Int32Array(width * height).fill(0)
  const boxes: DetectedBox[] = []
  const stack: number[] = []
  let current = 0
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 255 || labels[i] !== 0) continue
    current++
    let x0 = width
    let y0 = height
    let x1 = 0
    let y1 = 0
    let area = 0
    stack.push(i)
    labels[i] = current
    while (stack.length) {
      const p = stack.pop()!
      const px = p % width
      const py = (p - px) / width
      area++
      if (px < x0) x0 = px
      if (py < y0) y0 = py
      if (px + 1 > x1) x1 = px + 1
      if (py + 1 > y1) y1 = py + 1
      const neighbors = [
        px > 0 ? p - 1 : -1,
        px < width - 1 ? p + 1 : -1,
        py > 0 ? p - width : -1,
        py < height - 1 ? p + width : -1
      ]
      for (const n of neighbors) {
        if (n >= 0 && mask[n] === 255 && labels[n] === 0) {
          labels[n] = current
          stack.push(n)
        }
      }
    }
    boxes.push({ x0, y0, x1, y1, area })
  }
  return { labels, boxes }
}

export function buildMask(
  conf: Uint8Array,
  width: number,
  height: number,
  opts: BuildMaskOptions
): BuildMaskResult {
  const bin = binarizeConfidence(conf, opts.threshold)
  // Find components BEFORE dilation so noise filtering uses true blob area.
  const { labels, boxes } = connectedComponents(bin, width, height)
  const kept = new Set<number>()
  const regions: Region[] = []
  for (let b = 0; b < boxes.length; b++) {
    const box = boxes[b]
    if (box.area < opts.minArea) continue
    kept.add(b + 1) // labels are 1-based in component order
    regions.push({
      x: box.x0,
      y: box.y0,
      w: box.x1 - box.x0,
      h: box.y1 - box.y0,
      kind: opts.kind,
      score: 1
    })
  }
  // Rebuild a mask containing only kept components, then dilate for inpaint padding.
  const filtered = new Uint8Array(width * height)
  for (let i = 0; i < filtered.length; i++) if (kept.has(labels[i])) filtered[i] = 255
  const mask = dilate(filtered, width, height, opts.dilateRadius)
  return { mask, regions, found: regions.length > 0 }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/detect/maskBuilder.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/main/detect/maskBuilder.ts src/main/detect/maskBuilder.test.ts
git commit -m "feat(detect): pure maskBuilder (threshold, dilate, components, noise filter)"
```

---

## Task 3: Shared IPC types for auto-detect

**Files:**
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add the types and channel**

In `src/shared/types.ts`, add after the `InputFile` interface:
```ts
export interface DetectRegion {
  x: number
  y: number
  w: number
  h: number
  kind: 'text' | 'logo'
  score: number
}

export interface AutoDetectReq {
  jobId: string
  inputPath: string
}

export interface AutoDetectResult {
  /** White-on-black PNG mask as a base64 data URL, at source resolution. */
  maskPng: string
  regions: DetectRegion[]
  found: boolean
}
```

In the same file, add `detectAuto` to the `Channels` const:
```ts
export const Channels = {
  ping: 'app:ping',
  modelsList: 'models:list',
  dialogOpenInput: 'dialog:openInput',
  dialogChooseOutputDir: 'dialog:chooseOutputDir',
  detectAuto: 'detect:auto',
  jobProcessImage: 'job:processImage',
  jobCancel: 'job:cancel',
  jobProgress: 'job:progress'
} as const
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run typecheck`
Expected: PASS (no errors). The new types are not yet used; that is fine.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(detect): add auto-detect IPC types and channel"
```

---

## Task 4: TextDetector — DBNet preprocessing (pure) + ONNX class

**Files:**
- Create: `src/main/detect/textDetector.ts`
- Test: `src/main/detect/textDetector.test.ts`

- [ ] **Step 1: Write the failing test for the pure preprocessing**

Create `src/main/detect/textDetector.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { dbInputSize } from './textDetector'

describe('dbInputSize', () => {
  it('rounds dimensions to a multiple of 32 and caps the long side at maxSide', () => {
    // 1000x500, maxSide 960 → scale 0.96 → 960x480, both already /32
    expect(dbInputSize(1000, 500, 960)).toEqual({ w: 960, h: 480 })
  })

  it('rounds up to the nearest multiple of 32 for small images', () => {
    // 100x70 under maxSide → round to 96? must be multiple of 32 and >= 32
    expect(dbInputSize(100, 70, 960)).toEqual({ w: 96, h: 64 })
  })

  it('never returns less than 32', () => {
    expect(dbInputSize(10, 5, 960)).toEqual({ w: 32, h: 32 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/detect/textDetector.test.ts`
Expected: FAIL — `dbInputSize` not exported.

- [ ] **Step 3: Implement `src/main/detect/textDetector.ts`**

```ts
import * as ort from 'onnxruntime-node'
import sharp from 'sharp'

const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

/** Compute DBNet input dims: scale so the long side ≤ maxSide, round each to a multiple of 32 (min 32). */
export function dbInputSize(
  width: number,
  height: number,
  maxSide: number
): { w: number; h: number } {
  const longSide = Math.max(width, height)
  const scale = longSide > maxSide ? maxSide / longSide : 1
  const round32 = (v: number) => Math.max(32, Math.round((v * scale) / 32) * 32)
  return { w: round32(width), h: round32(height) }
}

/**
 * RapidOCR PP-OCRv4 DBNet text detector. Returns a SOURCE-resolution grayscale (0..255)
 * text-probability map suitable for maskBuilder. Single ONNX graph, CPU, in-process.
 */
export class TextDetector {
  private session?: ort.InferenceSession
  private inputName = 'x'
  private outputName = 'sigmoid_0.tmp_0'
  private readonly maxSide = 960

  async load(modelPath: string): Promise<void> {
    this.session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })
    this.inputName = this.session.inputNames[0]
    this.outputName = this.session.outputNames[0]
  }

  get loaded(): boolean {
    return this.session !== undefined
  }

  /** @returns { conf, width, height } where conf is the source-res probability map (0..255). */
  async detect(
    imagePath: string
  ): Promise<{ conf: Uint8Array; width: number; height: number }> {
    if (!this.session) throw new Error('TextDetector: model not loaded')

    const meta = await sharp(imagePath).metadata()
    const srcW = meta.width ?? 0
    const srcH = meta.height ?? 0
    const { w, h } = dbInputSize(srcW, srcH, this.maxSide)

    // Resize to the network input and read raw RGB.
    const { data } = await sharp(imagePath)
      .removeAlpha()
      .resize(w, h, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })

    // HWC uint8 → NCHW float32, normalized.
    const plane = w * h
    const input = new Float32Array(3 * plane)
    for (let i = 0; i < plane; i++) {
      input[i] = (data[i * 3] / 255 - MEAN[0]) / STD[0]
      input[plane + i] = (data[i * 3 + 1] / 255 - MEAN[1]) / STD[1]
      input[2 * plane + i] = (data[i * 3 + 2] / 255 - MEAN[2]) / STD[2]
    }

    const tensor = new ort.Tensor('float32', input, [1, 3, h, w])
    const result = await this.session.run({ [this.inputName]: tensor })
    const probF = result[this.outputName].data as Float32Array // [1,1,h,w] in 0..1

    // prob (0..1) → grayscale bytes, then resize back to source resolution.
    const probBytes = new Uint8Array(plane)
    for (let i = 0; i < plane; i++) probBytes[i] = Math.round(Math.min(Math.max(probF[i], 0), 1) * 255)
    const resized = await sharp(Buffer.from(probBytes), { raw: { width: w, height: h, channels: 1 } })
      .resize(srcW, srcH, { fit: 'fill' })
      .raw()
      .toBuffer()

    return { conf: new Uint8Array(resized.buffer, resized.byteOffset, resized.byteLength), width: srcW, height: srcH }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/detect/textDetector.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify typecheck/lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS. (Ensure the variable is named `probBytes` in ASCII.)

- [ ] **Step 6: Commit**

```bash
git add src/main/detect/textDetector.ts src/main/detect/textDetector.test.ts
git commit -m "feat(detect): RapidOCR DBNet text detector + dbInputSize (tested)"
```

---

## Task 5: autoDetector orchestrator

**Files:**
- Create: `src/main/detect/autoDetector.ts`

- [ ] **Step 1: Implement `src/main/detect/autoDetector.ts`**

```ts
import sharp from 'sharp'
import type { AutoDetectResult } from '../../shared/types'
import { getModel } from '../models/registry'
import { ensureModel } from '../models/manager'
import { getModelsDir } from '../models/paths'
import { TextDetector } from './textDetector'
import { buildMask } from './maskBuilder'

// Reuse a single loaded detector across calls.
let textDetector: TextDetector | undefined

async function ensureTextDetector(onProgress?: (f: number) => void): Promise<TextDetector> {
  const modelPath = await ensureModel(getModel('ppocr_det'), {
    destDir: getModelsDir(),
    onProgress
  })
  if (!textDetector || !textDetector.loaded) {
    textDetector = new TextDetector()
    await textDetector.load(modelPath)
  }
  return textDetector
}

/**
 * Auto-detect text watermarks in an image and return a white-on-black PNG mask (base64 data URL)
 * at source resolution, plus the detected regions. `onDownload` reports model-download progress.
 */
export async function autoDetect(
  imagePath: string,
  onDownload?: (f: number) => void
): Promise<AutoDetectResult> {
  const detector = await ensureTextDetector(onDownload)
  const { conf, width, height } = await detector.detect(imagePath)

  const { mask, regions, found } = buildMask(conf, width, height, {
    threshold: 77, // ≈ 0.3 * 255
    dilateRadius: Math.max(2, Math.round(Math.min(width, height) * 0.004)),
    minArea: Math.max(16, Math.round(width * height * 0.00002)),
    kind: 'text'
  })

  if (!found) {
    return { maskPng: '', regions: [], found: false }
  }

  const png = await sharp(Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength), {
    raw: { width, height, channels: 1 }
  })
    .png()
    .toBuffer()

  return {
    maskPng: `data:image/png;base64,${png.toString('base64')}`,
    regions,
    found: true
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/detect/autoDetector.ts
git commit -m "feat(detect): autoDetector orchestrator (model -> detect -> mask png)"
```

---

## Task 6: IPC handler + preload method

**Files:**
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add the handler**

In `src/main/ipc/handlers.ts`, add this import near the others:
```ts
import { autoDetect } from '../detect/autoDetector'
import type { AutoDetectReq, AutoDetectResult } from '../../shared/types'
```
(Extend the existing `import { ... } from '../../shared/types'` line instead of duplicating if cleaner.)

Inside `registerIpc()`, add a handler (place it next to the other `ipcMain.handle` calls):
```ts
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
```

- [ ] **Step 2: Add the preload method**

In `src/preload/index.ts`, extend the imports:
```ts
import {
  Channels,
  type AutoDetectReq,
  type AutoDetectResult,
  type InputFile,
  type JobProgress,
  type ModelStatus,
  type ProcessImageReq,
  type ProcessResult
} from '../shared/types'
```
And add to the `api` object (after `chooseOutputDir`):
```ts
  autoDetect: (req: AutoDetectReq): Promise<AutoDetectResult> =>
    ipcRenderer.invoke(Channels.detectAuto, req),
```

- [ ] **Step 3: Verify build (compiles main + preload + renderer)**

Run: `npm run build`
Expected: PASS. (`window.api.autoDetect` is now typed via `export type Api = typeof api`.)

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/handlers.ts src/preload/index.ts
git commit -m "feat(detect): detect:auto IPC handler + preload autoDetect()"
```

---

## Task 7: Renderer — load detected mask + Auto-detect / Auto-remove buttons

**Files:**
- Modify: `src/renderer/src/components/MaskCanvas.tsx`
- Modify: `src/renderer/src/App.tsx`

- [ ] **Step 1: Add `loadMaskDataUrl` to MaskCanvas's imperative handle**

In `src/renderer/src/components/MaskCanvas.tsx`, extend the `MaskCanvasHandle` interface:
```ts
export interface MaskCanvasHandle {
  exportMaskDataUrl: () => string
  clear: () => void
  /** Paint an external (detected) white-on-black mask onto the editable mask layer. */
  loadMaskDataUrl: (url: string) => void
}
```
And add the method inside `useImperativeHandle(ref, () => ({ ... }), [width, height])`:
```ts
      loadMaskDataUrl: (url: string) => {
        const m = maskRef.current
        const ctx = m?.getContext('2d')
        if (!m || !ctx) return
        const img = new Image()
        img.onload = () => {
          ctx.clearRect(0, 0, width, height)
          // Draw only the white parts: the mask PNG is white-on-black, and the mask layer is
          // displayed at 50% opacity, so drawing it directly reproduces the painted look.
          ctx.drawImage(img, 0, 0, width, height)
        }
        img.src = url
      }
```

- [ ] **Step 2: Add state + handlers in App.tsx**

In `src/renderer/src/App.tsx`, add near the other state:
```ts
  const [detecting, setDetecting] = useState(false)
  const [notice, setNotice] = useState('')
```

Add these two functions (next to `process`):
```ts
  async function autoDetect(): Promise<void> {
    if (!input) return
    const jobId = crypto.randomUUID()
    jobIdRef.current = jobId
    setDetecting(true)
    setError('')
    setNotice('')
    try {
      const res = await window.api.autoDetect({ jobId, inputPath: input.path })
      if (!res.found) {
        setNotice('No watermark detected — draw it manually with the brush or rectangle.')
        return
      }
      maskRef.current?.loadMaskDataUrl(res.maskPng)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setDetecting(false)
      setProgress(null)
    }
  }

  async function autoRemove(): Promise<void> {
    if (!input) return
    setError('')
    setNotice('')
    const detectJob = crypto.randomUUID()
    jobIdRef.current = detectJob
    setDetecting(true)
    let maskPng: string
    try {
      const res = await window.api.autoDetect({ jobId: detectJob, inputPath: input.path })
      if (!res.found) {
        setNotice('No watermark detected — draw it manually with the brush or rectangle.')
        return
      }
      maskPng = res.maskPng
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return
    } finally {
      setDetecting(false)
    }
    // Hand the detected mask straight to the existing image pipeline.
    const jobId = crypto.randomUUID()
    jobIdRef.current = jobId
    setProcessing(true)
    setResult(null)
    try {
      const res = await window.api.processImage({
        jobId,
        inputPath: input.path,
        maskPng,
        tier: 'tier1',
        model: 'lama'
      })
      setResult(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProcessing(false)
      setProgress(null)
    }
  }
```

- [ ] **Step 3: Add the buttons**

In the toolbar `<div>` (the one containing "Clear mask"), add before the `ml-auto` actions group, two buttons:
```tsx
              <button
                onClick={autoDetect}
                disabled={detecting || processing}
                className="rounded bg-sky-700 px-3 py-1 text-xs hover:bg-sky-600 disabled:opacity-50"
              >
                {detecting ? 'Detecting…' : 'Auto-detect'}
              </button>
              <button
                onClick={autoRemove}
                disabled={detecting || processing}
                className="rounded bg-sky-600 px-3 py-1 text-xs font-medium hover:bg-sky-500 disabled:opacity-50"
              >
                Auto-remove
              </button>
```

And render the notice (place just above the `{error && ...}` block):
```tsx
            {notice && (
              <div className="w-full max-w-2xl rounded border border-amber-800 bg-amber-950/40 px-4 py-2 text-sm text-amber-200">
                {notice}
              </div>
            )}
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: PASS (typecheck + bundle).

- [ ] **Step 5: Manual smoke (optional but recommended)**

Run: `unset ELECTRON_RUN_AS_NODE && npm run dev`
Open an image with text on it → click **Auto-detect** → a mask should appear over the text; you can edit it, then **Remove watermark**. **Auto-remove** should do both in one click.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/MaskCanvas.tsx src/renderer/src/App.tsx
git commit -m "feat(detect): Auto-detect and Auto-remove buttons in the UI"
```

---

## Task 8: Gated real-model end-to-end test

**Files:**
- Create: `src/main/detect/autoDetector.model.test.ts`

- [ ] **Step 1: Write the gated integration test**

Create `src/main/detect/autoDetector.model.test.ts`:
```ts
/**
 * End-to-end auto-detect test against the REAL PP-OCRv4 model.
 * Gated behind RUN_MODEL_IT=1 (downloads ~4.7 MB once into <project>/models). Run with:
 *   RUN_MODEL_IT=1 npx vitest run src/main/detect/autoDetector.model.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'

const RUN = process.env.RUN_MODEL_IT === '1'
const W = 640
const H = 360

/** White image with bold black "WATERMARK" text drawn via an SVG overlay. */
async function makeTextFixture(dir: string): Promise<string> {
  const svg = `<svg width="${W}" height="${H}"><rect width="100%" height="100%" fill="white"/>
    <text x="50%" y="55%" font-family="Arial" font-size="64" font-weight="bold"
      text-anchor="middle" fill="black">WATERMARK</text></svg>`
  const p = join(dir, 'text.png')
  await sharp(Buffer.from(svg)).png().toFile(p)
  return p
}

describe.runIf(RUN)('autoDetect end-to-end (real PP-OCRv4 model)', () => {
  it('produces a mask that covers the text and leaves the corners clean', async () => {
    // Import lazily so the heavy model code is only touched when the gate is on.
    const { autoDetect } = await import('./autoDetector')
    const dir = await mkdtemp(join(tmpdir(), 'unwater-det-'))
    try {
      const imagePath = await makeTextFixture(dir)
      const res = await autoDetect(imagePath)
      expect(res.found).toBe(true)
      expect(res.regions.length).toBeGreaterThan(0)

      // Decode the returned mask and check coverage.
      const base64 = res.maskPng.replace(/^data:image\/png;base64,/, '')
      const { data, info } = await sharp(Buffer.from(base64, 'base64')).raw().toBuffer({ resolveWithObject: true })
      expect(info.width).toBe(W)
      expect(info.height).toBe(H)

      const px = (x: number, y: number) => data[(y * info.width + x) * info.channels]
      // Center (where the text is) should be masked (white).
      expect(px(Math.round(W / 2), Math.round(H / 2))).toBe(255)
      // A corner (clean white background) should NOT be masked.
      expect(px(5, 5)).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 600_000)
})
```

- [ ] **Step 2: Run the gated test**

Run: `RUN_MODEL_IT=1 npx vitest run src/main/detect/autoDetector.model.test.ts`
Expected: PASS — downloads the model to `<project>/models/ppocrv4_det.onnx`, detects the text, mask covers center, corner clean.

> If the center assertion fails, the most likely cause is the detected text being thin strokes that the dilation didn't fill — increase `dilateRadius` in `autoDetector.ts`, or assert on a masked pixel sampled from a known stroke instead of the glyph center. If the corner assertion fails, lower the `threshold` is wrong — instead raise it (fewer false positives).

- [ ] **Step 3: Verify the default suite stays fast and green**

Run: `npm test`
Expected: all prior + new pure tests pass; the two `*.model.test.ts` files are skipped.

- [ ] **Step 4: Commit**

```bash
git add src/main/detect/autoDetector.model.test.ts
git commit -m "test(detect): gated real-model end-to-end auto-detect test"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck` — clean
- [ ] `npm run lint` — clean
- [ ] `npm run build` — clean
- [ ] `npm test` — all pure tests pass, model tests skipped
- [ ] `RUN_MODEL_IT=1 npx vitest run` — both LaMa and PP-OCRv4 model tests pass
- [ ] Manual: `unset ELECTRON_RUN_AS_NODE && npm run dev`, confirm Auto-detect paints a text mask and Auto-remove cleans it end-to-end, fully offline after the model download.
- [ ] Update `CLAUDE.md` "Current status" to note auto-detect (text) complete; logo detection (Florence-2) is the next plan.

## Follow-up (separate plan, NOT in this one)

**Logo/graphic watermark detection via Florence-2 (MIT).** It is a 4-graph seq2seq VLM
(`onnx-community/Florence-2-base`: vision encoder + token embed + text encoder + merged decoder)
plus a BART tokenizer and an autoregressive decode loop, invoked with
`<CAPTION_TO_PHRASE_GROUNDING>` + the phrase "watermark"/"logo" to get boxes. Those boxes feed
the SAME `maskBuilder` (rasterize boxes → union → dilate). This is a large, self-contained
subsystem and gets its own spec+plan.
```
