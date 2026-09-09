import { Buffer } from 'node:buffer'
import type { ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { NdjsonDecoder, encodeNdjson } from '../ndjson.ts'
import type { OutputStream } from '../model.ts'
import { decodeNodeEvent, type NodeWorkerEvent } from './node-protocol.ts'
import { retireProcessGroup, signalProcessGroup, type CleanupResult } from './process-group.ts'
import type { NodeEvalResult, NodeEvent, NodeInterpreter } from './node-types.ts'
import { errorMessage } from './protocol.ts'

const RETIRE_OPTIONS = {
  orderlyWaitMs: 350,
  termWaitMs: 500,
  killWaitMs: 750,
  label: 'Node REPL'
} as const

type PendingEval = {
  readonly jobId: string
  readonly resolve: (result: NodeEvalResult) => void
  readonly reject: (error: Error) => void
}

type NodeConnectionOptions = {
  readonly child: ChildProcess
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly control: Writable
  readonly events: Readable
  readonly onEvent: (event: NodeEvent) => void
}

function readable(value: unknown, label: string): Readable {
  if (value instanceof Readable) {
    return value
  }

  throw new Error(`Node REPL ${label} pipe is unavailable`)
}

function writable(value: unknown, label: string): Writable {
  if (value instanceof Writable) {
    return value
  }

  throw new Error(`Node REPL ${label} pipe is unavailable`)
}

function nodeMajor(version: string): number | undefined {
  const major = /^v?(?<major>\d+)(?:\.|$)/v.exec(version)?.groups?.major
  return major === undefined ? undefined : Number(major)
}

function chunkText(chunk: unknown): string {
  return Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
}

async function retirement(child: ChildProcess, orderly?: () => void): Promise<CleanupResult> {
  return retireProcessGroup(child, { ...RETIRE_OPTIONS, orderly })
}

class NodeConnection implements NodeInterpreter {
  private readonly decoder = new NdjsonDecoder<NodeWorkerEvent>(decodeNodeEvent)
  private pending: PendingEval | undefined
  private activeJobId: string | undefined
  private closed = false
  private fatalSeen = false
  private shutdownRequested = false
  private shutdownPromise: Promise<CleanupResult> | undefined
  private readyResolve!: (version: string) => void
  private readyReject!: (error: Error) => void
  private readonly ready = new Promise<string>((resolve, reject) => {
    this.readyResolve = resolve
    this.readyReject = reject
  })

  readonly language = 'node' as const

  constructor(private readonly options: NodeConnectionOptions) {
    this.bindStreams()
    this.bindProcess()
  }

  private bindStreams(): void {
    this.options.stdout.on('data', (chunk) => {
      this.emitOutput('stdout', chunk)
    })
    this.options.stderr.on('data', (chunk) => {
      this.emitOutput('stderr', chunk)
    })
    this.options.events.on('data', (chunk) => {
      this.onEventChunk(chunk)
    })
  }

  private bindProcess(): void {
    this.options.child.once('error', (error) => {
      this.fatal(error.message)
    })
    this.options.child.once('exit', (code, signal) => {
      this.onExit(code ?? undefined, signal ?? undefined)
    })
  }

  private emitOutput(stream: OutputStream, chunk: unknown): void {
    this.options.onEvent({ type: 'output', stream, text: chunkText(chunk) })
  }

  private onEventChunk(chunk: unknown): void {
    try {
      for (const event of this.decoder.push(chunkText(chunk))) {
        this.onWorkerEvent(event)
      }
    } catch (error) {
      this.fatal(errorMessage(error))
    }
  }

  private onWorkerEvent(event: NodeWorkerEvent): void {
    if (event.type === 'output') {
      this.options.onEvent(event)
      return
    }

    if (event.type === 'done') {
      this.finishPending(event)
      return
    }

    this.onLifecycleEvent(event)
  }

  private onLifecycleEvent(event: Exclude<NodeWorkerEvent, { type: 'output' | 'done' }>): void {
    if (event.type === 'ready') {
      this.readyResolve(event.nodeVersion)
      return
    }

    if (event.type === 'fatal') {
      this.fatal(event.message)
    }
  }

  private finishPending(event: Extract<NodeWorkerEvent, { type: 'done' }>): void {
    if (this.pending?.jobId !== event.jobId) {
      this.fatal(`Node worker completed unexpected job ${event.jobId}`)
      return
    }

    const current = this.pending
    this.pending = undefined
    this.activeJobId = undefined
    current.resolve({ ok: event.ok, ...(event.error !== undefined && { error: event.error }) })
  }

  private failPending(error: Error): void {
    const current = this.pending
    this.pending = undefined
    this.activeJobId = undefined
    current?.reject(error)
  }

  private fatal(message: string): void {
    if (!this.fatalSeen) {
      this.options.onEvent({ type: 'fatal', message })
    }

    this.fatalSeen = true
    const error = new Error(message)
    this.failPending(error)
    this.readyReject(error)
  }

  private onExit(code: number | undefined, signal: NodeJS.Signals | undefined): void {
    this.closed = true
    const message = `Node REPL worker exited (code=${String(code)}, signal=${String(signal)})`
    if (!this.shutdownRequested && !this.fatalSeen) {
      this.fatal(message)
    } else if (this.pending !== undefined) {
      this.failPending(new Error(message))
    }
  }

  private cancelStartup(): void {
    if (this.closed) {
      return
    }

    this.shutdownRequested = true
    this.readyReject(new Error('Node REPL startup was cancelled'))
    void retirement(this.options.child)
  }

  private isPending(jobId: string): boolean {
    const { pending } = this
    return pending?.jobId === jobId
  }

  private clearPending(): void {
    this.pending = undefined
    this.activeJobId = undefined
  }

  private assertActive(jobId: string): void {
    if (this.closed || this.activeJobId !== jobId) {
      throw new Error(`job ${jobId} is not the active Node evaluation`)
    }
  }

  private requestShutdown(): void {
    if (!this.closed && !this.options.control.destroyed) {
      this.options.control.write(encodeNdjson({ type: 'shutdown' }))
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

  private async sendControl(message: unknown): Promise<void> {
    if (this.closed) {
      throw new Error('Node REPL worker is closed')
    }

    await new Promise<void>((resolve, reject) => {
      this.options.control.write(encodeNdjson(message), (error) => {
        if (error === null || error === undefined) {
          resolve()
        } else {
          reject(error)
        }
      })
    })
  }

  async waitUntilReady(signal: AbortSignal): Promise<void> {
    const abortStartup = () => {
      this.cancelStartup()
    }

    signal.addEventListener('abort', abortStartup, { once: true })
    try {
      const version = await this.ready
      const major = nodeMajor(version)
      if (major === undefined || major < 26) {
        throw new Error(`Node REPL requires Node >= 26; configured executable reported ${version}`)
      }
    } finally {
      signal.removeEventListener('abort', abortStartup)
    }
  }

  async evaluate(jobId: string, code: string): Promise<NodeEvalResult> {
    if (this.closed) {
      throw new Error('Node REPL worker is closed')
    }

    if (this.pending !== undefined) {
      throw new Error('Node REPL already has an active evaluation')
    }

    return new Promise((resolve, reject) => {
      this.pending = { jobId, resolve, reject }
      this.activeJobId = jobId
      void this.sendControl({ type: 'eval', jobId, code }).catch((error: unknown) => {
        if (this.isPending(jobId)) {
          this.clearPending()
        }

        reject(error instanceof Error ? error : new Error(errorMessage(error)))
      })
    })
  }

  async stdin(jobId: string, data: string): Promise<void> {
    this.assertActive(jobId)
    await new Promise<void>((resolve, reject) => {
      this.options.stdin.write(data, (error) => {
        if (error === null || error === undefined) {
          resolve()
        } else {
          reject(error)
        }
      })
    })
  }

  async interrupt(jobId: string): Promise<void> {
    this.assertActive(jobId)
    const { pid } = this.options.child
    if (pid === undefined) {
      throw new Error('Node REPL worker PID is unavailable')
    }

    signalProcessGroup(pid, 'SIGINT')
  }

  async shutdown(): Promise<CleanupResult> {
    if (this.shutdownPromise !== undefined) {
      return this.shutdownPromise
    }

    this.shutdownRequested = true
    const current = retirement(this.options.child, () => {
      this.requestShutdown()
    })
    this.shutdownPromise = current.then((result) => this.finishShutdown(result))
    return this.shutdownPromise
  }

  alive(): boolean {
    const { child } = this.options
    return !this.closed && child.exitCode === null && child.signalCode === null
  }
}

function connectionOptions(
  child: ChildProcess,
  onEvent: (event: NodeEvent) => void
): NodeConnectionOptions {
  return {
    child,
    stdin: writable(child.stdin, 'stdin'),
    stdout: readable(child.stdout, 'stdout'),
    stderr: readable(child.stderr, 'stderr'),
    control: writable(child.stdio[3], 'control'),
    events: readable(child.stdio[4], 'event'),
    onEvent
  }
}

export function createNodeConnection(
  child: ChildProcess,
  onEvent: (event: NodeEvent) => void
): NodeInterpreter & { waitUntilReady(signal: AbortSignal): Promise<void> } {
  return new NodeConnection(connectionOptions(child, onEvent))
}
