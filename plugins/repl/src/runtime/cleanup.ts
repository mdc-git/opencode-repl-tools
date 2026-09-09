import type { CleanupResult } from '../adapters/process-group.ts'
import { errorMessage, type CleanupRetry, type Interpreter } from './types.ts'

export async function safeShutdown(interpreter: Interpreter): Promise<CleanupResult> {
  try {
    return await interpreter.shutdown()
  } catch (error) {
    return { confirmed: false, message: errorMessage(error) }
  }
}

export async function safeRetry(retry: CleanupRetry): Promise<CleanupResult> {
  try {
    return await retry()
  } catch (error) {
    return { confirmed: false, message: errorMessage(error) }
  }
}
