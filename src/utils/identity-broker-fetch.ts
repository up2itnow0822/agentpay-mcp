/**
 * Bounded broker transport for UAID resolver HTTP (F18).
 */
import { ResponseTooLargeError } from './safe-fetch.js'

export const IDENTITY_BROKER_MAX_RESPONSE_BYTES = 256 * 1024
/** Wall-clock cap for streaming broker bodies (F18 slow-drip). */
export const IDENTITY_BROKER_READ_TIMEOUT_MS = 30_000

export class BrokerResponseReadTimeoutError extends Error {
  constructor() {
    super('Broker response read timed out.')
    this.name = 'BrokerResponseReadTimeoutError'
  }
}

async function readChunkWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  deadlineMs: number
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  return await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new BrokerResponseReadTimeoutError()), deadlineMs)
    }),
  ])
}

export async function readBrokerResponseWithCap(
  response: Response,
  limit = IDENTITY_BROKER_MAX_RESPONSE_BYTES,
  readTimeoutMs = IDENTITY_BROKER_READ_TIMEOUT_MS
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    const text = await response.text()
    if (text.length > limit) {
      throw new ResponseTooLargeError(limit)
    }
    return text
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const started = Date.now()
  try {
    for (;;) {
      const remaining = readTimeoutMs - (Date.now() - started)
      if (remaining <= 0) {
        throw new BrokerResponseReadTimeoutError()
      }
      const { done, value } = await readChunkWithDeadline(reader, remaining)
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > limit) {
          throw new ResponseTooLargeError(limit)
        }
        chunks.push(value)
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(merged)
}