import type { OutputStream } from '../model.ts'
import type { CleanupResult } from './process-group.ts'

export class PythonStartupError extends Error {
  constructor(
    message: string,
    readonly diagnosticTail?: string,
    readonly cleanupConfirmed?: boolean,
    readonly retryCleanup?: () => Promise<CleanupResult>
  ) {
    super(message)
    this.name = 'PythonStartupError'
  }
}

export type PythonEvent =
  | {
      readonly type: 'output'
      readonly stream: OutputStream
      readonly text: string
      readonly jobId?: string
    }
  | {
      readonly type: 'waiting_input'
      readonly jobId: string
      readonly prompt: string
      readonly password: boolean
    }
  | { readonly type: 'fatal'; readonly message: string }

export type PythonEvalResult = {
  readonly ok: boolean
  readonly error?: { readonly kind: string; readonly message: string }
}

export type PythonInterpreter = {
  readonly language: 'python'
  evaluate(jobId: string, code: string): Promise<PythonEvalResult>
  stdin(jobId: string, data: string): Promise<void>
  interrupt(jobId: string): Promise<void>
  shutdown(): Promise<CleanupResult>
  alive(): boolean
}
