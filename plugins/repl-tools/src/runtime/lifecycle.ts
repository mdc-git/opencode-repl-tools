import { Effect, Exit, Scope } from 'effect'
import type { CleanupResult } from '../adapters/process-group.ts'
import type { JobOperationOutput, ResetOutput } from '../model.ts'
import { safeRetry, safeShutdown } from './cleanup.ts'
import { snapshot } from './output.ts'
import type { RuntimeState } from './state.ts'
import {
  CANCEL_GRACE_MS,
  cellKey,
  errorMessage,
  expected,
  finishJob,
  isSameCell,
  isTerminal,
  resetError,
  type Cell,
  type Interpreter,
  type Job
} from './types.ts'

type CancelPreparation =
  | { readonly kind: 'gone' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'terminal' }
  | { readonly kind: 'starting' }
  | { readonly kind: 'active'; readonly interpreter: Interpreter }

type ImmediateCancelPreparation = Extract<
  CancelPreparation,
  { readonly kind: 'gone' | 'failed' | 'terminal' }
>

function cleanupError(cell: Cell, fallback: string): string {
  return cell.cleanupError ?? fallback
}

function existingCancelState(
  map: Map<string, Cell>,
  cell: Cell,
  job: Job
): CancelPreparation | undefined {
  if (!isSameCell(map, cell)) {
    return { kind: 'gone' }
  }

  if (isTerminal(job.state)) {
    return { kind: 'terminal' }
  }

  if (cell.lifecycle === 'failed') {
    return { kind: 'failed' }
  }

  return undefined
}

function abortStartup(job: Job): void {
  if (job.state !== 'starting') {
    return
  }

  const controller = job.startupAbort
  if (controller !== undefined) {
    controller.abort()
  }
}

function prepareCancel(map: Map<string, Cell>, cell: Cell, job: Job): CancelPreparation {
  const existing = existingCancelState(map, cell, job)
  if (existing !== undefined) {
    return existing
  }

  job.cancelRequested = true
  job.notificationSuppressed = true
  const { interpreter } = cell
  if (interpreter === undefined) {
    abortStartup(job)
    return { kind: 'starting' }
  }

  return { kind: 'active', interpreter }
}

async function interruptWithGrace(cell: Cell, job: Job, interpreter: Interpreter): Promise<void> {
  try {
    await interpreter.interrupt(job.id)
  } catch (error) {
    cell.transcript.append('system', `[interrupt failed] ${errorMessage(error)}\n`, job.id)
    return
  }

  await Promise.race([
    job.completion.promise,
    new Promise<void>((resolve) => {
      setTimeout(resolve, CANCEL_GRACE_MS)
    })
  ])
}

function markCancelRetiring(map: Map<string, Cell>, cell: Cell) {
  if (!isSameCell(map, cell)) {
    return undefined
  }

  cell.lifecycle = 'retiring'
  return cell.scope
}

function failCancelCleanup(cell: Cell, job: Job, interpreter: Interpreter, message: string): void {
  cell.lifecycle = 'failed'
  cell.cleanupError = message
  cell.cleanupRetry = async () => interpreter.shutdown()
  cell.transcript.append('system', `[cleanup unconfirmed] ${message}\n`, job.id)
  finishJob(cell, job, 'failed', { kind: 'lifecycle', message })
}

function finishHardCancel(cell: Cell, job: Job, interpreter: Interpreter): void {
  if (cell.interpreter === interpreter) {
    cell.interpreter = undefined
  }

  cell.transcript.append('system', '[interpreter retired after cancellation]\n', job.id)
  finishJob(cell, job, 'cancelled')
  cell.cleanupError = undefined
  cell.cleanupRetry = undefined
}

function hardRetireForCancel(
  state: RuntimeState,
  cell: Cell,
  job: Job,
  interpreter: Interpreter
): Effect.Effect<JobOperationOutput> {
  return Effect.gen(function* () {
    const oldScope = yield* state.locked((map) => Effect.sync(() => markCancelRetiring(map, cell)))
    if (oldScope === undefined) {
      return expected('not_found', `job ${job.id} was invalidated`)
    }

    const cleanup = yield* Effect.promise(async () => safeShutdown(interpreter))
    if (!cleanup.confirmed) {
      const message = cleanup.message ?? 'hard cancellation teardown could not be confirmed'
      yield* state.locked(() =>
        Effect.sync(() => {
          failCancelCleanup(cell, job, interpreter, message)
        })
      )
      return expected('lifecycle', message)
    }

    yield* state.locked(() =>
      Effect.sync(() => {
        finishHardCancel(cell, job, interpreter)
      })
    )
    yield* state.replaceCellScope(cell, oldScope)
    return snapshot(cell, job, job.startCursor, true)
  })
}

function preparedCancelResult(
  cell: Cell,
  job: Job,
  prepared: ImmediateCancelPreparation
): JobOperationOutput {
  if (prepared.kind === 'gone') {
    return expected('not_found', `job ${job.id} was invalidated`)
  }

  if (prepared.kind === 'failed') {
    return expected('lifecycle', cleanupError(cell, 'Cell teardown is unconfirmed'))
  }

  return snapshot(cell, job, job.startCursor, true)
}

