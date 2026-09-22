import { Effect } from 'effect'
import type { JobOperationOutput, Language } from '../model.ts'
import type { RuntimeState } from './state.ts'
import {
  cellKey,
  expected,
  isTerminal,
  newJob,
  type Cell,
  type Job,
  type ToolCallContext
} from './types.ts'

function hasActiveJob(cell: Cell): boolean {
  const { active } = cell
  return active !== undefined && !isTerminal(active.state)
}

function lifecycleError(cell: Cell, language: Language): JobOperationOutput | undefined {
  if (cell.lifecycle === 'failed') {
    return expected('lifecycle', cell.cleanupError ?? 'Cell teardown is unconfirmed')
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

type AdmissionResult =
  { readonly error: JobOperationOutput } | { readonly cell: Cell; readonly job: Job }

export function admitEvaluation(
  state: RuntimeState,
  language: Language,
  context: ToolCallContext,
  directory: string
): Effect.Effect<AdmissionResult> {
  return state.locked((map) =>
    Effect.gen(function* () {
      if (!state.activationOpen()) {
        return { error: expected('lifecycle', 'plugin activation is closed') }
      }

      const key = cellKey(context.sessionID, language)
      const existing = map.get(key)
      const denied = admissionError(existing, language)
      if (denied !== undefined) {
        return { error: denied }
      }

      const cell = existing ?? (yield* state.createCell(context.sessionID, language, directory))
      map.set(key, cell)
      return { cell, job: prepareJob(cell, language) }
    })
  )
}
