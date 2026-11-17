/**
 * Bounded broker transport for UAID resolver HTTP (F18).
 */
import { ResponseTooLargeError } from './safe-fetch.js'

export const IDENTITY_BROKER_MAX_RESPONSE_BYTES = 256 * 1024

export async function readBrokerResponseWithCap(response: Response, limit = IDENTITY_BROKER_MAX_RESPONSE_BYTES): Promise<string> {
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
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > limit) {
        throw new ResponseTooLargeError(limit)
      }
      chunks.push(value)
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