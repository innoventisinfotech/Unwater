import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { sha256File, isFileValid, ensureFile } from './manager'
import type { ModelFile } from '../../shared/types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'unwater-models-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const oneShot = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

describe('sha256File', () => {
  it('matches a one-shot hash of the same bytes', async () => {
    const buf = Buffer.from('the quick brown fox')
    const p = join(dir, 'a.bin')
    await writeFile(p, buf)
    expect(await sha256File(p)).toBe(oneShot(buf))
  })
})

describe('isFileValid', () => {
  it('is false for a missing file', async () => {
    expect(await isFileValid(join(dir, 'nope.bin'), 'deadbeef')).toBe(false)
  })

  it('is true when the checksum matches (case-insensitive)', async () => {
    const buf = Buffer.from('payload')
    const p = join(dir, 'b.bin')
    await writeFile(p, buf)
    expect(await isFileValid(p, oneShot(buf).toUpperCase())).toBe(true)
  })

  it('is false when the checksum does not match', async () => {
    const p = join(dir, 'c.bin')
    await writeFile(p, Buffer.from('payload'))
    expect(await isFileValid(p, oneShot(Buffer.from('different')))).toBe(false)
  })
})

describe('ensureFile', () => {
  it('returns the cached path without downloading when the file is already valid', async () => {
    const buf = Buffer.from('cached model bytes')
    const fileName = 'model.onnx'
    await writeFile(join(dir, fileName), buf)

    const file: ModelFile = {
      // A URL that would fail if fetched — proving no network happens on the valid-cache path.
      url: 'http://127.0.0.1:9/should-not-be-fetched',
      sha256: oneShot(buf),
      sizeBytes: buf.length,
      fileName
    }

    let lastProgress = 0
    const path = await ensureFile(file, { destDir: dir, onProgress: (f) => (lastProgress = f) })
    expect(path).toBe(join(dir, fileName))
    expect(lastProgress).toBe(1)
  })
})
