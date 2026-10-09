import process from 'node:process'
import type { ChildProcess } from 'node:child_process'

export type CleanupResult = {
  readonly confirmed: boolean
  readonly message?: string
}

export type RetireOptions = {
  readonly orderlyWaitMs: number
  readonly termWaitMs: number
  readonly killWaitMs: number
  readonly label: string
  readonly orderly?: () => void
}

function errorCode(error: unknown): unknown {
  return typeof error !== 'object' || error === null || !('code' in error) ? undefined : error.code
}

function isGroupPresent(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

async function isGroupGoneAfterWait(pid: number, durationMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + durationMs
    const timer = setInterval(() => {
      if (!isGroupPresent(pid)) {
        clearInterval(timer)
        resolve(true)
        return
      }

      if (!(Date.now() >= deadline)) {
        return
      }

      clearInterval(timer)
      resolve(false)
    }, 25)
  })
}

export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') {
      throw error
    }
  }
}

function runOrderly(orderly: (() => void) | undefined): void {
  try {
    orderly?.()
  } catch {
    // Process-group escalation remains authoritative.
  }
}

async function forceRetire(pid: number, options: RetireOptions): Promise<CleanupResult> {
  signalProcessGroup(pid, 'SIGTERM')
  if (await isGroupGoneAfterWait(pid, options.termWaitMs)) {
    return { confirmed: true }
  }

  signalProcessGroup(pid, 'SIGKILL')
  if (await isGroupGoneAfterWait(pid, options.killWaitMs)) {
    return { confirmed: true }
  }

  return {
    confirmed: false,
    message: `${options.label} process group ${pid} is still observable after SIGKILL`
  }
}

export async function retireProcessGroupId(
  pid: number,
  options: RetireOptions
): Promise<CleanupResult> {
  if (!isGroupPresent(pid)) {
    return { confirmed: true }
  }

  runOrderly(options.orderly)
  return (await isGroupGoneAfterWait(pid, options.orderlyWaitMs))
    ? { confirmed: true }
    : forceRetire(pid, options)
}

export async function retireProcessGroup(
  child: ChildProcess,
  options: RetireOptions
): Promise<CleanupResult> {
  const { pid } = child
  return pid === undefined ? { confirmed: true } : retireProcessGroupId(pid, options)
}

export async function killProcessGroup(child: ChildProcess, waitMs: number): Promise<void> {
  const { pid } = child
  if (pid === undefined) {
    return
  }

  signalProcessGroup(pid, 'SIGKILL')
  await isGroupGoneAfterWait(pid, waitMs)
}
