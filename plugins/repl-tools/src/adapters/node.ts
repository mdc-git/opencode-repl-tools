import { spawn, type ChildProcess } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createNodeConnection } from './node/connection.ts'
import { NodeStartupError, type NodeEvent, type NodeInterpreter } from './node/types.ts'
import { retireProcessGroup, type CleanupResult } from './process-group.ts'
import { errorMessage } from './protocol.ts'

export {
  NodeStartupError,
  type NodeEvent,
  type NodeImage,
  type NodeInterpreter
} from './node/types.ts'

const workerPath = fileURLToPath(new URL('../../workers/node-repl.mjs', import.meta.url))
const RETIRE_OPTIONS = {
  orderlyWaitMs: 350,
  termWaitMs: 500,
  killWaitMs: 750,
  label: 'Node REPL'
} as const

async function retirement(child: ChildProcess): Promise<CleanupResult> {
  return retireProcessGroup(child, RETIRE_OPTIONS)
}

async function createConnection(child: ChildProcess, onEvent: (event: NodeEvent) => void) {
  try {
    return createNodeConnection(child, onEvent)
  } catch (error) {
    const cleanup = await retirement(child)
    if (cleanup.confirmed) {
      throw error
    }

    const message = errorMessage(error)
    throw new NodeStartupError(message, async () => retirement(child))
  }
}

export async function startNodeInterpreter(options: {
  readonly command: string
  readonly cwd: string
  readonly signal: AbortSignal
  readonly onEvent: (event: NodeEvent) => void
}): Promise<NodeInterpreter> {
  const child = spawn(options.command, [workerPath, '--cwd', options.cwd], {
    cwd: options.cwd,
    env: process.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']
  })
  const connection = await createConnection(child, options.onEvent)
  try {
    await connection.waitUntilReady(options.signal)
    return connection
  } catch (error) {
    const cleanup = await connection.shutdown()
    if (cleanup.confirmed) {
      throw error
    }

    const message = errorMessage(error)
    throw new NodeStartupError(message, async () => connection.shutdown())
  }
}
