import { Buffer } from 'node:buffer'
import path from 'node:path'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES_PER_EVALUATION = 4
const MAX_TOTAL_IMAGE_BYTES = MAX_IMAGE_BYTES * MAX_IMAGES_PER_EVALUATION
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

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

function requiredImageName(value) {
  if (typeof value !== 'string') {
    throw new TypeError('opencode.emitImage filename must be a non-empty string')
  }

  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new TypeError('opencode.emitImage filename must be a non-empty string')
  }

  return trimmed
}

function imageName(value) {
  if (value === undefined) {
    return undefined
  }

  const name = path
    .basename(requiredImageName(value))
    .replaceAll(/[^\w.\x2d]/gv, '_')
    .slice(0, 255)
  if (name.length === 0) {
    throw new TypeError('opencode.emitImage filename must contain a valid filename')
  }

  return name
}

function imageInput(value) {
  if (typeof value !== 'object') {
    throw new TypeError('opencode.emitImage expects { bytes, mimeType, filename? }')
  }

  if (value === null) {
    throw new TypeError('opencode.emitImage expects { bytes, mimeType, filename? }')
  }

  return value
}

function validateImageSize(bytes) {
  if (bytes.byteLength === 0) {
    throw new Error('opencode.emitImage expected non-empty image bytes')
  }

  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`opencode.emitImage image exceeds the ${MAX_IMAGE_BYTES}-byte limit`)
  }
}

function validateImageCount(imageCount) {
  if (imageCount >= MAX_IMAGES_PER_EVALUATION) {
    throw new Error(
      `opencode.emitImage supports at most ${MAX_IMAGES_PER_EVALUATION} images per evaluation`
    )
  }
}

function nextImageBytes(currentBytes, imageCount, bytes) {
  validateImageSize(bytes)
  validateImageCount(imageCount)
  const nextBytes = currentBytes + bytes.byteLength
  if (nextBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error(
      `opencode.emitImage images exceed the ${MAX_TOTAL_IMAGE_BYTES}-byte evaluation limit`
    )
  }

  return nextBytes
}

export function createImageEmitter(emit) {
  let imageCount = 0
  let totalImageBytes = 0

  function reset() {
    imageCount = 0
    totalImageBytes = 0
  }

  function emitImage(jobId, value) {
    const input = imageInput(value)
    const bytes = imageBytes(input.bytes)
    const nextBytes = nextImageBytes(totalImageBytes, imageCount, bytes)
    const mime = imageMimeType(input.mimeType)
    const name = imageName(input.filename)
    imageCount += 1
    totalImageBytes = nextBytes
    emit({
      type: 'image',
      jobId,
      mime,
      data: bytes.toString('base64'),
      ...(name !== undefined && { name })
    })
  }

  return { reset, emit: emitImage }
}
