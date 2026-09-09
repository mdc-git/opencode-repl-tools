import { Effect, Exit, Scope } from 'effect'
import type { CleanupResult } from '../adapters/process-group.ts'
import { safeRetry, safeShutdown } from './cleanup.ts'
import type { RuntimeState } from './state.ts'
import { isTerminal, type Cell } from './types.ts'

function abortStartup(cell: Cell): void {
  if (cell.active?.startupAbort !== undefined) {
    cell.active.startupAbort.abort()
  }
}

function suppressCell(cell: Cell): void {
  cell.notificationsSuppressed = true
  const { active } = cell
  if (active === undefined || isTerminal(active.state)) {
    return
  }

  active.cancelRequested = true
  active.notificationSuppressed = true
  abortStartup(cell)
}

function cleanupInvalidated(cell: Cell): Effect.Effect<CleanupResult | undefined> {
  const { interpreter } = cell
  if (interpreter !== undefined) {
    return Effect.promise(async () => safeShutdown(interpreter))
  }

  const { cleanupRetry } = cell
  if (cleanupRetry !== undefined) {
    return Effect.promise(async () => safeRetry(cleanupRetry))
  }

  return Effect.succeed(undefined)
}

function warnCleanup(state: RuntimeState, cell: Cell, result: CleanupResult | undefined) {
  if (result === undefined || result.confirmed) {
    return Effect.void
  }

  return Effect.logWarning('REPL lifecycle cleanup could not be confirmed', {
    ['sessionID']: cell.sessionID,
    language: cell.language,
    error: result.message
  })
}

function invalidateCell(state: RuntimeState, cell: Cell): Effect.Effect<void> {
  return Effect.gen(function* () {
    suppressCell(cell)
    const result = yield* cleanupInvalidated(cell)
    yield* warnCleanup(state, cell, result)
    yield* Scope.close(cell.scope, Exit.void)
  })
}

export function invalidateCells(
  state: RuntimeState,
  targets: readonly Cell[]
): Effect.Effect<void> {
  return Effect.forEach(targets, (cell) => invalidateCell(state, cell), { discard: true })
}
