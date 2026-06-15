import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { mkdir, stat, unlink } from 'fs/promises'
import { join } from 'path'
import type { ModelEntry, ModelFile } from '../../shared/types'

/** Stream a file through SHA-256 and return the lowercase hex digest. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject)
  })
  return hash.digest('hex')
}

/** True if the file exists on disk and its SHA-256 matches the expected digest. */
export async function isFileValid(path: string, expectedSha256: string): Promise<boolean> {
  if (!existsSync(path)) return false
  return (await sha256File(path)) === expectedSha256.toLowerCase()
}

export interface EnsureFileOptions {
  /** Absolute directory the model file should live in. */
  destDir: string
  /** Called with fractional progress 0..1 during download. */
  onProgress?: (fraction: number) => void
}

/**
 * Ensure a single model file is present and valid in `destDir`.
 * - If present and checksum matches → returns its path without re-downloading.
 * - Otherwise downloads (streaming, with progress), then verifies.
 * - On checksum mismatch the partial/corrupt file is deleted and an error is thrown.
 */
export async function ensureFile(file: ModelFile, opts: EnsureFileOptions): Promise<string> {
  const { destDir, onProgress } = opts
  await mkdir(destDir, { recursive: true })
  const dest = join(destDir, file.fileName)

  if (await isFileValid(dest, file.sha256)) {
    onProgress?.(1)
    return dest
  }

  // Public host, no auth/telemetry — the only network call the app makes.
  const resp = await fetch(file.url)
  if (!resp.ok || !resp.body) {
    throw new Error(`Model download failed (${resp.status}) for ${file.url}`)
  }

  const total = Number(resp.headers.get('content-length') ?? file.sizeBytes)
  let received = 0
  const out = createWriteStream(dest)
  const reader = resp.body.getReader()

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      received += value.length
      if (!out.write(Buffer.from(value))) {
        // Respect backpressure so large models don't balloon memory.
        await new Promise<void>((resolve) => out.once('drain', resolve))
      }
      if (total > 0) onProgress?.(Math.min(received / total, 1))
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      out.end((err?: Error | null) => (err ? reject(err) : resolve()))
    )
  }

  if (!(await isFileValid(dest, file.sha256))) {
    await unlink(dest).catch(() => undefined)
    throw new Error(`Checksum mismatch for ${file.fileName}; download rejected.`)
  }

  onProgress?.(1)
  return dest
}

/** Ensure every file of a model is present and valid; returns the first file's path. */
export async function ensureModel(
  entry: ModelEntry,
  opts: EnsureFileOptions
): Promise<string> {
  let firstPath = ''
  for (let i = 0; i < entry.files.length; i++) {
    const file = entry.files[i]
    const path = await ensureFile(file, {
      destDir: opts.destDir,
      onProgress: (f) =>
        // Spread progress evenly across multiple files.
        opts.onProgress?.((i + f) / entry.files.length)
    })
    if (i === 0) firstPath = path
  }
  return firstPath
}

/** Lightweight install/validity probe for `models:list`. */
export async function probeFile(
  file: ModelFile,
  destDir: string
): Promise<{ installed: boolean; valid: boolean; sizeBytes: number }> {
  const dest = join(destDir, file.fileName)
  if (!existsSync(dest)) return { installed: false, valid: false, sizeBytes: 0 }
  const { size } = await stat(dest)
  const valid = (await sha256File(dest)) === file.sha256.toLowerCase()
  return { installed: true, valid, sizeBytes: size }
}
