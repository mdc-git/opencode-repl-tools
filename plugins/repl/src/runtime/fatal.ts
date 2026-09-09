import { Effect } from 'effect'
import { safeShutdown } from './cleanup.ts'
import { notifyTerminal } from './notifications.ts'
import type { RuntimeState } from './state.ts'
import {
  finishJob,
  isSameCell,
  isTerminal,
  type Cell,
  type Interpreter,
  type Job
} from './types.ts'

type FatalPreparation = {
  readonly interpreter: Interpreter
  readonly scope: Cell['scope']
}

function isFatalBlocked(cell: Cell): boolean {
  return cell.lifecycle === 'retiring' || cell.lifecycle === 'failed'
}

function prepareFatal(
  cell: Cell,
  message: string,
  map: Map<string, Cell>
): FatalPreparation | undefined {
  if (!isSameCell(map, cell)) {
    return undefined
  }

  if (isFatalBlocked(cell)) {
    return undefined
  }

  const { interpreter } = cell
  if (interpreter === undefined) {
    return undefined
  }

  cell.lifecycle = 'retiring'
  cell.transcript.append('system', `[interpreter fatal] ${message}\n`)
  return { interpreter, scope: cell.scope }
}

function failFatalCleanup(cell: Cell, interpreter: Interpreter, message: string): Job | undefined {
  cell.lifecycle = 'failed'
  cell.cleanupError = message
  cell.cleanupRetry = async () => interpreter.shutdown()
  cell.transcript.append('system', `[cleanup unconfirmed] ${message}\n`)
  const { active } = cell
  if (active === undefined || isTerminal(active.state)) {
    return undefined
  }

  finishJob(cell, active, 'failed', { kind: 'lifecycle', message })
  return active
}

function finishFatalJob(active: Job | undefined, cell: Cell, message: string): Job | undefined {
  if (active === undefined || isTerminal(active.state)) {
    return undefined
  }

  if (active.cancelRequested) {
    finishJob(cell, active, 'cancelled')
  } else {
    finishJob(cell, active, 'failed', { kind: 'runtime', message })
  }

  return active
}

function finishFatal(cell: Cell, interpreter: Interpreter, message: string): Job | undefined {
  if (cell.interpreter === interpreter) {
    cell.interpreter = undefined
  }

  const finished = finishFatalJob(cell.active, cell, message)
  cell.cleanupError = undefined
  cell.cleanupRetry = undefined
  return finished
}

function fatalCleanupMessage(message: string | undefined): string {
  return message ?? 'interpreter teardown could not be confirmed'
}

function finalizeFatal(
  state: RuntimeState,
  cell: Cell,
  message: string,
  prepared: FatalPreparation
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const cleanup = yield* Effect.promise(async () => safeShutdown(prepared.interpreter))
    let finished: Job | undefined
    if (cleanup.confirmed) {
      finished = yield* state.locked(() =>
        Effect.sync(() => finishFatal(cell, prepared.interpreter, message))
      )
      yield* state.replaceCellScope(cell, prepared.scope)
    } else {
      const detail = fatalCleanupMessage(cleanup.message)
      finished = yield* state.locked(() =>
        Effect.sync(() => failFatalCleanup(cell, prepared.interpreter, detail))
      )
    }

    if (finished !== undefined) {
      yield* notifyTerminal(state, cell, finished)
    }
  })
}

export function handleFatal(state: RuntimeState, cell: Cell, message: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    const prepared = yield* state.locked((map) =>
      Effect.sync(() => prepareFatal(cell, message, map))
    )
    if (prepared !== undefined) {
      yield* finalizeFatal(state, cell, message, prepared)
    }
  })
}
