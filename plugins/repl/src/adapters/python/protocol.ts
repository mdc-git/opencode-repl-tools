import type { OutputStream } from '../../model.ts'
import {
  isBooleanValue,
  optionalStringValue,
  protocolError,
  recordValue,
  stringValue,
  type JsonRecord,
  type ProtocolError
} from '../protocol.ts'

export type PythonBrokerEvent =
  | { readonly type: 'ready'; readonly pythonVersion: string }
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
  | {
      readonly type: 'done'
      readonly jobId: string
      readonly ok: boolean
      readonly error?: ProtocolError
    }
  | { readonly type: 'fatal'; readonly message: string }
  | { readonly type: 'shutdown'; readonly confirmed: boolean }

const WAITING_INPUT = 'waiting_input' as const
const outputStreams = new Set<OutputStream>(['stdout', 'stderr', 'display', 'system'])

function outputStream(event: JsonRecord): OutputStream {
  const stream = stringValue(event, 'stream', 'Python output event') as OutputStream
  if (!outputStreams.has(stream)) {
    throw new Error(`invalid Python output stream: ${stream}`)
  }

  return stream
}

function decodeOutput(event: JsonRecord): PythonBrokerEvent {
  const jobId = optionalStringValue(event, 'jobId', 'Python output event')
  return {
    type: 'output',
    stream: outputStream(event),
    text: stringValue(event, 'text', 'Python output event'),
    ...(jobId !== undefined && { jobId })
  }
}

function decodeWaitingInput(event: JsonRecord): PythonBrokerEvent {
  return {
    type: 'waiting_input',
    jobId: stringValue(event, 'jobId', 'Python input event'),
    prompt: stringValue(event, 'prompt', 'Python input event'),
    password: isBooleanValue(event, 'password', 'Python input event')
  }
}

function decodeDone(event: JsonRecord): PythonBrokerEvent {
  const error = protocolError(event.error, 'Python done error')
  return {
    type: 'done',
    jobId: stringValue(event, 'jobId', 'Python done event'),
    ok: isBooleanValue(event, 'ok', 'Python done event'),
    ...(error !== undefined && { error })
  }
}

const decoders: Readonly<Record<string, (event: JsonRecord) => PythonBrokerEvent>> = {
  ready: (event) => ({
    type: 'ready',
    pythonVersion: stringValue(event, 'pythonVersion', 'Python ready event')
  }),
  output: decodeOutput,
  [WAITING_INPUT]: decodeWaitingInput,
  done: decodeDone,
  fatal: (event) => ({
    type: 'fatal',
    message: stringValue(event, 'message', 'Python fatal event')
  }),
  shutdown: (event) => ({
    type: 'shutdown',
    confirmed: isBooleanValue(event, 'confirmed', 'Python shutdown event')
  })
}

export function decodePythonEvent(value: unknown): PythonBrokerEvent {
  const event = recordValue(value, 'Python broker event')
  const type = stringValue(event, 'type', 'Python broker event')
  const decode = decoders[type]
  if (decode === undefined) {
    throw new Error(`unknown Python broker event: ${JSON.stringify(value)}`)
  }

  return decode(event)
}
