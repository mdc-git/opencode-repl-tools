import { Schema } from 'effect'

const languageSchema = Schema.Literals(['node', 'python'])
export type Language = typeof languageSchema.Type

const jobStateSchema = Schema.Literals([
  'starting',
  'running',
  'waiting_input',
  'succeeded',
  'failed',
  'cancelled'
])
export type JobState = typeof jobStateSchema.Type

const outputStreamSchema = Schema.Literals(['stdout', 'stderr', 'display', 'system'])
export type OutputStream = typeof outputStreamSchema.Type

const errorKindSchema = Schema.Literals([
  'busy',
  'not_found',
  'invalid_state',
  'startup',
  'runtime',
  'lifecycle'
])
export type ErrorKind = typeof errorKindSchema.Type

const outputChunkSchema = Schema.Struct({
  cursor: Schema.Number,
  stream: outputStreamSchema,
  text: Schema.String,
  jobId: Schema.optionalKey(Schema.String)
})
export type OutputChunk = typeof outputChunkSchema.Type

const replErrorSchema = Schema.Struct({
  kind: errorKindSchema,
  message: Schema.String
})
export type ReplError = typeof replErrorSchema.Type

export const evalInputSchema = Schema.Struct({ code: Schema.String })

const jobStatusInputSchema = Schema.Struct({
  action: Schema.Literal('status'),
  id: Schema.String,
  cursor: Schema.optionalKey(Schema.Number)
})
const jobCancelInputSchema = Schema.Struct({
  action: Schema.Literal('cancel'),
  id: Schema.String
})
const jobStdinInputSchema = Schema.Struct({
  action: Schema.Literal('stdin'),
  id: Schema.String,
  data: Schema.String
})
export const jobInputSchema = Schema.Union([
  jobStatusInputSchema,
  jobCancelInputSchema,
  jobStdinInputSchema
])
export type JobInput = typeof jobInputSchema.Type

export const resetInputSchema = Schema.Struct({ language: languageSchema })

const jobStatusSchema = Schema.Struct({
  ok: Schema.Literal(true),
  id: Schema.String,
  language: languageSchema,
  state: jobStateSchema,
  cursor: Schema.Number,
  truncated: Schema.Boolean,
  chunks: Schema.Array(outputChunkSchema),
  prompt: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(replErrorSchema)
})
export type JobStatus = typeof jobStatusSchema.Type

const expectedErrorSchema = Schema.Struct({
  ok: Schema.Literal(false),
  error: replErrorSchema
})

export const jobOperationOutputSchema = Schema.Union([jobStatusSchema, expectedErrorSchema])
export type JobOperationOutput = typeof jobOperationOutputSchema.Type

const resetSuccessSchema = Schema.Struct({
  ok: Schema.Literal(true),
  language: languageSchema
})

export const resetOutputSchema = Schema.Union([resetSuccessSchema, expectedErrorSchema])
export type ResetOutput = typeof resetOutputSchema.Type
