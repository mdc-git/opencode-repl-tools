import crypto from 'node:crypto'
import type { Plugin } from '@opencode/plugin/effect'
import type { Effect, Scope } from 'effect'
import { NodeStartupError, type NodeInterpreter } from '../adapters/node.ts'
import { PythonStartupError, type PythonInterpreter } from '../adapters/python.ts'
import type { CleanupResult } from '../adapters/process-group.ts'
import type {
  ErrorKind,
  JobInput,
  JobOperationOutput,
  JobState,
  Language,
  ReplError,
  ResetOutput
} from '../model.ts'
import type { OutputRing } from '../output-ring.ts'

export const TRANSCRIPT_BYTES = 1024 * 1024
export const HISTORY_LIMIT = 20
export const PREVIEW_BYTES = 16 * 1024
export const FOREGROUND_MS = 5_000
export const CANCEL_GRACE_MS = 2_000

export type SessionID = Parameters<Plugin.Context['session']['get']>[0]['sessionID']
export type ToolCallContext = { readonly sessionID: SessionID }
export type Interpreter = NodeInterpreter | PythonInterpreter
export type CleanupRetry = () => Promise<CleanupResult>
export type CellLifecycle = 'healthy' | 'starting' | 'live' | 'retiring' | 'failed'

export type SignalPair = {
  readonly promise: Promise<void>
  readonly resolve: () => void
}

export type Job = {
  readonly id: string
  readonly language: Language
  readonly startCursor: number
  readonly acceptedAt: number
  readonly foreground: SignalPair
  readonly completion: SignalPair
  state: JobState
  error?: ReplError
  prompt?: string
  password?: boolean
  inputSerial: number
  inputNotificationSerial: number
  backgrounded: boolean
  notificationSuppressed: boolean
  terminalNotificationDone: boolean
  cancelRequested: boolean
  startupAbort?: AbortController
}

export type Cell = {
  readonly sessionID: SessionID
  readonly language: Language
  readonly directory: string
  readonly transcript: OutputRing
  history: Job[]
  scope: Scope.Closeable
  lifecycle: CellLifecycle
  interpreter?: Interpreter
  active?: Job
  cleanupError?: string
  cleanupRetry?: CleanupRetry
  notificationsSuppressed: boolean
}

export type ReplRuntime = {
  readonly evaluate: (
    language: Language,
    code: string,
    context: ToolCallContext
  ) => Effect.Effect<JobOperationOutput>
  readonly job: (input: JobInput, context: ToolCallContext) => Effect.Effect<JobOperationOutput>
  readonly reset: (language: Language, context: ToolCallContext) => Effect.Effect<ResetOutput>
  readonly invalidateSession: (sessionID: SessionID) => Effect.Effect<void>
}

export function signalPair(): SignalPair {
  let settled = false
  let resolvePromise!: () => void
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve() {
      if (settled) {
        return
      }
      settled = true
      resolvePromise()
    }
  }
}

export function terminal(state: JobState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled'
}

export function expected(kind: ErrorKind, message: string): JobOperationOutput {
  return { ok: false, error: { kind, message } }
}

export function resetError(kind: ErrorKind, message: string): ResetOutput {
  return { ok: false, error: { kind, message } }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  const value = (error as { readonly message?: unknown } | undefined)?.message
  return typeof value === 'string' ? value : String(error)
}

export function cellKey(sessionID: SessionID, language: Language): string {
  return `${String(sessionID)}\0${language}`
}

export function sameCell(map: Map<string, Cell>, cell: Cell): boolean {
  return map.get(cellKey(cell.sessionID, cell.language)) === cell
}

export function findJob(cell: Cell | undefined, id: string): Job | undefined {
  if (cell === undefined) {
    return undefined
  }
  const active = cell.active
  if (active?.id === id) {
    return active
  }
  return cell.history.find((job) => job.id === id)
}

function retainJob(cell: Cell, job: Job): void {
  cell.history.push(job)
  const extra = cell.history.length - HISTORY_LIMIT
  if (extra > 0) {
    cell.history.splice(0, extra)
  }
}

function restoreLifecycle(cell: Cell): void {
  if (cell.lifecycle === 'failed' || cell.lifecycle === 'retiring') {
    return
  }
  cell.lifecycle = cell.interpreter === undefined ? 'healthy' : 'live'
}

export function finishJob(
  cell: Cell,
  job: Job,
  state: Extract<JobState, 'succeeded' | 'failed' | 'cancelled'>,
  error?: ReplError
): void {
  if (terminal(job.state)) {
    return
  }
  job.state = state
  job.error = error
  job.prompt = undefined
  job.password = undefined
  if (cell.active === job) {
    cell.active = undefined
  }
  retainJob(cell, job)
  job.foreground.resolve()
  job.completion.resolve()
  restoreLifecycle(cell)
}

export function newJob(cell: Cell, language: Language): Job {
  return {
    id: crypto.randomUUID(),
    language,
    startCursor: cell.transcript.cursor,
    acceptedAt: Date.now(),
    foreground: signalPair(),
    completion: signalPair(),
    state: 'starting',
    inputSerial: 0,
    inputNotificationSerial: 0,
    backgrounded: false,
    notificationSuppressed: false,
    terminalNotificationDone: false,
    cancelRequested: false
  }
}

function asStartupError(error: unknown): NodeStartupError | PythonStartupError | undefined {
  if (error instanceof NodeStartupError) {
    return error
  }
  if (error instanceof PythonStartupError) {
    return error
  }
  return undefined
}

export function startupCleanup(error: unknown): {
  readonly unconfirmed: boolean
  readonly retry?: CleanupRetry
} {
  const startupError = asStartupError(error)
  if (startupError === undefined) {
    return { unconfirmed: false }
  }
  if (startupError.cleanupConfirmed !== false) {
    return { unconfirmed: false }
  }
  return { unconfirmed: true, retry: startupError.retryCleanup }
}
