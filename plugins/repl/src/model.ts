import { Schema } from 'effect'

export const Language = Schema.Literals(['node', 'python'])
export type Language = typeof Language.Type

export const JobState = Schema.Literals([
  'starting',
  'running',
  'waiting_input',
  'succeeded',
  'failed',
  'cancelled'
])
export type JobState = typeof JobState.Type

export const OutputStream = Schema.Literals(['stdout', 'stderr', 'display', 'system'])
export type OutputStream = typeof OutputStream.Type

export const ErrorKind = Schema.Literals([
  'busy',
  'not_found',
  'invalid_state',
  'startup',
  'runtime',
  'lifecycle'
])
export type ErrorKind = typeof ErrorKind.Type

export const OutputChunk = Schema.Struct({
  cursor: Schema.Number,
  stream: OutputStream,
  text: Schema.String,
  jobId: Schema.optionalKey(Schema.String)
})
export type OutputChunk = typeof OutputChunk.Type

export const ReplError = Schema.Struct({
  kind: ErrorKind,
  message: Schema.String
})
export type ReplError = typeof ReplError.Type

export const EvalInput = Schema.Struct({ code: Schema.String })
export type EvalInput = typeof EvalInput.Type

export const JobStatusInput = Schema.Struct({
  action: Schema.Literal('status'),
  id: Schema.String,
  cursor: Schema.optionalKey(Schema.Number)
})
export const JobCancelInput = Schema.Struct({
  action: Schema.Literal('cancel'),
  id: Schema.String
})
export const JobStdinInput = Schema.Struct({
  action: Schema.Literal('stdin'),
  id: Schema.String,
  data: Schema.String
})
export const JobInput = Schema.Union([JobStatusInput, JobCancelInput, JobStdinInput])
export type JobInput = typeof JobInput.Type

export const ResetInput = Schema.Struct({ language: Language })
export type ResetInput = typeof ResetInput.Type

export const JobStatus = Schema.Struct({
  ok: Schema.Literal(true),
  id: Schema.String,
  language: Language,
  state: JobState,
  cursor: Schema.Number,
  truncated: Schema.Boolean,
  chunks: Schema.Array(OutputChunk),
  prompt: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(ReplError)
})
export type JobStatus = typeof JobStatus.Type

export const ExpectedError = Schema.Struct({
  ok: Schema.Literal(false),
  error: ReplError
})
export type ExpectedError = typeof ExpectedError.Type

export const JobOperationOutput = Schema.Union([JobStatus, ExpectedError])
export type JobOperationOutput = typeof JobOperationOutput.Type

export const ResetSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  language: Language
})
export type ResetSuccess = typeof ResetSuccess.Type

export const ResetOutput = Schema.Union([ResetSuccess, ExpectedError])
export type ResetOutput = typeof ResetOutput.Type
