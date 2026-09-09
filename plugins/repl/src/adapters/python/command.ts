import { Buffer } from 'node:buffer'
import { spawn, type ChildProcess } from 'node:child_process'
import process from 'node:process'
import type { Readable } from 'node:stream'
import { killProcessGroup } from '../process-group.ts'
import { PythonStartupError } from './types.ts'

const DIAGNOSTIC_BYTES = 16 * 1024
const KILL_WAIT_MS = 750

function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf
}

function utf8Tail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) {
    return text
  }

  let start = buffer.length - maxBytes
  while (isUtf8ContinuationByte(buffer[start])) {
    start += 1
  }

  return buffer.subarray(start).toString('utf8')
}

function appendTail(current: string, chunk: string): string {
  return utf8Tail(current + chunk, DIAGNOSTIC_BYTES)
}

function chunkText(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
}

function bindData(stream: Readable | undefined, handler: (chunk: unknown) => void): void {
  if (stream !== undefined) {
    stream.on('data', handler)
  }
}

class CommandCapture {
  private stdout = ''
  private tail = ''
  private settled = false
  private aborting = false

  constructor(
    private readonly child: ChildProcess,
    private readonly signal: AbortSignal
  ) {
    bindData(child.stdout ?? undefined, (chunk) => {
      this.onStdout(chunk)
    })
    bindData(child.stderr ?? undefined, (chunk) => {
      this.onStderr(chunk)
    })
  }

  private onStdout(chunk: unknown): void {
    const text = chunkText(chunk)
    this.stdout += text
    this.tail = appendTail(this.tail, text)
  }

  private onStderr(chunk: unknown): void {
    this.tail = appendTail(this.tail, chunkText(chunk))
  }

  private abort(reject: (reason: Error) => void): void {
    this.aborting = true
    void killProcessGroup(this.child, KILL_WAIT_MS)
      .then(() => {
        this.finishCancelled(reject)
      })
      .catch(() => {
        this.finishCancelled(reject)
      })
  }

  private finishCancelled(reject: (reason: Error) => void): void {
    this.finish(() => {
      reject(new PythonStartupError('Python environment bootstrap was cancelled', this.tail))
    })
  }

  private reject(reject: (reason: Error) => void, onAbort: () => void, message: string): void {
    this.finish(() => {
      this.signal.removeEventListener('abort', onAbort)
      reject(new PythonStartupError(message, this.tail))
    })
  }

  private onExit(event: {
    readonly resolve: (value: { stdout: string; tail: string }) => void
    readonly reject: (reason: Error) => void
    readonly onAbort: () => void
    readonly code: number | undefined
    readonly exitSignal: NodeJS.Signals | undefined
  }): void {
    this.finish(() => {
      this.signal.removeEventListener('abort', event.onAbort)
      if (event.code === 0) {
        event.resolve({ stdout: this.stdout, tail: this.tail })
        return
      }

      const message = `command failed (code=${String(event.code)}, signal=${String(event.exitSignal)})`
      event.reject(new PythonStartupError(message, this.tail))
    })
  }

  private finish(action: () => void): void {
    if (this.settled) {
      return
    }

    this.settled = true
    action()
  }

  async run(): Promise<{ stdout: string; tail: string }> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.abort(reject)
      }

      this.signal.addEventListener('abort', onAbort, { once: true })
      this.child.once('error', (error) => {
        this.reject(reject, onAbort, error.message)
      })
      this.child.once('exit', (code, exitSignal) => {
        if (!this.aborting) {
          this.onExit({
            resolve,
            reject,
            onAbort,
            code: code ?? undefined,
            exitSignal: exitSignal ?? undefined
          })
        }
      })
    })
  }
}

export async function captureCommand(
  command: string,
  args: readonly string[],
  signal: AbortSignal
): Promise<{ stdout: string; tail: string }> {
  if (signal.aborted) {
    throw new PythonStartupError('Python environment bootstrap was cancelled')
  }

  const child = spawn(command, [...args], {
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return new CommandCapture(child, signal).run()
}
