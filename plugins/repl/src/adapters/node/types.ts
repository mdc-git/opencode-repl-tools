import type { OutputStream } from '../../model.ts'
import type { CleanupResult } from '../process-group.ts'

export class NodeStartupError extends Error {
  constructor(
    message: string,
    readonly retryCleanup?: () => Promise<CleanupResult>
  ) {
    super(message)
    this.name = 'NodeStartupError'
  }
}

type NodeImage = {
  readonly mime: string
  readonly data: string
  readonly name?: string
}

export type NodeEvent =
  | {
      readonly type: 'output'
      readonly stream: OutputStream
      readonly text: string
      readonly jobId?: string
    }
  | ({ readonly type: 'image'; readonly jobId: string } & NodeImage)
  | { readonly type: 'fatal'; readonly message: string }

export type NodeEvalResult = {
  readonly ok: boolean
  readonly error?: { readonly kind: string; readonly message: string }
}

export type NodeInterpreter = {
  readonly language: 'node'
  evaluate(jobId: string, code: string): Promise<NodeEvalResult>
  stdin(jobId: string, data: string): Promise<void>
  interrupt(jobId: string): Promise<void>
  shutdown(): Promise<CleanupResult>
  alive(): boolean
}
