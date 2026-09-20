import type { Plugin } from '@opencode/plugin/effect'
import { Effect, type Scope } from 'effect'
import { invalidateCells } from './runtime/invalidation.ts'
import { createRuntimeOperations, takeAllCells } from './runtime/operations.ts'
import { makeState, type RuntimeState } from './runtime/state.ts'
import type { ReplRuntime } from './runtime/types.ts'

export type { ReplRuntime } from './runtime/types.ts'

function closeRuntime(state: RuntimeState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const targets = yield* state.locked((map) => Effect.sync(() => takeAllCells(map)))
    yield* invalidateCells(state, targets)
    yield* Effect.promise(async () => state.python.close())
  })
}

export const makeRuntime = (
  ctx: Plugin.Context,
  nodeCommand: string,
  pythonCommand: string
): Effect.Effect<ReplRuntime, never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* makeState(ctx, nodeCommand, pythonCommand)
    const runtime = createRuntimeOperations(state)
    yield* Effect.addFinalizer(() => closeRuntime(state))
    return runtime
  })
