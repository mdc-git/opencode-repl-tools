import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const packagePath = 'package.json'
const protectedPackage = '@opencode/plugin'
const sections = ['dependencies', 'devDependencies']
const apply = process.argv.includes('--apply')
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))

function runBun(args, cwd) {
  try {
    return execFileSync('bun', args, { cwd, encoding: 'utf8' })
  } catch (error) {
    if (error.stderr) {
      process.stderr.write(error.stderr)
    }

    throw error
  }
}

function parseLock(cwd) {
  const source = [
    "const text = await Bun.file('bun.lock').text()",
    'process.stdout.write(JSON.stringify(Bun.JSONC.parse(text)))'
  ].join(';')

  return JSON.parse(runBun(['-e', source], cwd))
}

function resolveGraph(manifest) {
  const cwd = mkdtempSync(join(tmpdir(), 'opencode-repl-deps-'))

  try {
    writeFileSync(join(cwd, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    runBun(['install', '--lockfile-only', '--ignore-scripts', '--no-cache'], cwd)
    return parseLock(cwd)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function resolvedVersion(lock, name) {
  const resolution = lock.packages?.[name]?.[0]
  const prefix = `${name}@`

  if (typeof resolution !== 'string' || !resolution.startsWith(prefix)) {
    throw new Error(`No root resolution found for ${name}`)
  }

  return resolution.slice(prefix.length)
}

function nextSpecifier(current, version) {
  if (current.startsWith('^')) {
    return `^${version}`
  }

  if (current.startsWith('~')) {
    return `~${version}`
  }

  return version
}

process.stdout.write('Resolving current dependency graph...\n')
const baseline = resolveGraph(pkg)
const candidate = structuredClone(pkg)

for (const section of sections) {
  for (const name of Object.keys(candidate[section] ?? {})) {
    if (name === protectedPackage) {
      candidate[section][name] = 'beta'
      continue
    }

    candidate[section][name] = `>=${resolvedVersion(baseline, name)}`
  }
}

process.stdout.write('Resolving upgrade dependency graph...\n')
const upgrade = resolveGraph(candidate)
const changes = []

for (const section of sections) {
  for (const [name, current] of Object.entries(pkg[section] ?? {})) {
    const next =
      name === protectedPackage ? 'beta' : nextSpecifier(current, resolvedVersion(upgrade, name))

    if (next === current) {
      continue
    }

    changes.push({ section, name, current, next })
    pkg[section][name] = next
  }
}

for (const { section, name, current, next } of changes) {
  process.stdout.write(`${section}: ${name}: ${current} -> ${next}\n`)
}

if (changes.length === 0) {
  process.stdout.write('All direct dependencies already match the resolved upgrade graph.\n')
} else if (apply) {
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  process.stdout.write('\npackage.json updated.\n')
} else {
  process.stdout.write('\nDry run only. Re-run with --apply to update package.json.\n')
}
