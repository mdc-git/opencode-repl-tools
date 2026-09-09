import { Schema } from 'effect'

const literal = Schema.Literal
const literals = Schema.Literals
const struct = Schema.Struct
const union = Schema.Union
const array = Schema.Array

const languageSchema = literals(['node', 'python'])
export type Language = typeof languageSchema.Type

const jobStateSchema = literals([
  'starting',
  'running',
  'waiting_input',
  'succeeded',
  'failed',
  'cancelled'
])
export type JobState = typeof jobStateSchema.Type

const outputStreamSchema = literals(['stdout', 'stderr', 'display', 'system'])
export type OutputStream = typeof outputStreamSchema.Type

const errorKindSchema = literals([
  'busy',
  'not_found',
  'invalid_state',
  'startup',
  'runtime',
  'lifecycle'
])
export type ErrorKind = typeof errorKindSchema.Type

const outputChunkSchema = struct({
  cursor: Schema.Number,
  stream: outputStreamSchema,
  text: Schema.String,
  jobId: Schema.optionalKey(Schema.String)
})
export type OutputChunk = typeof outputChunkSchema.Type

const replErrorSchema = struct({
  kind: errorKindSchema,
  message: Schema.String
})
export type ReplError = typeof replErrorSchema.Type

export const evalInputSchema = struct({ code: Schema.String })

const jobStatusInputSchema = struct({
  action: literal('status'),
  id: Schema.String,
  cursor: Schema.optionalKey(Schema.Number)
})
const jobCancelInputSchema = struct({
  action: literal('cancel'),
  id: Schema.String
})
const jobStdinInputSchema = struct({
  action: literal('stdin'),
  id: Schema.String,
  data: Schema.String
})
export const jobInputSchema = union([
  jobStatusInputSchema,
  jobCancelInputSchema,
  jobStdinInputSchema
])
export type JobInput = typeof jobInputSchema.Type

export const resetInputSchema = struct({ language: languageSchema })

const jobStatusSchema = struct({
  ok: literal(true),
  id: Schema.String,
  language: languageSchema,
  state: jobStateSchema,
  cursor: Schema.Number,
  truncated: Schema.Boolean,
  chunks: array(outputChunkSchema),
  prompt: Schema.optionalKey(Schema.String),
  password: Schema.optionalKey(Schema.Boolean),
  error: Schema.optionalKey(replErrorSchema)
})
export type JobStatus = typeof jobStatusSchema.Type

const expectedErrorSchema = struct({
  ok: literal(false),
  error: replErrorSchema
})

export const jobOperationOutputSchema = union([jobStatusSchema, expectedErrorSchema])
export type JobOperationOutput = typeof jobOperationOutputSchema.Type

const resetSuccessSchema = struct({
  ok: literal(true),
  language: languageSchema
})

export const resetOutputSchema = union([resetSuccessSchema, expectedErrorSchema])
export type ResetOutput = typeof resetOutputSchema.Type
