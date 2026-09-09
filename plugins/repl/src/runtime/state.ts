import type { Plugin } from '@opencode/plugin/effect'
import { Effect, Exit, Scope, SynchronizedRef } from 'effect'
import { PythonAdapter } from '../adapters/python.ts'
import type { Language } from '../model.ts'
import { OutputRing } from '../output-ring.ts'
import {
  TRANSCRIPT_BYTES,
  cellKey,
  errorMessage,
  isSameCell,
  type Cell,
  type SessionId
} from './types.ts'

type RuntimeStateOptions = {
  readonly ctx: Plugin.Context
  readonly nodeCommand: string
  readonly pythonCommand: string
  readonly activationScope: Scope.Closeable
  readonly cells: SynchronizedRef.SynchronizedRef<Map<string, Cell>>
}

function hasWorkspaceMismatch(expected: string | undefined, actual: string | undefined): boolean {
  if (expected === undefined || actual === undefined) {
    return false
  }

  return expected !== actual
}

function lifecycleForInterpreter(cell: Cell): 'healthy' | 'live' {
  return cell.interpreter === undefined ? 'healthy' : 'live'
}

export class RuntimeState {
  private readonly cells: SynchronizedRef.SynchronizedRef<Map<string, Cell>>
  readonly ctx: Plugin.Context
  readonly nodeCommand: string
  readonly activationScope: Scope.Closeable
  readonly python: PythonAdapter

  constructor(options: RuntimeStateOptions) {
    this.cells = options.cells
    this.ctx = options.ctx
    this.nodeCommand = options.nodeCommand
    this.activationScope = options.activationScope
    this.python = new PythonAdapter(options.pythonCommand)
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

    if (hasWorkspaceMismatch(this.ctx.location.workspaceID, session.location.workspaceID)) {
      return this.locationFailure('session workspace no longer matches this plugin location')
    }

    return { ok: true as const, session }
  }

  private locationFailure(message: string) {
    return { ok: false as const, error: { kind: 'lifecycle' as const, message } }
  }

  private installReplacement(
    map: Map<string, Cell>,
    cell: Cell,
    replacement: Scope.Closeable | undefined
  ): boolean {
    if (!isSameCell(map, cell)) {
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

  validateSession(sessionID: SessionId) {
    if (!this.activationOpen()) {
      return Effect.succeed(this.closedValidation())
    }

    return this.ctx.session.get({ ['sessionID']: sessionID }).pipe(
      Effect.map((session) => this.validateLocation(session)),
      Effect.catch((error) => Effect.succeed(this.lookupFailure(error)))
    )
  }

  createCell(sessionID: SessionId, language: Language, directory: string): Effect.Effect<Cell> {
    return Scope.fork(this.activationScope).pipe(
      Effect.map((scope) => ({
        ['sessionID']: sessionID,
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
    const replacementEffect: Effect.Effect<Scope.Closeable | undefined> = this.activationOpen()
      ? Scope.fork(this.activationScope)
      : Effect.succeed(undefined)

    return replacementEffect.pipe(
      Effect.flatMap((replacement) =>
        this.locked((map) =>
          Effect.sync(() => this.installReplacement(map, cell, replacement))
        ).pipe(
          Effect.flatMap((isUsed) => {
            const closeReplacement =
              replacement !== undefined && !isUsed
                ? Scope.close(replacement, Exit.void)
                : Effect.void
            return closeReplacement.pipe(Effect.andThen(Scope.close(oldScope, Exit.void)))
          })
        )
      )
    )
  }

  getCell(map: Map<string, Cell>, sessionID: SessionId, language: Language): Cell | undefined {
    return map.get(cellKey(sessionID, language))
  }
}

export function makeState(
  ctx: Plugin.Context,
  nodeCommand: string,
  pythonCommand: string
): Effect.Effect<RuntimeState, never, Scope.Scope> {
  return Effect.gen(function* () {
    const parentScope = yield* Scope.Scope
    const activationScope = yield* Scope.fork(parentScope)
    const cells = yield* SynchronizedRef.make(new Map<string, Cell>())
    return new RuntimeState({ ctx, nodeCommand, pythonCommand, activationScope, cells })
  })
}
