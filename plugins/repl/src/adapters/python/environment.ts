import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { errorMessage } from '../protocol.ts'
import { captureCommand } from './command.ts'
import { PythonStartupError } from './types.ts'

const requirementsPath = fileURLToPath(new URL('../../../requirements.txt', import.meta.url))
const VERSION_COMMAND = [
  '-c',
  "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"
] as const
const VERIFY_COMMAND = [
  '-c',
  'import importlib.metadata as m; assert m.version("ipykernel") == "7.3.0"; assert m.version("jupyter_client") == "8.10.0"'
] as const
const VERSION_PATTERN = /^(?<major>\d+)\.(?<minor>\d+)/v

type PythonVersion = {
  readonly major: number
  readonly minor: number
}

type EnvironmentPaths = {
  readonly root: string
  readonly venv: string
  readonly python: string
}

function versionPart(version: string, name: 'major' | 'minor'): string | undefined {
  return VERSION_PATTERN.exec(version.trim())?.groups?.[name]
}

function parseVersion(version: string): PythonVersion | undefined {
  const major = versionPart(version, 'major')
  const minor = versionPart(version, 'minor')
  if (major === undefined || minor === undefined) {
    return undefined
  }

  return { major: Number(major), minor: Number(minor) }
}

function isSupportedVersion(version: PythonVersion | undefined): version is PythonVersion {
  if (version === undefined) {
    return false
  }

  return version.major > 3 || (version.major === 3 && version.minor >= 10)
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined
  }

  return error.code
}

function cacheRoot(): string {
  const home = process.env.HOME ?? os.homedir()
  return process.env.XDG_CACHE_HOME ?? path.join(home, '.cache')
}

function pathsFor(version: PythonVersion, requirementsSha: string): EnvironmentPaths {
  const root = path.join(
    cacheRoot(),
    'opencode',
    'repl-tools',
    'python',
    `${version.major}.${version.minor}`,
    requirementsSha
  )
  const venv = path.join(root, 'venv')
  return { root, venv, python: path.join(venv, 'bin', 'python') }
}

async function doesFileExist(filename: string): Promise<boolean> {
  try {
    await fs.access(filename)
    return true
  } catch {
    return false
  }
}

async function verifyEnvironment(python: string, signal: AbortSignal): Promise<void> {
  await captureCommand(python, VERIFY_COMMAND, signal)
}

function isPublishRace(code: unknown): boolean {
  return code === 'EEXIST' || code === 'ENOTEMPTY'
}

async function copyPublished(temporaryVenv: string, finalVenv: string): Promise<void> {
  const parent = path.dirname(finalVenv)
  const staging = path.join(parent, `.publish-${process.pid}-${crypto.randomUUID()}`)
  try {
    await fs.cp(temporaryVenv, staging, { recursive: true, errorOnExist: true })
    try {
      await fs.rename(staging, finalVenv)
    } catch (error) {
      if (!isPublishRace(errorCode(error))) {
        throw error
      }
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function publishFallback(
  error: unknown,
  temporaryVenv: string,
  finalVenv: string
): Promise<void> {
  const code = errorCode(error)
  if (isPublishRace(code)) {
    return
  }

  if (code === 'EXDEV') {
    await copyPublished(temporaryVenv, finalVenv)
    return
  }

  throw error
}

async function publish(temporaryVenv: string, finalVenv: string): Promise<void> {
  try {
    await fs.rename(temporaryVenv, finalVenv)
  } catch (error) {
    await publishFallback(error, temporaryVenv, finalVenv)
  }
}

export class PythonEnvironment {
  private readonly bootstrapAbort = new AbortController()
  private bootstrapPromise: Promise<string> | undefined
  private readyPython: string | undefined
  private readonly temporaryRoots = new Set<string>()

  constructor(private readonly configuredPython: string) {}

  private remember(python: string): string {
    this.readyPython = python
    return python
  }

  private clearFailure(error: unknown): never {
    this.bootstrapPromise = undefined
    throw error
  }

  private async configuredVersion(
    signal: AbortSignal
  ): Promise<{ version: PythonVersion; tail: string }> {
    const result = await captureCommand(this.configuredPython, VERSION_COMMAND, signal)
    const version = parseVersion(result.stdout)
    if (!isSupportedVersion(version)) {
      const output = result.stdout.trim()
      const reported = output === '' ? 'an unknown version' : output
      throw new PythonStartupError(
        `Python REPL requires Python >= 3.10; configured executable reported ${reported}`,
        result.tail
      )
    }

    return { version, tail: result.tail }
  }

  private async build(signal: AbortSignal): Promise<string> {
    const { version } = await this.configuredVersion(signal)
    const requirements = await fs.readFile(requirementsPath)
    const sha = crypto.createHash('sha256').update(requirements).digest('hex')
    const paths = pathsFor(version, sha)
    await fs.mkdir(paths.root, { recursive: true })
    if (await doesFileExist(paths.python)) {
      return this.useCached(paths, signal)
    }

    return this.create(paths, signal)
  }

  private async useCached(paths: EnvironmentPaths, signal: AbortSignal): Promise<string> {
    try {
      await verifyEnvironment(paths.python, signal)
      return paths.python
    } catch (error) {
      const tail = error instanceof PythonStartupError ? error.diagnosticTail : undefined
      throw new PythonStartupError(
        `cached Python REPL environment is invalid at ${paths.venv}`,
        tail
      )
    }
  }

  private async create(paths: EnvironmentPaths, signal: AbortSignal): Promise<string> {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-repl-python-'))
    const temporaryVenv = path.join(temporaryRoot, 'venv')
    this.temporaryRoots.add(temporaryRoot)
    try {
      await this.populate(temporaryVenv, signal)
      await publish(temporaryVenv, paths.venv)
      await verifyEnvironment(paths.python, signal)
      return paths.python
    } catch (error) {
      if (error instanceof PythonStartupError) {
        throw error
      }

      throw new PythonStartupError(errorMessage(error))
    } finally {
      await this.removeTemporary(temporaryRoot)
    }
  }

  private async populate(venv: string, signal: AbortSignal): Promise<void> {
    await captureCommand(this.configuredPython, ['-m', 'venv', venv], signal)
    const python = path.join(venv, 'bin', 'python')
    await captureCommand(
      python,
      [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '--no-cache-dir',
        '--no-compile',
        '-r',
        requirementsPath
      ],
      signal
    )
  }

  private async removeTemporary(temporaryRoot: string): Promise<void> {
    this.temporaryRoots.delete(temporaryRoot)
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
  }

  async ensure(): Promise<string> {
    if (this.readyPython !== undefined) {
      return this.readyPython
    }

    if (this.bootstrapPromise !== undefined) {
      return this.bootstrapPromise
    }

    this.bootstrapPromise = this.build(this.bootstrapAbort.signal)
      .then((python) => this.remember(python))
      .catch((error: unknown) => this.clearFailure(error))
    return this.bootstrapPromise
  }

  async close(): Promise<void> {
    this.bootstrapAbort.abort()
    await this.bootstrapPromise?.catch(() => undefined)
    await Promise.allSettled(
      [...this.temporaryRoots].map(async (item) => fs.rm(item, { recursive: true, force: true }))
    )
    this.temporaryRoots.clear()
  }
}
