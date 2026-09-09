import { Buffer } from 'node:buffer'
import type { OutputChunk, OutputStream } from './model.ts'

export type OutputRead = {
  readonly cursor: number
  readonly truncated: boolean
  readonly chunks: readonly OutputChunk[]
}

type StoredChunk = OutputChunk & {
  readonly bytes: number
  readonly partial: boolean
}

function utf8Tail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) {
    return text
  }

  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1
  }

  return buffer.subarray(start).toString('utf8')
}

function publicChunk(chunk: StoredChunk): OutputChunk {
  const { bytes: _bytes, partial: _partial, ...result } = chunk
  return result
}

function normalizeCursor(cursor: number): number {
  if (!Number.isSafeInteger(cursor)) {
    return 0
  }

  return Math.max(cursor, 0)
}

function readWasTruncated(
  first: StoredChunk | undefined,
  selectedFirst: StoredChunk | undefined,
  cursor: number
): boolean {
  if (selectedFirst?.partial === true) {
    return true
  }

  if (first === undefined) {
    return false
  }

  return cursor < first.cursor - 1
}

export class OutputRing {
  private nextCursor = 1
  private retainedBytes = 0
  private readonly chunks: StoredChunk[] = []

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('maxBytes must be a positive integer')
    }
  }

  get cursor(): number {
    return this.nextCursor - 1
  }

  append(stream: OutputStream, text: string, jobId?: string): number {
    if (text.length === 0) {
      return this.cursor
    }

    const bytes = Buffer.byteLength(text, 'utf8')
    const isPartial = bytes > this.maxBytes
    const retained = isPartial ? utf8Tail(text, this.maxBytes) : text
    const chunk = this.store(stream, retained, isPartial, jobId)
    this.evict()
    return chunk.cursor
  }

  private store(stream: OutputStream, text: string, partial: boolean, jobId?: string): StoredChunk {
    const chunk: StoredChunk = {
      cursor: this.nextCursor++,
      stream,
      text,
      ...(jobId !== undefined && { jobId }),
      bytes: Buffer.byteLength(text, 'utf8'),
      partial
    }
    this.chunks.push(chunk)
    this.retainedBytes += chunk.bytes
    return chunk
  }

  private evict(): void {
    while (this.retainedBytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift()
      if (removed !== undefined) {
        this.retainedBytes -= removed.bytes
      }
    }
  }

  read(afterCursor: number): OutputRead {
    const cursor = normalizeCursor(afterCursor)
    const selected = this.chunks.filter((chunk) => chunk.cursor > cursor)
    return {
      cursor: this.cursor,
      truncated: readWasTruncated(this.chunks[0], selected[0], cursor),
      chunks: selected.map(publicChunk)
    }
  }
}
