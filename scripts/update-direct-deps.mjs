import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const packagePath = 'package.json'
const protectedPackage = '@opencode/plugin'
const sections = ['dependencies', 'devDependencies']
const apply = process.argv.includes('--apply')
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
const changes = []

function latestVersion(name) {
  const output = execFileSync('npm', ['view', `${name}@latest`, 'version', '--json'], {
    encoding: 'utf8'
  })

  return JSON.parse(output)
}

function nextSpecifier(current, latest) {
  if (current.startsWith('^')) {
    return `^${latest}`
  }

  if (current.startsWith('~')) {
    return `~${latest}`
  }

  return latest
}

for (const section of sections) {
  for (const [name, current] of Object.entries(pkg[section] ?? {})) {
    const next = name === protectedPackage ? 'beta' : nextSpecifier(current, latestVersion(name))

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
  process.stdout.write('All direct dependencies are already current.\n')
}

if (changes.length > 0) {
  if (apply) {
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
    process.stdout.write('\npackage.json updated.\n')
  } else {
    process.stdout.write('\nDry run only. Re-run with --apply to update package.json.\n')
  }
}
