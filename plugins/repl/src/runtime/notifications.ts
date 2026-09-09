import { Effect } from 'effect'
import { utf8Tail } from './output.ts'
import type { RuntimeState } from './state.ts'
import {
  PREVIEW_BYTES,
  SESSION_ID_KEY,
  errorMessage,
  isSameCell,
  type Cell,
  type Job
} from './types.ts'

function isNotificationSuppressed(cell: Cell, job: Job): boolean {
  return cell.notificationsSuppressed || job.notificationSuppressed
}

function isTerminalNotificationState(job: Job): boolean {
  return job.state === 'succeeded' || job.state === 'failed'
}

function canNotifyTerminal(cell: Cell, job: Job): boolean {
  if (isNotificationSuppressed(cell, job)) {
    return false
  }

  if (job.terminalNotificationDone) {
    return false
  }

  if (!job.backgrounded) {
    return false
  }

  return isTerminalNotificationState(job)
}

function terminalText(cell: Cell, job: Job): string {
  const read = cell.transcript.read(job.startCursor)
  const raw = read.chunks.map((chunk) => chunk.text).join('')
  const preview = utf8Tail(raw, PREVIEW_BYTES)
  return [
    `${job.language} REPL job ${job.id} ${job.state}.`,
    preview.length > 0 ? preview : '(no transcript output)',
    `Use repl_job with action "status" and id "${job.id}" to read the Cell transcript by cursor.`
  ].join('\n')
}

function isInputNotificationBlocked(job: Job): boolean {
  return job.notificationSuppressed || !job.backgrounded
}

function canNotifyInput(job: Job, serial: number): boolean {
  if (isInputNotificationBlocked(job)) {
    return false
  }

  if (job.state !== 'waiting_input') {
    return false
  }

  if (job.inputSerial !== serial) {
    return false
  }

  return job.inputNotificationSerial < serial
}

function inputText(job: Job): string {
  return [
    `Python REPL job ${job.id} is waiting for input.`,
    `Prompt: ${job.prompt ?? ''}`,
    `Password: ${job.password === true ? 'true' : 'false'}`,
    `Reply with repl_job action "stdin", id "${job.id}", and the exact data to send.`
  ].join('\n')
}

function deliveryFailure(label: string, cell: Cell, job: Job, error: unknown): Effect.Effect<void> {
  return Effect.logWarning(label, {
    [SESSION_ID_KEY]: cell.sessionID,
    jobId: job.id,
    error: errorMessage(error)
  })
}

export function notifyTerminal(state: RuntimeState, cell: Cell, job: Job): Effect.Effect<void> {
  return state.locked((map) => {
    if (!isSameCell(map, cell) || !canNotifyTerminal(cell, job)) {
      return Effect.void
    }

    job.terminalNotificationDone = true
    return state.ctx.session
      .synthetic({
        [SESSION_ID_KEY]: cell.sessionID,
        text: terminalText(cell, job),
        resume: true
      })
      .pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          deliveryFailure('REPL terminal notification delivery failed', cell, job, error)
        )
      )
  })
}

export function notifyInput(
  state: RuntimeState,
  cell: Cell,
  job: Job,
  serial: number
): Effect.Effect<void> {
  return state.locked((map) => {
    if (!isSameCell(map, cell) || cell.notificationsSuppressed || !canNotifyInput(job, serial)) {
      return Effect.void
    }

    job.inputNotificationSerial = serial
    return state.ctx.session
      .synthetic({
        [SESSION_ID_KEY]: cell.sessionID,
        text: inputText(job),
        resume: true
      })
      .pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          deliveryFailure('REPL input notification delivery failed', cell, job, error)
        )
      )
  })
}
