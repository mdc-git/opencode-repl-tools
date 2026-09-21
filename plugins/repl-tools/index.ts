import process from 'node:process'
import { Plugin } from '@opencode/plugin/effect'
import { Effect, Stream } from 'effect'
import {
  evalInputSchema,
  jobInputSchema,
  jobOperationOutputSchema,
  resetInputSchema,
  resetOutputSchema
} from './src/model.ts'
import { makeRuntime, type ReplRuntime } from './src/runtime.ts'
import type { ReplOperationResult, SessionId } from './src/runtime/types.ts'

const invalidatingEvents = new Set(['session.moved', 'session.deleted', 'session.revert.staged'])

function toolResult(result: ReplOperationResult) {
  const content = result.images.map((image) => ({
    type: 'file' as const,
    uri: `data:${image.mime};base64,${image.data}`,
    mime: image.mime,
    ...(image.name !== undefined && { name: image.name })
  }))
  return {
    output: result.output,
    ...(content.length > 0 && { content })
  }
}

function addTools(
  editor: Parameters<Parameters<Plugin.Context['tool']['transform']>[0]>[0],
  runtime: ReplRuntime
): void {
  editor.add({
    name: 'repl_node',
    description:
      'Default tool for executing JavaScript or TypeScript code in Node.js, including one-off snippets, calculations, parsing, data work, experiments, and iterative scripting. Prefer this over shell commands that launch Node.js or use JavaScript/TypeScript heredocs. Declarations and runtime state persist across calls. Use shell only when shell semantics, a separate process, a specific CLI invocation, or execution of an existing script file is required. Emit in-memory images with opencode.emitImage({ bytes, mimeType, filename? }).',
    input: evalInputSchema,
    output: jobOperationOutputSchema,
    options: { codemode: false },
    execute: ({ code }, context) =>
      runtime.evaluate('node', code, context).pipe(Effect.map(toolResult))
  })
  editor.add({
    name: 'repl_python',
    description:
      'Default tool for executing Python code, including one-off snippets, calculations, parsing, data work, experiments, and iterative scripting. Prefer this over shell commands that launch python/python3 or use Python heredocs. Imports, variables, and runtime state persist across calls. Use shell only when shell semantics, a separate process, a specific CLI invocation, or execution of an existing script file is required.',
    input: evalInputSchema,
    output: jobOperationOutputSchema,
    options: { codemode: false },
    execute: ({ code }, context) =>
      runtime.evaluate('python', code, context).pipe(Effect.map(toolResult))
  })
  editor.add({
    name: 'repl_job',
    description:
      'Continue a persistent REPL job: read incremental output/status, cancel it, or provide stdin when Python is waiting for input.',
    input: jobInputSchema,
    output: jobOperationOutputSchema,
    options: { codemode: false },
    execute: (input, context) => runtime.job(input, context).pipe(Effect.map(toolResult))
  })
  editor.add({
    name: 'repl_reset',
    description:
      'Reset a persistent REPL Cell only when you need a clean interpreter; normal scripting and prototyping should reuse the existing Cell.',
    input: resetInputSchema,
    output: resetOutputSchema,
    options: { codemode: false },
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

  return runtime.invalidateSession(event.sessionID as SessionId)
}

const replPlugin = Plugin.define({
  id: 'mdc-git.repl-tools',
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