function waitStartingCancel(cell: Cell, job: Job): Effect.Effect<JobOperationOutput> {
  return Effect.promise(async () => job.completion.promise).pipe(
    Effect.map(() =>
      cell.lifecycle === 'failed'
        ? expected('lifecycle', cleanupError(cell, 'startup cleanup is unconfirmed'))
        : snapshot(cell, job, job.startCursor, true)
    )
  )
}

function canReturnAfterInterrupt(job: Job, interpreter: Interpreter): boolean {
  return isTerminal(job.state) && interpreter.alive()
}

function cancelActive(
  state: RuntimeState,
  cell: Cell,
  job: Job,
  interpreter: Interpreter
): Effect.Effect<JobOperationOutput> {
  return Effect.gen(function* () {
    yield* Effect.promise(async () => interruptWithGrace(cell, job, interpreter))
    if (canReturnAfterInterrupt(job, interpreter)) {
      return snapshot(cell, job, job.startCursor, true)
    }

    return yield* hardRetireForCancel(state, cell, job, interpreter)
  })
}

export function cancelWork(
  state: RuntimeState,
  cell: Cell,
  job: Job
): Effect.Effect<JobOperationOutput> {
  return Effect.gen(function* () {
    const prepared = yield* state.locked((map) => Effect.sync(() => prepareCancel(map, cell, job)))
    if (prepared.kind === 'starting') {
      return yield* waitStartingCancel(cell, job)
    }

    if (prepared.kind === 'active') {
      return yield* cancelActive(state, cell, job, prepared.interpreter)
    }

    return preparedCancelResult(cell, job, prepared)
  })
}

type ResetPreparation = {
  readonly interpreter?: Interpreter
  readonly retry: Cell['cleanupRetry']
  readonly scope: Cell['scope']
  readonly active: Job | undefined
}

function suppressActive(active: Job | undefined): void {
  if (active === undefined) {
    return
  }

  if (isTerminal(active.state)) {
    return
  }

  active.cancelRequested = true
  active.notificationSuppressed = true
  abortStartup(active)
}

function prepareReset(map: Map<string, Cell>, cell: Cell): ResetPreparation | undefined {
  if (!isSameCell(map, cell)) {
    return undefined
  }

  cell.notificationsSuppressed = true
  if (cell.lifecycle !== 'failed') {
    cell.lifecycle = 'retiring'
  }

  const { active } = cell
  suppressActive(active)
  return { interpreter: cell.interpreter, retry: cell.cleanupRetry, scope: cell.scope, active }
}

function currentCleanup(cell: Cell) {
  return {
    interpreter: cell.interpreter,
    retry: cell.cleanupRetry,
    lifecycle: cell.lifecycle
  }
}

function cleanupCell(cell: Cell): Effect.Effect<CleanupResult> {
  const current = currentCleanup(cell)
  const { interpreter } = current
  if (interpreter !== undefined) {
    return Effect.promise(async () => safeShutdown(interpreter))
  }

  if (current.lifecycle !== 'failed') {
    return Effect.succeed({ confirmed: true })
  }

  const { retry } = current
  if (retry === undefined) {
    return Effect.succeed({
      confirmed: false,
      message: cleanupError(cell, 'failed Cell has no viable cleanup handle')
    })
  }

  return Effect.promise(async () => safeRetry(retry))
}

function failReset(cell: Cell, cleanup: CleanupResult): string {
  const message = cleanup.message ?? 'reset could not confirm interpreter teardown'
  cell.lifecycle = 'failed'
  cell.cleanupError = message
  if (cell.active !== undefined && !isTerminal(cell.active.state)) {
    finishJob(cell, cell.active, 'failed', { kind: 'lifecycle', message })
  }

  return message
}

function removeResetCell(map: Map<string, Cell>, cell: Cell): void {
  if (cell.active !== undefined && !isTerminal(cell.active.state)) {
    finishJob(cell, cell.active, 'cancelled')
  }

  map.delete(cellKey(cell.sessionID, cell.language))
}

function startupCompletion(prepared: ResetPreparation): Promise<void> | undefined {
  if (prepared.interpreter !== undefined) {
    return undefined
  }

  if (prepared.active?.state !== 'starting') {
    return undefined
  }

  return prepared.active.completion.promise
}

export function resetCell(state: RuntimeState, cell: Cell): Effect.Effect<ResetOutput> {
  return Effect.gen(function* () {
    const prepared = yield* state.locked((map) => Effect.sync(() => prepareReset(map, cell)))
    if (prepared === undefined) {
      return { ok: true, language: cell.language }
    }

    const completion = startupCompletion(prepared)
    if (completion !== undefined) {
      yield* Effect.promise(async () => completion)
    }

    const cleanup = yield* cleanupCell(cell)
    if (!cleanup.confirmed) {
      const message = yield* state.locked(() => Effect.sync(() => failReset(cell, cleanup)))
      return resetError('lifecycle', message)
    }

    yield* state.locked((map) =>
      Effect.sync(() => {
        removeResetCell(map, cell)
      })
    )
    yield* Scope.close(prepared.scope, Exit.void)
    return { ok: true, language: cell.language }
  })
}
