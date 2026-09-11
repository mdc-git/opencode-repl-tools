import type { NodeEvent } from '../adapters/node.ts'
import { handleFatal } from './fatal.ts'
import type { RuntimeState } from './state.ts'
import type { Cell } from './types.ts'

function appendNodeImage(
  state: RuntimeState,
  cell: Cell,
  event: Extract<NodeEvent, { type: 'image' }>
): void {
  const job = cell.active
  if (job?.id !== event.jobId) {
    state.dispatch(
      handleFatal(state, cell, `Node REPL emitted image for unexpected job ${event.jobId}`)
    )
    return
  }

  job.images.push({
    mime: event.mime,
    data: event.data,
    ...(event.name !== undefined && { name: event.name })
  })
}

export function onNodeEvent(state: RuntimeState, cell: Cell, event: NodeEvent): void {
  if (event.type === 'output') {
    cell.transcript.append(event.stream, event.text, event.jobId)
    return
  }

  if (event.type === 'image') {
    appendNodeImage(state, cell, event)
    return
  }

  state.dispatch(handleFatal(state, cell, event.message))
}
