import process from 'node:process'
import { Plugin } from '@opencode/plugin/effect'
import { Effect, Stream } from 'effect'
import { EvalInput, JobInput, JobOperationOutput, ResetInput, ResetOutput } from './src/model.ts'
import { makeRuntime, type ReplRuntime } from './src/runtime.ts'

const invalidatingEvents = new Set(['session.moved', 'session.deleted', 'session.revert.staged'])

function addTools(
  editor: Parameters<Parameters<Plugin.Context['tool']['transform']>[0]>[0],
  runtime: ReplRuntime
): void {
  editor.add({
    name: 'repl_node',
    description:
      'Use the persistent Node.js/TypeScript Cell for iterative scripting, prototyping, data work, and experiments; declarations and runtime state persist across calls.',
    input: EvalInput,
    output: JobOperationOutput,
    execute: ({ code }, context) =>
      runtime.evaluate('node', code, context).pipe(Effect.map((output) => ({ output })))
  })
  editor.add({
    name: 'repl_python',
    description:
      'Use the persistent Python Cell for iterative scripting, prototyping, data work, and experiments; imports, variables, and runtime state persist across calls.',
    input: EvalInput,
    output: JobOperationOutput,
    execute: ({ code }, context) =>
      runtime.evaluate('python', code, context).pipe(Effect.map((output) => ({ output })))
  })
  editor.add({
    name: 'repl_job',
    description:
      'Continue a persistent REPL job: read incremental output/status, cancel it, or provide stdin when Python is waiting for input.',
    input: JobInput,
    output: JobOperationOutput,
    execute: (input, context) =>
      runtime.job(input, context).pipe(Effect.map((output) => ({ output })))
  })
  editor.add({
    name: 'repl_reset',
    description:
      'Reset a persistent REPL Cell only when you need a clean interpreter; normal scripting and prototyping should reuse the existing Cell.',
    input: ResetInput,
    output: ResetOutput,
    execute: ({ language }, context) =>
      runtime.reset(language, context).pipe(Effect.map((output) => ({ output })))
  })
}

function invalidationEffect(
  runtime: ReplRuntime,
  event: { readonly type: string; readonly sessionID?: string }
) {
  if (!invalidatingEvents.has(event.type)) {
    return Effect.void
  }

  if (event.sessionID === undefined) {
    return Effect.void
  }

  return runtime.invalidateSession(event.sessionID)
}

const replPlugin = Plugin.define({
  id: 'github.opencode_repl_tools',
  effect: (ctx) =>
    Effect.gen(function* () {
      if (process.platform !== 'linux') {
        return yield* Effect.die(new Error('opencode-repl-tools supports Linux only'))
      }

      const nodeCommand = process.env.OPENCODE_REPL_NODE ?? 'node'
      const pythonCommand = process.env.OPENCODE_REPL_PYTHON ?? 'python3'
      const runtime = yield* makeRuntime(ctx, nodeCommand, pythonCommand)
      yield* ctx.tool.transform((editor) => {
        addTools(editor, runtime)
      })
      yield* ctx.event.subscribe().pipe(
        Stream.runForEach((event) => invalidationEffect(runtime, event)),
        Effect.forkScoped
      )
    })
})

export default replPlugin
