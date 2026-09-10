import { Effect, Scope } from 'effect'
import { startNodeInterpreter, type NodeEvent } from '../adapters/node.ts'
import { PythonStartupError, type PythonEvent } from '../adapters/python.ts'
import { safeShutdown } from './cleanup.ts'
import { handleFatal } from './fatal.ts'
import { notifyInput, notifyTerminal } from './notifications.ts'
import type { RuntimeState } from './state.ts'
import {
  errorMessage,
  finishJob,
  isSameCell,
  isTerminal,
  startupCleanup,
  type Cell,
  type Interpreter,
  type Job
} from './types.ts'

type StartedInterpreter = {
  readonly ok: true
  readonly value: Interpreter
}

type StartupFailure = {
  readonly ok: false
  readonly error: unknown
}

type StartupResult = StartedInterpreter | StartupFailure

function onNodeEvent(state: RuntimeState, cell: Cell, event: NodeEvent): void {
  if (event.type === 'output') {
    cell.transcript.append(event.stream, event.text, event.jobId)
    return
  }

  if (event.type === 'image') {
    const job = cell.active
    if (job?.id === event.jobId) {
      job.images.push({
        mime: event.mime,
        data: event.data,
        ...(event.name !== undefined && { name: event.name })
      })
      return
    }

    state.dispatch(
      handleFatal(state, cell, `Node REPL emitted image for unexpected job ${event.jobId}`)
    )
    return
  }

  state.dispatch(handleFatal(state, cell, event.message))
}

function updateWaitingInput(
  cell: Cell,
  event: Extract<PythonEvent, { type: 'waiting_input' }>
): Job | undefined {
  const job = cell.active
  if (job?.id !== event.jobId) {
    return undefined
  }

  if (isTerminal(job.state)) {
    return undefined
  }

  job.state = 'waiting_input'
  job.prompt = event.prompt
  job.password = event.password
  job.inputSerial += 1
  job.foreground.resolve()
  return job
}

function handleInputEvent(
  state: RuntimeState,
  cell: Cell,
  event: Extract<PythonEvent, { type: 'waiting_input' }>
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const waiting = yield* state.locked((map) =>
      Effect.sync(() => (isSameCell(map, cell) ? updateWaitingInput(cell, event) : undefined))
    )
    if (waiting !== undefined) {
      yield* notifyInput(state, cell, waiting, waiting.inputSerial)
    }
  })
}

function onPythonEvent(state: RuntimeState, cell: Cell, event: PythonEvent): void {
  if (event.type === 'output') {
    cell.transcript.append(event.stream, event.text, event.jobId)
    return
  }

  const effect =
    event.type === 'fatal'
      ? handleFatal(state, cell, event.message)
      : handleInputEvent(state, cell, event)
  state.dispatch(effect)
}

async function startInterpreter(
  state: RuntimeState,
  cell: Cell,
  job: Job,
  signal: AbortSignal
): Promise<StartupResult> {
  try {
    const value =
      job.language === 'node'
        ? await startNodeInterpreter({
            command: state.nodeCommand,
            cwd: cell.directory,
            signal,
            onEvent(event) {
              onNodeEvent(state, cell, event)
            }
          })
        : await state.python.start({
            cwd: cell.directory,
            signal,
            onEvent(event) {
              onPythonEvent(state, cell, event)
            }
          })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error }
  }
}

function recordStartupFailure(cell: Cell, job: Job, failure: StartupFailure): void {
  const cleanup = startupCleanup(failure.error)
  if (cleanup.unconfirmed) {
    cell.lifecycle = 'failed'
    cell.cleanupError = `startup teardown could not be confirmed: ${errorMessage(failure.error)}`
    cell.cleanupRetry = cleanup.retry
    finishJob(cell, job, 'failed', { kind: 'lifecycle', message: cell.cleanupError })
    return
  }

  if (job.cancelRequested) {
    finishJob(cell, job, 'cancelled')
    return
  }

  cell.lifecycle = 'healthy'
  finishJob(cell, job, 'failed', { kind: 'startup', message: errorMessage(failure.error) })
}

function isInterpreterBlocked(cell: Cell): boolean {
  return cell.lifecycle === 'retiring' || cell.lifecycle === 'failed'
}

