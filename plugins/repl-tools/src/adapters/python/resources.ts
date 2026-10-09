import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import {
  retireProcessGroup,
  retireProcessGroupId,
  type CleanupResult,
  type RetireOptions
} from '../process-group.ts'
import { errorMessage } from '../protocol.ts'

const resourceRoot = '/tmp/opencode'
const RETIRE_OPTIONS = {
  orderlyWaitMs: 4500,
  termWaitMs: 750,
  killWaitMs: 750,
  label: 'Python broker/kernel'
} as const
const STARTUP_RETIRE_OPTIONS = {
  orderlyWaitMs: 0,
  termWaitMs: 4500,
  killWaitMs: 750,
  label: 'Python broker/kernel startup'
} as const
const KERNEL_RETIRE_OPTIONS = {
  orderlyWaitMs: 0,
  termWaitMs: 750,
  killWaitMs: 750,
  label: 'Python kernel'
} as const

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function parseGroupId(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === '') {
    return undefined
  }

  const pgid = Number(trimmed)
  return Number.isSafeInteger(pgid) && pgid > 0 ? pgid : undefined
}

function kernelGroupId(resourceDir: string): number | undefined {
  try {
    return parseGroupId(readFileSync(path.join(resourceDir, 'kernel.pgid'), 'utf8'))
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined
    }

    throw error
  }
}

async function retireRecordedKernel(resourceDir: string): Promise<CleanupResult> {
  const groupId = kernelGroupId(resourceDir)
  if (groupId === undefined) {
    return {
      confirmed: false,
      message: 'Python kernel process group was not recorded'
    }
  }

  return retireProcessGroupId(groupId, KERNEL_RETIRE_OPTIONS)
}

function cleanupUnspawnedBroker(
  child: ChildProcessWithoutNullStreams,
  broker: CleanupResult,
  resourceDir: string
): CleanupResult | undefined {
  if (child.pid !== undefined) {
    return undefined
  }

  return broker.confirmed ? removeResourceDir(resourceDir) : broker;
}

function removeResourceDir(resourceDir: string): CleanupResult {
  try {
    rmSync(resourceDir, { force: true, recursive: true })
  } catch (error) {
    return {
      confirmed: false,
      message: `Python broker resources could not be removed: ${errorMessage(error)}`
    }
  }

  return { confirmed: true }
}

export function createPythonResourceDir(): string {
  mkdirSync(resourceRoot, { recursive: true })
  return mkdtempSync(path.join(resourceRoot, 'repl-python-'))
}

export function removePythonResourceDir(resourceDir: string): void {
  rmSync(resourceDir, { force: true, recursive: true })
}

export async function retirePythonResources(
  child: ChildProcessWithoutNullStreams,
  resourceDir: string,
  isStartupCancelled: boolean,
  orderly: (() => void) | undefined
): Promise<CleanupResult> {
  const options: RetireOptions = isStartupCancelled
    ? STARTUP_RETIRE_OPTIONS
    : { ...RETIRE_OPTIONS, orderly }
  const broker = await retireProcessGroup(child, options)
  const unspawned = cleanupUnspawnedBroker(child, broker, resourceDir)
  if (unspawned !== undefined) {
    return unspawned
  }

  const kernel = await retireRecordedKernel(resourceDir)
  const failed = [broker, kernel].find((result) => !result.confirmed)
  return failed ?? removeResourceDir(resourceDir)
}
