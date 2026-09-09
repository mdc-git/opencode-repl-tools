import { Buffer } from 'node:buffer'
import type { JobStatus, OutputChunk } from '../model.ts'
import { PREVIEW_BYTES, type Cell, type Job } from './types.ts'

export function utf8Tail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) {
    return text
  }

  let start = buffer.length - maxBytes
  while (start < buffer.length) {
    const byte = buffer[start]
    if (byte === undefined || byte < 0x80 || byte > 0xbf) {
      break
    }

    start += 1
  }

  return buffer.subarray(start).toString('utf8')
}

function takeChunkTail(chunk: OutputChunk, remaining: number): OutputChunk {
  return { ...chunk, text: utf8Tail(chunk.text, remaining) }
}

function appendPreviewChunk(
  reversed: OutputChunk[],
  chunk: OutputChunk,
  remaining: number
): number {
  const bytes = Buffer.byteLength(chunk.text, 'utf8')
  reversed.push(bytes <= remaining ? chunk : takeChunkTail(chunk, remaining))
  return Math.max(0, remaining - bytes)
}

function previewChunks(chunks: readonly OutputChunk[], maxBytes: number) {
  let remaining = maxBytes
  const reversed: OutputChunk[] = []
  for (let index = chunks.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const chunk = chunks[index]
    if (chunk !== undefined) {
      remaining = appendPreviewChunk(reversed, chunk, remaining)
    }
  }

  return {
    chunks: reversed.toReversed(),
    truncated: reversed.length < chunks.length
  }
}

function jobError(cell: Cell, job: Job) {
  if (cell.lifecycle !== 'failed') {
    return job.error
  }

  if (cell.cleanupError === undefined) {
    return job.error
  }

  return { kind: 'lifecycle' as const, message: cell.cleanupError }
}

function inputDetails(job: Job): Pick<JobStatus, 'prompt' | 'password'> {
  if (job.state !== 'waiting_input') {
    return {}
  }

  return {
    ...(job.prompt !== undefined && { prompt: job.prompt }),
    ...(job.password !== undefined && { password: job.password })
  }
}

function selectedCursor(job: Job, cursor: number | undefined): number {
  return cursor ?? job.startCursor
}

function selectedChunks(chunks: readonly OutputChunk[], isPreview: boolean | undefined) {
  if (isPreview === true) {
    return previewChunks(chunks, PREVIEW_BYTES)
  }

  return { chunks: [...chunks], truncated: false }
}

function withError(error: JobStatus['error']): Pick<JobStatus, 'error'> {
  return error === undefined ? {} : { error }
}

export function snapshot(cell: Cell, job: Job, cursor?: number, isPreview?: boolean): JobStatus {
  const read = cell.transcript.read(selectedCursor(job, cursor))
  const limited = selectedChunks(read.chunks, isPreview)
  return {
    ok: true,
    id: job.id,
    language: job.language,
    state: job.state,
    cursor: read.cursor,
    truncated: read.truncated ? true : limited.truncated,
    chunks: limited.chunks,
    ...inputDetails(job),
    ...withError(jobError(cell, job))
  }
}