function canAcceptInterpreter(
  map: Map<string, Cell>,
  cell: Cell,
  job: Job,
  interpreter: Interpreter
): boolean {
  if (!isSameCell(map, cell)) {
    return false
  }

  if (cell.active !== job) {
    return false
  }

  if (isInterpreterBlocked(cell)) {
    return false
  }

  cell.interpreter = interpreter
  cell.lifecycle = 'live'
  job.state = 'running'
  return true
}

function markExistingRunning(cell: Cell, job: Job): void {
  if (cell.active !== job || isTerminal(job.state)) {
    return
  }

  cell.lifecycle = 'live'
  job.state = 'running'
}

function startupDiagnostic(cell: Cell, job: Job, error: unknown): void {
  if (!(error instanceof PythonStartupError)) {
    return
  }

  if (error.diagnosticTail === undefined) {
    return
  }

  cell.transcript.append('system', error.diagnosticTail, job.id)
}

function installInterpreter(
  state: RuntimeState,
  cell: Cell,
  job: Job
): Effect.Effect<Interpreter | undefined> {
  return Effect.gen(function* () {
    const startupAbort = new AbortController()
    job.startupAbort = startupAbort
    yield* Scope.addFinalizer(
      cell.scope,
      Effect.sync(() => {
        startupAbort.abort()
      })
    )
    const started = yield* Effect.promise(async () =>
      startInterpreter(state, cell, job, startupAbort.signal)
    )
    job.startupAbort = undefined
    if (!started.ok) {
      startupDiagnostic(cell, job, started.error)
      yield* state.locked(() =>
        Effect.sync(() => {
          recordStartupFailure(cell, job, started)
        })
      )
      yield* notifyTerminal(state, cell, job)
      return undefined
    }

    const isAccepted = yield* state.locked((map) =>
      Effect.sync(() => canAcceptInterpreter(map, cell, job, started.value))
    )
    if (!isAccepted) {
      yield* Effect.promise(async () => safeShutdown(started.value).then(() => undefined))
      return undefined
    }

    yield* Scope.addFinalizer(
      cell.scope,
      Effect.promise(async () => safeShutdown(started.value).then(() => undefined))
    )
    return started.value
  })
}

function interpreterForJob(
  state: RuntimeState,
  cell: Cell,
  job: Job
): Effect.Effect<Interpreter | undefined> {
  if (cell.interpreter !== undefined) {
    return state
      .locked(() =>
        Effect.sync(() => {
          markExistingRunning(cell, job)
        })
      )
      .pipe(Effect.as(cell.interpreter))
  }

  return installInterpreter(state, cell, job)
}

async function evaluateInterpreter(interpreter: Interpreter, job: Job, code: string) {
  try {
    return { ok: true as const, result: await interpreter.evaluate(job.id, code) }
  } catch (error) {
    return { ok: false as const, error }
  }
}

function interpreterFailureMessage(error: { readonly message: string } | undefined): string {
  if (error !== undefined) {
    return error.message
  }

  return 'interpreter evaluation failed'
}

function evaluationOutcome(result: Awaited<ReturnType<typeof evaluateInterpreter>>) {
  if (!result.ok) {
    return {
      state: 'failed' as const,
      error: { kind: 'runtime' as const, message: errorMessage(result.error) }
    }
  }

  if (result.result.ok) {
    return { state: 'succeeded' as const, error: undefined }
  }

  const message = interpreterFailureMessage(result.result.error)
  return { state: 'failed' as const, error: { kind: 'runtime' as const, message } }
}

function completeEvaluation(
  cell: Cell,
  job: Job,
  result: Awaited<ReturnType<typeof evaluateInterpreter>>
): void {
  if (cell.active !== job) {
    return
  }

  if (isTerminal(job.state)) {
    return
  }

  if (job.cancelRequested) {
    finishJob(cell, job, 'cancelled')
    return
  }

  const outcome = evaluationOutcome(result)
  finishJob(cell, job, outcome.state, outcome.error)
}

export function runJob(
  state: RuntimeState,
  cell: Cell,
  job: Job,
  code: string
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const interpreter = yield* interpreterForJob(state, cell, job)
    if (interpreter === undefined) {
      return
    }

    const result = yield* Effect.promise(async () => evaluateInterpreter(interpreter, job, code))
    yield* state.locked(() =>
      Effect.sync(() => {
        completeEvaluation(cell, job, result)
      })
    )
    yield* notifyTerminal(state, cell, job)
    if (!interpreter.alive()) {
      yield* handleFatal(state, cell, 'interpreter exited during evaluation')
    }
  })
}
