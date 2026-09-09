import { Effect, Fiber } from 'effect'
import type { JobInput, JobOperationOutput } from '../model.ts'
import { admitEvaluation } from './admission.ts'
import { runJob } from './execution.ts'
import { invalidateCells } from './invalidation.ts'
import { cancelWork, resetCell } from './lifecycle.ts'
import { snapshot } from './output.ts'
import type { RuntimeState } from './state.ts'
import {
  FOREGROUND_MS,
  cellKey,
  errorMessage,
  expected,
  findJob,
  terminal,
  type Cell,
  type Job,
  type ReplRuntime,
  type ToolCallContext
} from './types.ts'

type FoundJob = {
  readonly cell: Cell
  readonly job: Job
}

function foregroundRemaining(job: Job): number {
  return Math.max(0, FOREGROUND_MS - (Date.now() - job.acceptedAt))
}

async function waitForeground(state: RuntimeState, cell: Cell, job: Job, signal: AbortSignal) {
  return new Promise<'wake' | 'timeout'>((resolve) => {
    let done = false
    const finish = (value: 'wake' | 'timeout') => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => {
      if (job.backgrounded || terminal(job.state)) {
        return
      }
      job.notificationSuppressed = true
      state.dispatch(cancelWork(state, cell, job).pipe(Effect.asVoid))
    }
    const timer = setTimeout(() => finish('timeout'), foregroundRemaining(job))
    signal.addEventListener('abort', onAbort, { once: true })
    void job.foreground.promise.then(
      () => finish('wake'),
      () => finish('wake')
    )
  })
}

function foregroundSnapshot(cell: Cell, job: Job): JobOperationOutput {
  if (terminal(job.state)) {
    job.terminalNotificationDone = true
    return snapshot(cell, job, job.startCursor, true)
  }
  job.backgrounded = true
  if (job.state === 'waiting_input') {
    job.inputNotificationSerial = job.inputSerial
  }
  return snapshot(cell, job, job.startCursor, true)
}

function evaluate(state: RuntimeState): ReplRuntime['evaluate'] {
  return (language, code, context) =>
    Effect.gen(function* () {
      const validation = yield* state.validateSession(context.sessionID)
      if (!validation.ok) {
        return expected(validation.error.kind, validation.error.message)
      }
      const admitted = yield* admitEvaluation(
        state,
        language,
        context,
        validation.session.location.directory
      )
      if ('error' in admitted) {
        return admitted.error
      }
      yield* runJob(state, admitted.cell, admitted.job, code).pipe(
        Effect.forkIn(admitted.cell.scope)
      )
      yield* Effect.tryPromise({
        try: async (signal) => waitForeground(state, admitted.cell, admitted.job, signal),
        catch: (cause) => new Error(errorMessage(cause))
      }).pipe(Effect.orDie)
      return yield* state.locked(() =>
        Effect.sync(() => foregroundSnapshot(admitted.cell, admitted.job))
      )
    })
}

function findInCell(cell: Cell | undefined, id: string): FoundJob | undefined {
  if (cell === undefined) {
    return undefined
  }
  const job = findJob(cell, id)
  if (job === undefined) {
    return undefined
  }
  return { cell, job }
}

function findSessionJob(
  map: Map<string, Cell>,
  sessionID: ToolCallContext['sessionID'],
  id: string
) {
  const node = findInCell(map.get(cellKey(sessionID, 'node')), id)
  if (node !== undefined) {
    return node
  }
  return findInCell(map.get(cellKey(sessionID, 'python')), id)
}

function statusOperation(found: FoundJob, input: Extract<JobInput, { action: 'status' }>) {
  const cursor = input.cursor ?? found.job.startCursor
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    return expected('invalid_state', 'cursor must be a non-negative integer')
  }
  return snapshot(found.cell, found.job, cursor)
}

function nodeStdinAllowed(job: Job): boolean {
  return !terminal(job.state) && job.state !== 'starting'
}

function stdinAllowed(found: FoundJob): boolean {
  if (found.cell.active !== found.job) {
    return false
  }
  if (found.cell.interpreter === undefined) {
    return false
  }
  if (found.job.language === 'python') {
    return found.job.state === 'waiting_input'
  }
  return nodeStdinAllowed(found.job)
}

async function sendStdin(found: FoundJob, data: string) {
  try {
    const interpreter = found.cell.interpreter
    if (interpreter === undefined) {
      throw new Error('REPL interpreter is unavailable')
    }
    await interpreter.stdin(found.job.id, data)
    return { ok: true as const }
  } catch (error) {
    return { ok: false as const, error }
  }
}

