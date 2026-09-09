import type { Plugin } from '@opencode/plugin/effect'
import { Effect, Exit, Scope, SynchronizedRef } from 'effect'
import type { Language } from '../model.ts'
import { PythonAdapter } from '../adapters/python.ts'
import { OutputRing } from '../output-ring.ts'
import {
  TRANSCRIPT_BYTES,
  cellKey,
  errorMessage,
  sameCell,
  type Cell,
  type SessionID
} from './types.ts'

type RuntimeStateOptions = {
  readonly ctx: Plugin.Context
  readonly nodeCommand: string
  readonly pythonCommand: string
  readonly activationScope: Scope.Closeable
  readonly cells: SynchronizedRef.SynchronizedRef<Map<string, Cell>>
}

function workspaceMismatch(expected: string | undefined, actual: string | undefined): boolean {
  if (expected === undefined || actual === undefined) {
    return false
  }
  return expected !== actual
}

function lifecycleForInterpreter(cell: Cell): 'healthy' | 'live' {
  return cell.interpreter === undefined ? 'healthy' : 'live'
}

export class RuntimeState {
  readonly ctx: Plugin.Context
  readonly nodeCommand: string
  readonly activationScope: Scope.Closeable
  readonly python: PythonAdapter
  private readonly cells: SynchronizedRef.SynchronizedRef<Map<string, Cell>>

  constructor(options: RuntimeStateOptions) {
    this.ctx = options.ctx
    this.nodeCommand = options.nodeCommand
    this.activationScope = options.activationScope
    this.cells = options.cells
    this.python = new PythonAdapter(options.pythonCommand)
  }

  locked<A>(operation: (map: Map<string, Cell>) => Effect.Effect<A>): Effect.Effect<A> {
    return SynchronizedRef.modifyEffect(this.cells, (map) =>
      operation(map).pipe(Effect.map((result) => [result, map] as const))
    )
  }

  activationOpen(): boolean {
    return this.activationScope.state._tag !== 'Closed'
  }

  dispatch(effect: Effect.Effect<void>): void {
    if (!this.activationOpen()) {
      return
    }
    Effect.runFork(effect.pipe(Effect.forkIn(this.activationScope), Effect.asVoid))
  }

  validateSession(sessionID: SessionID) {
    if (!this.activationOpen()) {
      return Effect.succeed(this.closedValidation())
    }
    return this.ctx.session.get({ sessionID }).pipe(
      Effect.map((session) => this.validateLocation(session)),
      Effect.catch((error) => Effect.succeed(this.lookupFailure(error)))
    )
  }

  private closedValidation() {
    return {
      ok: false as const,
      error: { kind: 'lifecycle' as const, message: 'plugin activation is closed' }
    }
  }

  private lookupFailure(error: unknown) {
    return {
      ok: false as const,
      error: {
        kind: 'lifecycle' as const,
        message: `OpenCode session lookup failed: ${errorMessage(error)}`
      }
    }
  }

  private validateLocation(session: {
    readonly location: { readonly directory: string; readonly workspaceID?: string }
  }) {
    if (session.location.directory !== this.ctx.location.directory) {
      return this.locationFailure('session moved away from this plugin location')
    }
    if (workspaceMismatch(this.ctx.location.workspaceID, session.location.workspaceID)) {
      return this.locationFailure('session workspace no longer matches this plugin location')
    }
    return { ok: true as const, session }
  }

  private locationFailure(message: string) {
    return { ok: false as const, error: { kind: 'lifecycle' as const, message } }
  }

  createCell(sessionID: SessionID, language: Language, directory: string): Effect.Effect<Cell> {
    return Scope.fork(this.activationScope).pipe(
      Effect.map((scope) => ({
        sessionID,
        language,
        directory,
        transcript: new OutputRing(TRANSCRIPT_BYTES),
        history: [],
        scope,
        lifecycle: 'healthy' as const,
        notificationsSuppressed: false
      }))
    )
  }

  replaceCellScope(cell: Cell, oldScope: Scope.Closeable): Effect.Effect<void> {
    const state = this
    return Effect.gen(function* () {
      const replacement = state.activationOpen()
        ? yield* Scope.fork(state.activationScope)
        : undefined
      const used = yield* state.locked((map) =>
        Effect.sync(() => state.installReplacement(map, cell, replacement))
      )
      if (replacement !== undefined && !used) {
        yield* Scope.close(replacement, Exit.void)
      }
      yield* Scope.close(oldScope, Exit.void)
    })
  }

  private installReplacement(
    map: Map<string, Cell>,
    cell: Cell,
    replacement: Scope.Closeable | undefined
  ): boolean {
    if (!sameCell(map, cell)) {
      return false
    }
    if (cell.lifecycle === 'failed') {
      return false
    }
    if (replacement !== undefined) {
      cell.scope = replacement
    }
    cell.lifecycle = lifecycleForInterpreter(cell)
    return replacement !== undefined
  }

  getCell(map: Map<string, Cell>, sessionID: SessionID, language: Language): Cell | undefined {
    return map.get(cellKey(sessionID, language))
  }
}

export function makeState(
  ctx: Plugin.Context,
  nodeCommand: string,
  pythonCommand: string
): Effect.Effect<RuntimeState, never, Scope.Scope> {
  return Effect.gen(function* () {
    const activationScope = yield* Scope.Scope
    const cells = yield* SynchronizedRef.make(new Map<string, Cell>())
    return new RuntimeState({ ctx, nodeCommand, pythonCommand, activationScope, cells })
  })
}
