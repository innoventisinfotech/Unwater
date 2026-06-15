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
