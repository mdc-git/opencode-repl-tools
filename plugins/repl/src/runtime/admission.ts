import { Effect, Scope } from 'effect'
import type { JobOperationOutput, Language } from '../model.ts'
import type { RuntimeState } from './state.ts'
import {
  cellKey,
  expected,
  newJob,
  terminal,
  type Cell,
  type Job,
  type ToolCallContext
} from './types.ts'

function cleanupError(cell: Cell): string {
  return cell.cleanupError ?? 'Cell teardown is unconfirmed'
}

function hasActiveJob(cell: Cell): boolean {
  const active = cell.active
  return active !== undefined && !terminal(active.state)
}

function lifecycleError(cell: Cell, language: Language): JobOperationOutput | undefined {
  if (cell.lifecycle === 'failed') {
    return expected('lifecycle', cleanupError(cell))
  }
  if (cell.lifecycle === 'retiring') {
    return expected('lifecycle', `${language} Cell is retiring its interpreter`)
  }
  return undefined
}

function admissionError(
  cell: Cell | undefined,
  language: Language
): JobOperationOutput | undefined {
  if (cell === undefined) {
    return undefined
  }
  const denied = lifecycleError(cell, language)
  if (denied !== undefined) {
    return denied
  }
  if (hasActiveJob(cell)) {
    return expected('busy', `${language} Cell already has an active job`)
  }
  return undefined
}

function prepareJob(cell: Cell, language: Language): Job {
  const job = newJob(cell, language)
  cell.active = job
  cell.lifecycle = cell.interpreter === undefined ? 'starting' : 'live'
  return job
}

type CellRequest = {
  readonly sessionID: ToolCallContext['sessionID']
  readonly language: Language
  readonly directory: string
}

function getOrCreateCell(
  state: RuntimeState,
  map: Map<string, Cell>,
  request: CellRequest
): Effect.Effect<Cell> {
  const key = cellKey(request.sessionID, request.language)
  const existing = map.get(key)
  if (existing !== undefined) {
    return Effect.succeed(existing)
  }
  return state
    .createCell(request.sessionID, request.language, request.directory)
    .pipe(Effect.tap((cell) => Effect.sync(() => map.set(key, cell))))
}

function ensureCellScope(state: RuntimeState, cell: Cell): Effect.Effect<void> {
  if (cell.scope.state._tag !== 'Closed') {
    return Effect.void
  }
  return Scope.fork(state.activationScope).pipe(
    Effect.tap((scope) =>
      Effect.sync(() => {
        cell.scope = scope
      })
    ),
    Effect.asVoid
  )
}

export function admitEvaluation(
  state: RuntimeState,
  language: Language,
  context: ToolCallContext,
  directory: string
) {
  return state.locked((map) =>
    Effect.gen(function* () {
      if (!state.activationOpen()) {
        return { error: expected('lifecycle', 'plugin activation is closed') } as const
      }
      const existing = map.get(cellKey(context.sessionID, language))
      const denied = admissionError(existing, language)
      if (denied !== undefined) {
        return { error: denied } as const
      }
      const cell = yield* getOrCreateCell(state, map, {
        sessionID: context.sessionID,
        language,
        directory
      })
      yield* ensureCellScope(state, cell)
      return { cell, job: prepareJob(cell, language) } as const
    })
  )
}