function resumePythonAfterInput(found: FoundJob): void {
  if (found.job.language !== 'python' || found.job.state !== 'waiting_input') {
    return
  }
  found.job.state = 'running'
  found.job.prompt = undefined
  found.job.password = undefined
}

function stdinOperation(
  state: RuntimeState,
  found: FoundJob,
  input: Extract<JobInput, { action: 'stdin' }>
): Effect.Effect<JobOperationOutput> {
  if (!stdinAllowed(found)) {
    return Effect.succeed(
      expected(
        'invalid_state',
        `stdin is not valid while job ${found.job.id} is ${found.job.state}`
      )
    )
  }
  return Effect.gen(function* () {
    const sent = yield* Effect.promise(() => sendStdin(found, input.data))
    if (!sent.ok) {
      return expected('runtime', `stdin failed: ${errorMessage(sent.error)}`)
    }
    yield* state.locked(() => Effect.sync(() => resumePythonAfterInput(found)))
    return snapshot(found.cell, found.job, found.job.startCursor, true)
  })
}

function cancelOperation(state: RuntimeState, found: FoundJob): Effect.Effect<JobOperationOutput> {
  if (terminal(found.job.state)) {
    return Effect.succeed(snapshot(found.cell, found.job, found.job.startCursor, true))
  }
  if (found.cell.lifecycle === 'failed') {
    return Effect.succeed(
      expected('lifecycle', found.cell.cleanupError ?? 'Cell teardown is unconfirmed')
    )
  }
  return Effect.gen(function* () {
    const fiber = yield* cancelWork(state, found.cell, found.job).pipe(
      Effect.forkIn(state.activationScope)
    )
    return yield* Fiber.join(fiber)
  })
}

function operateFound(state: RuntimeState, found: FoundJob, input: JobInput) {
  if (input.action === 'status') {
    return Effect.succeed(statusOperation(found, input))
  }
  if (input.action === 'stdin') {
    return stdinOperation(state, found, input)
  }
  return cancelOperation(state, found)
}

function jobOperation(state: RuntimeState): ReplRuntime['job'] {
  return (input, context) =>
    Effect.gen(function* () {
      const validation = yield* state.validateSession(context.sessionID)
      if (!validation.ok) {
        return expected(validation.error.kind, validation.error.message)
      }
      const found = yield* state.locked((map) =>
        Effect.sync(() => findSessionJob(map, context.sessionID, input.id))
      )
      if (found === undefined) {
        return expected('not_found', `job ${input.id} was not found in this OpenCode session`)
      }
      return yield* operateFound(state, found, input)
    })
}

function resetOperation(state: RuntimeState): ReplRuntime['reset'] {
  return (language, context) =>
    Effect.gen(function* () {
      const validation = yield* state.validateSession(context.sessionID)
      if (!validation.ok) {
        return { ok: false, error: validation.error }
      }
      const cell = yield* state.locked((map) =>
        Effect.sync(() => state.getCell(map, context.sessionID, language))
      )
      if (cell === undefined) {
        return { ok: true, language }
      }
      const fiber = yield* resetCell(state, cell).pipe(Effect.forkIn(state.activationScope))
      return yield* Fiber.join(fiber)
    })
}

function takeSessionCells(map: Map<string, Cell>, sessionID: ToolCallContext['sessionID']): Cell[] {
  const targets: Cell[] = []
  for (const language of ['node', 'python'] as const) {
    const key = cellKey(sessionID, language)
    const cell = map.get(key)
    if (cell === undefined) {
      continue
    }
    cell.notificationsSuppressed = true
    targets.push(cell)
    map.delete(key)
  }
  return targets
}

export function takeAllCells(map: Map<string, Cell>): Cell[] {
  const values = [...map.values()]
  map.clear()
  for (const cell of values) {
    cell.notificationsSuppressed = true
  }
  return values
}

export function createRuntimeOperations(state: RuntimeState): ReplRuntime {
  return {
    evaluate: evaluate(state),
    job: jobOperation(state),
    reset: resetOperation(state),
    invalidateSession: (sessionID) =>
      Effect.gen(function* () {
        const targets = yield* state.locked((map) =>
          Effect.sync(() => takeSessionCells(map, sessionID))
        )
        yield* invalidateCells(state, targets)
      })
  }
}
