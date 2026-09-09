import {
  isBooleanValue,
  protocolError,
  recordValue,
  stringValue,
  type JsonRecord,
  type ProtocolError
} from './protocol.ts'

export type NodeWorkerEvent =
  | { readonly type: 'ready'; readonly nodeVersion: string }
  | {
      readonly type: 'output'
      readonly jobId: string
      readonly stream: 'display' | 'stderr'
      readonly text: string
    }
  | {
      readonly type: 'done'
      readonly jobId: string
      readonly ok: boolean
      readonly error?: ProtocolError
    }
  | { readonly type: 'fatal'; readonly message: string }
  | { readonly type: 'shutdown' }

function decodeReady(event: JsonRecord): NodeWorkerEvent {
  return { type: 'ready', nodeVersion: stringValue(event, 'nodeVersion', 'Node ready event') }
}

function decodeOutput(event: JsonRecord): NodeWorkerEvent {
  const stream = stringValue(event, 'stream', 'Node output event')
  if (stream !== 'display' && stream !== 'stderr') {
    throw new Error(`invalid Node output stream: ${stream}`)
  }

  return {
    type: 'output',
    jobId: stringValue(event, 'jobId', 'Node output event'),
    stream,
    text: stringValue(event, 'text', 'Node output event')
  }
}

function decodeDone(event: JsonRecord): NodeWorkerEvent {
  const error = protocolError(event.error, 'Node done error')
  return {
    type: 'done',
    jobId: stringValue(event, 'jobId', 'Node done event'),
    ok: isBooleanValue(event, 'ok', 'Node done event'),
    ...(error !== undefined && { error })
  }
}

function decodeFatal(event: JsonRecord): NodeWorkerEvent {
  return { type: 'fatal', message: stringValue(event, 'message', 'Node fatal event') }
}

const decoders: Readonly<Record<string, (event: JsonRecord) => NodeWorkerEvent>> = {
  ready: decodeReady,
  output: decodeOutput,
  done: decodeDone,
  fatal: decodeFatal,
  shutdown: () => ({ type: 'shutdown' })
}

export function decodeNodeEvent(value: unknown): NodeWorkerEvent {
  const event = recordValue(value, 'Node worker event')
  const type = stringValue(event, 'type', 'Node worker event')
  const decode = decoders[type]
  if (decode === undefined) {
    throw new Error(`unknown Node worker event: ${JSON.stringify(value)}`)
  }

  return decode(event)
}
