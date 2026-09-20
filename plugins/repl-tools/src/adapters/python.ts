import { errorMessage } from './protocol.ts'
import { type PythonConnection, spawnPythonConnection } from './python/connection.ts'
import { PythonEnvironment } from './python/environment.ts'
import { PythonStartupError, type PythonEvent, type PythonInterpreter } from './python/types.ts'

export { PythonStartupError, type PythonEvent, type PythonInterpreter } from './python/types.ts'

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, message: string): Promise<T> {
  if (signal.aborted) {
    throw new Error(message)
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new Error(message))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    void promise
      .then((value) => {
        finish(resolve, signal, onAbort, value)
      })
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error(errorMessage(error))
        finish(reject, signal, onAbort, failure)
      })
  })
}

function finish<T>(
  resolve: (value: T) => void,
  signal: AbortSignal,
  onAbort: () => void,
  value: T
): void {
  signal.removeEventListener('abort', onAbort)
  resolve(value)
}

async function failReady(connection: PythonConnection, error: unknown): Promise<never> {
  const cleanup = await connection.shutdown()
  if (cleanup.confirmed) {
    throw error
  }

  const message = errorMessage(error)
  const tail = error instanceof PythonStartupError ? error.diagnosticTail : undefined
  throw new PythonStartupError(message, tail, async () => connection.shutdown())
}

async function readyConnection(
  connection: PythonConnection,
  signal: AbortSignal
): Promise<PythonInterpreter> {
  try {
    await connection.waitUntilReady(signal)
    return connection
  } catch (error) {
    return failReady(connection, error)
  }
}

export class PythonAdapter {
  private readonly environment: PythonEnvironment

  constructor(configuredPython: string) {
    this.environment = new PythonEnvironment(configuredPython)
  }

  async start(options: {
    readonly cwd: string
    readonly signal: AbortSignal
    readonly onEvent: (event: PythonEvent) => void
  }): Promise<PythonInterpreter> {
    const python = await raceAbort(
      this.environment.ensure(),
      options.signal,
      'Python REPL startup was cancelled'
    )
    if (options.signal.aborted) {
      throw new Error('Python REPL startup was cancelled')
    }

    let connection: PythonConnection
    try {
      connection = spawnPythonConnection({ python, cwd: options.cwd, onEvent: options.onEvent })
    } catch (error) {
      throw new PythonStartupError(errorMessage(error))
    }

    return readyConnection(connection, options.signal)
  }

  async close(): Promise<void> {
    return this.environment.close()
  }
}
