import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import repl from 'node:repl'
import { PassThrough, Writable } from 'node:stream'
import ts from 'typescript'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES_PER_EVALUATION = 4
const MAX_TOTAL_IMAGE_BYTES = MAX_IMAGE_BYTES * MAX_IMAGES_PER_EVALUATION
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function requiredCwd() {
  const index = process.argv.indexOf('--cwd')
  if (index === -1) {
    throw new Error('node-repl worker requires --cwd')
  }

  const value = process.argv[index + 1]
  if (typeof value !== 'string') {
    throw new TypeError('node-repl worker requires --cwd')
  }

  return value
}

function lineText(text) {
  return text.endsWith('\n') ? text : `${text}\n`
}

function fullReason(error) {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`
  }

  return String(error)
}

function conciseError(error) {
  if (!(error instanceof Error)) {
    return { kind: 'Error', message: String(error) }
  }

  return { kind: error.name || 'Error', message: error.message }
}

const sessionDirectory = requiredCwd()
const control = fs.createReadStream('/dev/null', { fd: 3 })
const events = fs.createWriteStream('/dev/null', { fd: 4 })
const replInput = new PassThrough()
const replOutput = new Writable({
  write(_chunk, _encoding, callback) {
    callback()
  }
})
let controlBuffer = ''
let activeJobId
let activeImageCount = 0
let activeImageBytes = 0
let isShuttingDown = false
let isFatalSeen = false

const transpileOptions = {
  target: ts.ScriptTarget.ES2024,
  module: ts.ModuleKind.CommonJS,
  sourceMap: false,
  inlineSourceMap: false,
  inlineSources: false
}

function diagnosticText(diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  if (diagnostic.file === undefined || diagnostic.start === undefined) {
    return `TypeScript: ${message}`
  }

  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  return `TypeScript ${position.line + 1}:${position.character + 1}: ${message}`
}

function transpile(code) {
  const result = ts.transpileModule(code, {
    compilerOptions: transpileOptions,
    fileName: 'repl.ts',
    reportDiagnostics: true
  })
  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  )
  if (errors.length > 0) {
    throw new SyntaxError(errors.map((diagnostic) => diagnosticText(diagnostic)).join('\n'))
  }

  return result.outputText
}

function emit(message) {
  events.write(`${JSON.stringify(message)}\n`)
}

function clearActiveEvaluation() {
  activeJobId = undefined
  activeImageCount = 0
  activeImageBytes = 0
}

function imageBytes(value) {
  if (Buffer.isBuffer(value)) {
    return value
  }

  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value)
  }

  throw new TypeError(
    'opencode.emitImage bytes must be a Buffer, Uint8Array, ArrayBuffer, or array-buffer view'
  )
}

function imageMimeType(value) {
  if (typeof value !== 'string') {
    throw new TypeError('opencode.emitImage mimeType must be a string')
  }

  const mime = value.toLowerCase()
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mime)) {
    throw new Error('opencode.emitImage supports PNG, JPEG, WebP, and GIF images only')
  }

  return mime
}

function imageName(value) {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('opencode.emitImage filename must be a non-empty string')
  }

  const name = path
    .basename(value.trim())
    .replaceAll(/[^\w.-]/g, '_')
    .slice(0, 255)
  if (name.length === 0) {
    throw new TypeError('opencode.emitImage filename must contain a valid filename')
  }

  return name
}

function emitImage(value) {
  const jobId = activeJobId
  if (jobId === undefined) {
    throw new Error('opencode.emitImage requires an active repl_node evaluation')
  }

  if (typeof value !== 'object' || value === null) {
    throw new TypeError('opencode.emitImage expects { bytes, mimeType, filename? }')
  }

  const bytes = imageBytes(value.bytes)
  if (bytes.byteLength === 0) {
    throw new Error('opencode.emitImage expected non-empty image bytes')
  }

  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`opencode.emitImage image exceeds the ${MAX_IMAGE_BYTES}-byte limit`)
  }

  if (activeImageCount >= MAX_IMAGES_PER_EVALUATION) {
    throw new Error(
      `opencode.emitImage supports at most ${MAX_IMAGES_PER_EVALUATION} images per evaluation`
    )
  }

  const nextBytes = activeImageBytes + bytes.byteLength
  if (nextBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error(
      `opencode.emitImage images exceed the ${MAX_TOTAL_IMAGE_BYTES}-byte evaluation limit`
    )
  }

  const mime = imageMimeType(value.mimeType)
  const name = imageName(value.filename)
  activeImageCount += 1
  activeImageBytes = nextBytes
  emit({
    type: 'image',
    jobId,
    mime,
    data: bytes.toString('base64'),
    ...(name !== undefined && { name })
  })
}

function closeWorker(exitCode) {
  isShuttingDown = true
  process.exitCode = exitCode
  server.close()
  replInput.destroy()
  control.destroy()
  events.end()
}

function fatal(reason) {
  if (isFatalSeen) {
    return
  }

  isFatalSeen = true
  const text = fullReason(reason)
  if (text.length > 0) {
    process.stderr.write(lineText(text))
  }

  emit({ type: 'fatal', message: text })
  closeWorker(1)
}

function emitEvaluationFailure(jobId, error) {
  const text = fullReason(error)
  emit({ type: 'output', jobId, stream: 'stderr', text: lineText(text) })
  emit({ type: 'done', jobId, ok: false, error: conciseError(error) })
}

function handleReplError(error) {
  const jobId = activeJobId
  if (jobId === undefined) {
    fatal(error)
    return 'ignore'
  }

  clearActiveEvaluation()
  emitEvaluationFailure(jobId, error)
  return 'ignore'
}

const server = repl.start({
  prompt: '',
  input: replInput,
  output: replOutput,
  terminal: false,
  useGlobal: true,
  ignoreUndefined: true,
  useColors: false,
  breakEvalOnSigint: true,
  handleError: handleReplError
})
server.context.require = createRequire(path.join(sessionDirectory, '__opencode_repl__.js'))
server.context.opencode = Object.freeze({ emitImage })

function renderResult(jobId, result) {
  if (result === undefined) {
    return true
  }

  try {
    const rendered = server.writer(result)
    if (rendered === 'undefined') {
      return true
    }

    emit({ type: 'output', jobId, stream: 'display', text: lineText(rendered) })
    return true
  } catch (error) {
    emitEvaluationFailure(jobId, error)
    return false
  }
}

function hasError(error) {
  return error !== null && error !== undefined
}

function finishEvaluation(jobId, error, result) {
  if (activeJobId !== jobId) {
    return
  }

  clearActiveEvaluation()
  if (hasError(error)) {
    emitEvaluationFailure(jobId, error)
    return
  }

  if (renderResult(jobId, result)) {
    emit({ type: 'done', jobId, ok: true })
  }
}

function evaluate(jobId, code) {
  if (activeJobId !== undefined) {
    fatal(new Error('received eval while another evaluation is active'))
    return
  }

  let javascript
  try {
    javascript = transpile(code)
  } catch (error) {
    emitEvaluationFailure(jobId, error)
    return
  }

  activeJobId = jobId
  activeImageCount = 0
  activeImageBytes = 0
  server.eval(javascript, server.context, 'repl.ts', (error, result) =>
    finishEvaluation(jobId, error, result)
  )
}

function evaluateCommand(message) {
  if (typeof message.jobId !== 'string' || typeof message.code !== 'string') {
    fatal(new Error('invalid eval command'))
    return
  }

  evaluate(message.jobId, message.code)
}

function shutdown() {
  if (isShuttingDown) {
    return
  }

  fs.writeSync(4, `${JSON.stringify({ type: 'shutdown' })}\n`)
  closeWorker(0)
}

function commandType(message) {
  if (typeof message !== 'object' || message === null) {
    return undefined
  }

  return message.type
}

function handleControl(message) {
  switch (commandType(message)) {
    case 'eval': {
      evaluateCommand(message)
      return
    }

    case 'shutdown': {
      shutdown()
      return
    }

    default: {
      fatal(new Error('unknown control command'))
    }
  }
}

function consumeControlLine(line) {
  if (line.length === 0) {
    return
  }

  try {
    handleControl(JSON.parse(line))
  } catch (error) {
    fatal(error)
  }
}

function consumeControlChunk(chunk) {
  controlBuffer += chunk
  let newline = controlBuffer.indexOf('\n')
  while (newline >= 0) {
    const line = controlBuffer.slice(0, newline)
    controlBuffer = controlBuffer.slice(newline + 1)
    consumeControlLine(line)
    newline = controlBuffer.indexOf('\n')
  }
}

control.setEncoding('utf8')
control.on('data', consumeControlChunk)
control.on('error', fatal)
server.on('exit', () => {
  if (!isShuttingDown) {
    fatal(new Error('Node REPL exited unexpectedly'))
  }
})
process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)

emit({ type: 'ready', nodeVersion: process.version })
