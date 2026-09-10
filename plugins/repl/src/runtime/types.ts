import crypto from 'node:crypto'
import type { Plugin } from '@opencode/plugin/effect'
import type { Effect, Scope } from 'effect'
import { NodeStartupError, type NodeImage, type NodeInterpreter } from '../adapters/node.ts'
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
const HISTORY_LIMIT = 20
export const PREVIEW_BYTES = 16 * 1024
export const FOREGROUND_MS = 5000
export const CANCEL_GRACE_MS = 2000
export const SESSION_ID_KEY = 'sessionID' as const

export type SessionId = Parameters<Plugin.Context['session']['get']>[0]['sessionID']
export type ToolCallContext = { readonly sessionID: SessionId }
export type Interpreter = NodeInterpreter | PythonInterpreter
export type CleanupRetry = () => Promise<CleanupResult>
type CellLifecycle = 'healthy' | 'starting' | 'live' | 'retiring' | 'failed'

type SignalPair = {
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
  readonly images: NodeImage[]
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
  readonly sessionID: SessionId
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

export type ReplOperationResult = {
  readonly output: JobOperationOutput
  readonly images: readonly NodeImage[]
}

export type ReplRuntime = {
  readonly evaluate: (
    language: Language,
    code: string,
    context: ToolCallContext
  ) => Effect.Effect<ReplOperationResult>
  readonly job: (input: JobInput, context: ToolCallContext) => Effect.Effect<ReplOperationResult>
  readonly reset: (language: Language, context: ToolCallContext) => Effect.Effect<ResetOutput>
  readonly invalidateSession: (sessionID: SessionId) => Effect.Effect<void>
}

function signalPair(): SignalPair {
  let isSettled = false
  const { promise, resolve: resolvePromise } = Promise.withResolvers<void>()
  return {
    promise,
    resolve() {
      if (isSettled) {
        return
      }

      isSettled = true
      resolvePromise()
    }
  }
}

const TERMINAL_STATES = new Set<JobState>(['succeeded', 'failed', 'cancelled'])

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state)
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

export function cellKey(sessionID: SessionId, language: Language): string {
  return `${sessionID}\0${language}`
}

export function isSameCell(map: Map<string, Cell>, cell: Cell): boolean {
  return map.get(cellKey(cell.sessionID, cell.language)) === cell
}

export function findJob(cell: Cell | undefined, id: string): Job | undefined {
  if (cell === undefined) {
    return undefined
  }

  const { active } = cell
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
  if (isTerminal(job.state)) {
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
    images: [],
    state: 'starting',
    inputSerial: 0,
    inputNotificationSerial: 0,
    backgrounded: false,
    notificationSuppressed: false,
    terminalNotificationDone: false,
    cancelRequested: false
  }
}

function cleanupRetry(error: unknown): CleanupRetry | undefined {
  if (error instanceof NodeStartupError) {
    return error.retryCleanup
  }

  if (error instanceof PythonStartupError) {
    return error.retryCleanup
  }

  return undefined
}

export function startupCleanup(error: unknown): {
  readonly unconfirmed: boolean
  readonly retry?: CleanupRetry
} {
  const retry = cleanupRetry(error)
  return retry === undefined ? { unconfirmed: false } : { unconfirmed: true, retry }
}
