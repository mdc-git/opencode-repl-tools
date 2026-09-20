import { Buffer } from 'node:buffer'

export class NdjsonDecoder<T> {
  private buffer = ''

  constructor(private readonly decode: (value: unknown) => T) {}

  push(chunk: string | Uint8Array): readonly T[] {
    this.buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    const values: T[] = []
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      if (line.length > 0) {
        values.push(this.decode(JSON.parse(line)))
      }

      newline = this.buffer.indexOf('\n')
    }

    return values
  }
}

export const encodeNdjson = (value: unknown): string => `${JSON.stringify(value)}\n`
