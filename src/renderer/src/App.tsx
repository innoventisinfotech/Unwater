import { useEffect, useRef, useState } from 'react'
import type { InputFile, JobProgress, ProcessResult } from '../../shared/types'
import MaskCanvas, { type MaskCanvasHandle } from './components/MaskCanvas'

function App() {
  const [input, setInput] = useState<InputFile | null>(null)
  const [tool, setTool] = useState<'brush' | 'rect'>('rect')
  const [brushSize, setBrushSize] = useState(40)
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState<JobProgress | null>(null)
  const [result, setResult] = useState<ProcessResult | null>(null)
  const [error, setError] = useState('')
  const [detecting, setDetecting] = useState(false)
  const [notice, setNotice] = useState('')

  const maskRef = useRef<MaskCanvasHandle>(null)
  const jobIdRef = useRef<string>('')

  useEffect(() => window.api.onProgress(setProgress), [])

  async function pick(): Promise<void> {
    const file = await window.api.openInput()
    if (!file) return
    setInput(file)
    setResult(null)
    setError('')
    setNotice('')
    setProgress(null)
  }

  async function process(): Promise<void> {
    if (!input) return
    const maskPng = maskRef.current?.exportMaskDataUrl()
    if (!maskPng) return
    const jobId = crypto.randomUUID()
    jobIdRef.current = jobId
    setProcessing(true)
    setError('')
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

  function cancel(): void {
    if (jobIdRef.current) void window.api.cancelJob(jobIdRef.current)
  }

  const phaseLabel = progress?.phase === 'download' ? 'Downloading model' : 'Removing watermark'

  return (
    <div className="flex min-h-screen flex-col bg-neutral-900 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Unwater</h1>
          <p className="text-xs text-neutral-500">Local AI watermark remover · Tier 1 (LaMa, CPU)</p>
        </div>
        <button
          onClick={pick}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium hover:bg-indigo-500"
        >
          Open image…
        </button>
      </header>

      <main className="flex flex-1 flex-col items-center gap-5 overflow-auto p-6">
        {!input && (
          <div className="m-auto flex flex-col items-center gap-3 text-center text-neutral-500">
            <p className="text-base">Open an image, paint over the watermark, then remove it.</p>
            <p className="text-xs">Everything runs locally on your machine — no upload, no account.</p>
          </div>
        )}

        {input && (
          <>
            <div className="flex flex-wrap items-center gap-3 rounded-lg bg-neutral-800/60 px-4 py-2">
              <span className="text-xs text-neutral-400">Tool:</span>
              <ToolButton active={tool === 'rect'} onClick={() => setTool('rect')} label="Rectangle" />
              <ToolButton active={tool === 'brush'} onClick={() => setTool('brush')} label="Brush" />
              {tool === 'brush' && (
                <label className="flex items-center gap-2 text-xs text-neutral-400">
                  Size
                  <input
                    type="range"
                    min={5}
                    max={150}
                    value={brushSize}
                    onChange={(e) => setBrushSize(Number(e.target.value))}
                  />
                  <span className="w-8 tabular-nums">{brushSize}</span>
                </label>
              )}
              <button
                onClick={() => maskRef.current?.clear()}
                className="rounded bg-neutral-700 px-3 py-1 text-xs hover:bg-neutral-600"
              >
                Clear mask
              </button>
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
              <div className="ml-auto flex gap-2">
                {processing ? (
                  <button onClick={cancel} className="rounded bg-red-600 px-4 py-1.5 text-sm hover:bg-red-500">
                    Cancel
                  </button>
                ) : (
                  <button
                    onClick={process}
                    className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium hover:bg-emerald-500"
                  >
                    Remove watermark
                  </button>
                )}
              </div>
            </div>

            {processing && progress && (
              <div className="w-full max-w-2xl">
                <div className="mb-1 flex justify-between text-xs text-neutral-400">
                  <span>{progress.message ?? phaseLabel}</span>
                  <span className="tabular-nums">{progress.current}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded bg-neutral-800">
                  <div
                    className="h-full bg-indigo-500 transition-all"
                    style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            )}

            {notice && (
              <div className="w-full max-w-2xl rounded border border-amber-800 bg-amber-950/40 px-4 py-2 text-sm text-amber-200">
                {notice}
              </div>
            )}

            {error && (
              <div className="w-full max-w-2xl rounded border border-red-800 bg-red-950/40 px-4 py-2 text-sm text-red-300">
                {error}
              </div>
            )}

            {result ? (
              <div className="flex w-full flex-col items-center gap-3">
                <div className="grid w-full max-w-5xl grid-cols-1 gap-4 md:grid-cols-2">
                  <Figure title="Before" src={input.dataUrl} />
                  <Figure title="After" src={result.outputDataUrl} />
                </div>
                <p className="text-xs text-neutral-400">
                  Saved to <span className="font-mono text-neutral-300">{result.outputPath}</span>
                </p>
              </div>
            ) : (
              <MaskCanvas
                ref={maskRef}
                src={input.dataUrl}
                width={input.width}
                height={input.height}
                tool={tool}
                brushSize={brushSize}
              />
            )}
          </>
        )}
      </main>
    </div>
  )
}

function ToolButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-3 py-1 text-xs ${
        active ? 'bg-indigo-600 text-white' : 'bg-neutral-700 text-neutral-300 hover:bg-neutral-600'
      }`}
    >
      {label}
    </button>
  )
}

function Figure({ title, src }: { title: string; src: string }) {
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-xs uppercase tracking-wide text-neutral-500">{title}</figcaption>
      <img src={src} alt={title} className="w-full rounded border border-neutral-800" />
    </figure>
  )
}

export default App
