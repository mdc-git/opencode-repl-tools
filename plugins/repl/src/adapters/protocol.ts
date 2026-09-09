export type JsonRecord = Record<string, unknown>

export type ProtocolError = {
  readonly kind: string
  readonly message: string
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function recordValue(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }

  return value as JsonRecord
}

export function stringValue(record: JsonRecord, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string') {
    throw new TypeError(`${label}.${key} must be a string`)
  }

  return value
}

export function isBooleanValue(record: JsonRecord, key: string, label: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label}.${key} must be a boolean`)
  }

  return value
}

export function optionalStringValue(
  record: JsonRecord,
  key: string,
  label: string
): string | undefined {
  const value = record[key]
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== 'string') {
    throw new TypeError(`${label}.${key} must be a string`)
  }

  return value
}

export function protocolError(value: unknown, label: string): ProtocolError | undefined {
  if (value === undefined) {
    return undefined
  }

  const item = recordValue(value, label)
  return {
    kind: stringValue(item, 'kind', label),
    message: stringValue(item, 'message', label)
  }
}
