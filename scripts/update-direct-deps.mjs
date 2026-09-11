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

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8' })
  } catch (error) {
    if (error.stdout) {
      process.stderr.write(error.stdout)
    }

    if (error.stderr) {
      process.stderr.write(error.stderr)
    }

    throw error
  }
}

function resolveCurrentGraph(manifest) {
  const cwd = mkdtempSync(join(tmpdir(), 'opencode-repl-current-'))

  try {
    writeFileSync(join(cwd, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    run('bun', ['install', '--lockfile-only', '--ignore-scripts', '--no-cache'], cwd)
    const source = [
      "const text = await Bun.file('bun.lock').text()",
      'process.stdout.write(JSON.stringify(Bun.JSONC.parse(text)))'
    ].join(';')

    return JSON.parse(run('bun', ['-e', source], cwd))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function resolveCompatibleGraph(manifest) {
  const cwd = mkdtempSync(join(tmpdir(), 'opencode-repl-compatible-'))

  try {
    writeFileSync(join(cwd, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    run(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--strict-peer-deps',
        '--no-audit',
        '--no-fund'
      ],
      cwd
    )

    return JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8'))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

function bunResolvedVersion(lock, name) {
  const resolution = lock.packages?.[name]?.[0]
  const prefix = `${name}@`

  if (typeof resolution !== 'string' || !resolution.startsWith(prefix)) {
    throw new Error(`No root Bun resolution found for ${name}`)
  }

  return resolution.slice(prefix.length)
}

function npmResolvedVersion(lock, name) {
  const version = lock.packages?.[`node_modules/${name}`]?.version

  if (typeof version !== 'string') {
    throw new TypeError(`No root npm resolution found for ${name}`)
  }

  return version
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
const baseline = resolveCurrentGraph(pkg)
const candidate = structuredClone(pkg)

for (const section of sections) {
  for (const name of Object.keys(candidate[section] ?? {})) {
    if (name === protectedPackage) {
      candidate[section][name] = 'beta'
      continue
    }

    candidate[section][name] = `>=${bunResolvedVersion(baseline, name)}`
  }
}

process.stdout.write('Resolving peer-compatible upgrade graph...\n')
const upgrade = resolveCompatibleGraph(candidate)
const changes = []

for (const section of sections) {
  for (const [name, current] of Object.entries(pkg[section] ?? {})) {
    const next =
      name === protectedPackage ? 'beta' : nextSpecifier(current, npmResolvedVersion(upgrade, name))

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
  process.stdout.write('All direct dependencies already match the compatible upgrade graph.\n')
} else if (apply) {
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  process.stdout.write('\npackage.json updated.\n')
} else {
  process.stdout.write('\nDry run only. Re-run with --apply to update package.json.\n')
}
