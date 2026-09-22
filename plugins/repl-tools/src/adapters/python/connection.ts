import { Buffer } from 'node:buffer'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { NdjsonDecoder, encodeNdjson } from '../../ndjson.ts'
import type { OutputStream } from '../../model.ts'
import { retireProcessGroup, type CleanupResult } from '../process-group.ts'
import { errorMessage } from '../protocol.ts'
import { decodePythonEvent, type PythonBrokerEvent } from './protocol.ts'
import type { PythonEvalResult, PythonEvent, PythonInterpreter } from './types.ts'

const brokerPath = fileURLToPath(new URL('../../../workers/python-kernel.py', import.meta.url))
const RETIRE_OPTIONS = {
  orderlyWaitMs: 4500,
  termWaitMs: 750,
  killWaitMs: 750,
  label: 'Python broker/kernel'
} as const

type PendingEval = {
  readonly jobId: string
  readonly resolve: (result: PythonEvalResult) => void
  readonly reject: (error: Error) => void
}

type PythonConnectionOptions = {
  readonly child: ChildProcessWithoutNullStreams
  readonly onEvent: (event: PythonEvent) => void
}

function chunkText(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
}

export class PythonConnection implements PythonInterpreter {
  private readonly decoder = new NdjsonDecoder<PythonBrokerEvent>(decodePythonEvent)
  private pending: PendingEval | undefined
  private closed = false
  private fatalSeen = false
  private shutdownRequested = false
  private shutdownPromise: Promise<CleanupResult> | undefined
  private readonly ready = Promise.withResolvers<string>()

  readonly language = 'python' as const

  constructor(private readonly options: PythonConnectionOptions) {
    options.child.stdout.on('data', (chunk) => {
      this.onStdout(chunk)
    })
    options.child.stderr.on('data', (chunk) => {
      this.emitOutput('system', chunk)
    })
    options.child.once('error', (error) => {
      this.fatal(error.message)
    })
    options.child.once('exit', (code, signal) => {
      this.onExit(code ?? undefined, signal ?? undefined)
    })
  }

  private onStdout(chunk: unknown): void {
    try {
      for (const event of this.decoder.push(chunkText(chunk))) {
        this.onBrokerEvent(event)
      }
    } catch (error) {
      this.fatal(errorMessage(error))
    }
  }

  private onBrokerEvent(event: PythonBrokerEvent): void {
    if (event.type === 'output' || event.type === 'waiting_input') {
      this.options.onEvent(event)
      return
    }

    if (event.type === 'done') {
      this.finishPending(event)
      return
    }

    this.onLifecycleEvent(event)
  }

  private onLifecycleEvent(
    event: Exclude<PythonBrokerEvent, { type: 'output' | 'done' | 'waiting_input' }>
  ): void {
    if (event.type === 'ready') {
      this.ready.resolve(event.pythonVersion)
      return
    }

    if (event.type === 'fatal') {
      this.fatal(event.message)
    }
  }

  private emitOutput(stream: OutputStream, chunk: unknown): void {
    this.options.onEvent({ type: 'output', stream, text: chunkText(chunk) })
  }

  private finishPending(event: Extract<PythonBrokerEvent, { type: 'done' }>): void {
    if (this.pending?.jobId !== event.jobId) {
      this.fatal(`Python broker completed unexpected job ${event.jobId}`)
      return
    }

    const current = this.pending
    this.pending = undefined
    current.resolve({
      ok: event.ok,
      ...(event.error !== undefined && { error: event.error })
    })
  }

  private failPending(error: Error): void {
    const current = this.pending
    this.pending = undefined
    current?.reject(error)
  }

  private fatal(message: string): void {
    if (!this.fatalSeen) {
      this.options.onEvent({ type: 'fatal', message })
    }

    this.fatalSeen = true
    const error = new Error(message)
    this.failPending(error)
    this.ready.reject(error)
  }

  private onExit(code: number | undefined, signal: NodeJS.Signals | undefined): void {
    this.closed = true
    const message = `Python broker exited (code=${String(code)}, signal=${String(signal)})`
    if (!this.shutdownRequested && !this.fatalSeen) {
      this.fatal(message)
    } else if (this.pending !== undefined) {
      this.failPending(new Error(message))
    }
  }

  private cancelStartup(): void {
    this.shutdownRequested = true
    this.ready.reject(new Error('Python REPL startup was cancelled'))
    void retireProcessGroup(this.options.child, RETIRE_OPTIONS)
  }

  private assertActive(jobId: string): void {
    if (this.closed || this.pending?.jobId !== jobId) {
      throw new Error(`job ${jobId} is not the active Python evaluation`)
    }
  }

  private requestShutdown(): void {
    if (!this.closed) {
      this.options.child.stdin.write(encodeNdjson({ type: 'shutdown' }))
    }
  }

  private finishShutdown(result: CleanupResult): CleanupResult {
    if (result.confirmed) {
      this.closed = true
    } else {
      this.shutdownPromise = undefined
    }

    return result
  }

  private async send(message: unknown): Promise<void> {
    if (this.closed) {
      throw new Error('Python broker is closed')
    }

    await new Promise<void>((resolve, reject) => {
      this.options.child.stdin.write(encodeNdjson(message), (error) => {
        if (error === null || error === undefined) {
          resolve()
        } else {
          reject(error)
        }
      })
    })
  }

  async waitUntilReady(signal: AbortSignal): Promise<string> {
    const abortStartup = () => {
      this.cancelStartup()
    }

    signal.addEventListener('abort', abortStartup, { once: true })
    try {
      return await this.ready.promise
    } finally {
      signal.removeEventListener('abort', abortStartup)
    }
  }

  async evaluate(jobId: string, code: string): Promise<PythonEvalResult> {
    if (this.closed) {
      throw new Error('Python broker is closed')
    }

    if (this.pending !== undefined) {
      throw new Error('Python broker already has an active evaluation')
    }

    return new Promise((resolve, reject) => {
      this.pending = { jobId, resolve, reject }
      void this.send({ type: 'execute', jobId, code }).catch((error: unknown) => {
        if (this.pending?.jobId === jobId) {
          this.pending = undefined
        }

        reject(error instanceof Error ? error : new Error(errorMessage(error)))
      })
    })
  }

  async stdin(jobId: string, data: string): Promise<void> {
    this.assertActive(jobId)
    await this.send({ type: 'stdin', jobId, data })
  }

  async interrupt(jobId: string): Promise<void> {
    this.assertActive(jobId)
    await this.send({ type: 'interrupt', jobId })
  }

  async shutdown(): Promise<CleanupResult> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise
    }

    this.shutdownRequested = true
    const current = retireProcessGroup(this.options.child, {
      ...RETIRE_OPTIONS,
      orderly: () => {
        this.requestShutdown()
      }
    })
    this.shutdownPromise = current.then((result) => this.finishShutdown(result))
    return this.shutdownPromise
  }

  alive(): boolean {
    const { child } = this.options
    return !this.closed && child.exitCode === null && child.signalCode === null
  }
}

export function spawnPythonConnection(options: {
  readonly python: string
  readonly cwd: string
  readonly onEvent: (event: PythonEvent) => void
}): PythonConnection {
  const child = spawn(options.python, [brokerPath, '--cwd', options.cwd], {
    cwd: options.cwd,
    env: process.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  return new PythonConnection({
    child,
    onEvent: options.onEvent
  })
}
