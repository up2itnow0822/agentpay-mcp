/**
 * Bounds on untrusted HTTP 402 payloads before the SDK parses or pays.
 */
import { decodeX402PaymentHeader } from 'agentwallet-sdk'
import { DefiniteSpendFailure } from './spend-intent.js'

/** Max decoded JSON body bytes for an x402 402 response (F25). */
export const X402_MAX_402_BODY_BYTES = 64 * 1024
/** Max nesting depth for parsed 402 JSON (F25). */
export const X402_MAX_402_JSON_DEPTH = 32
/** Max `accepts[]` entries (F25). */
export const X402_MAX_402_ACCEPTS = 16
/** Max time to stream-read a 402 body before refusal (F25). */
export const X402_READ_BODY_TIMEOUT_MS = 10_000

export class X402MalformedPaymentRequiredError extends DefiniteSpendFailure {
  constructor(message: string) {
    super(message)
    this.name = 'X402MalformedPaymentRequiredError'
  }
}

/** Iterative depth walk — avoids stack overflow on hostile deeply nested 402 JSON (F25). */
function jsonDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth
  let max = depth + 1
  const stack: Array<{ node: unknown; at: number }> = []
  const pushChildren = (node: object, at: number) => {
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, at: at + 1 })
      return
    }
    for (const child of Object.values(node as Record<string, unknown>)) {
      stack.push({ node: child, at: at + 1 })
    }
  }
  pushChildren(value, depth)
  while (stack.length > 0) {
    const { node, at } = stack.pop()!
    if (node === null || typeof node !== 'object') {
      max = Math.max(max, at)
      continue
    }
    max = Math.max(max, at + 1)
    pushChildren(node, at)
  }
  return max
}

/** Validate a parsed x402 PaymentRequired object before payment selection. */
export function assertBoundedX402PaymentRequired(value: unknown): void {
  if (!value || typeof value !== 'object') {
    throw new X402MalformedPaymentRequiredError('x402 payment-required payload is not an object.')
  }
  const candidate = value as { accepts?: unknown }
  const depth = jsonDepth(value, 0)
  if (depth > X402_MAX_402_JSON_DEPTH) {
    throw new X402MalformedPaymentRequiredError(
      `x402 payment-required JSON exceeds depth limit (${X402_MAX_402_JSON_DEPTH}).`
    )
  }
  if (!Array.isArray(candidate.accepts)) {
    throw new X402MalformedPaymentRequiredError('x402 payment-required has no accepts array.')
  }
  if (candidate.accepts.length > X402_MAX_402_ACCEPTS) {
    throw new X402MalformedPaymentRequiredError(
      `x402 payment-required offers too many accepts (max ${X402_MAX_402_ACCEPTS}).`
    )
  }
}

function read402ChunkWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeout: AbortSignal
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  if (timeout.aborted) {
    return Promise.reject(new X402MalformedPaymentRequiredError('x402 response body read timed out.'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new X402MalformedPaymentRequiredError('x402 response body read timed out.'))
    }
    timeout.addEventListener('abort', onAbort, { once: true })
    reader
      .read()
      .then((result) => {
        timeout.removeEventListener('abort', onAbort)
        resolve(result)
      })
      .catch((err) => {
        timeout.removeEventListener('abort', onAbort)
        reject(err)
      })
  })
}

async function readBounded402BodyBytes(response: Response): Promise<Uint8Array> {
  const clone = response.clone()
  const stream = clone.body
  if (!stream) return new Uint8Array(0)
  const timeout = AbortSignal.timeout(X402_READ_BODY_TIMEOUT_MS)
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await read402ChunkWithDeadline(reader, timeout)
      if (done) break
      total += value.byteLength
      if (total > X402_MAX_402_BODY_BYTES) {
        throw new X402MalformedPaymentRequiredError(
          `x402 response body exceeds ${X402_MAX_402_BODY_BYTES} bytes.`
        )
      }
      parts.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* already released */
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

/** Read a 402 JSON body with streamed byte cap (uses a cloned response). */
export async function readBounded402JsonBody(response: Response): Promise<unknown> {
  const buf = await readBounded402BodyBytes(response)
  if (buf.byteLength === 0) {
    throw new X402MalformedPaymentRequiredError('x402 response body is empty.')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  try {
    return JSON.parse(text)
  } catch {
    throw new X402MalformedPaymentRequiredError('x402 response body is not valid JSON.')
  }
}

/** PAYMENT-REQUIRED header is also capped at 64 KiB by the SDK; enforce explicitly. */
export function assertBounded402Header(headerValue: string | null): void {
  if (!headerValue) return
  if (headerValue.length > X402_MAX_402_BODY_BYTES) {
    throw new X402MalformedPaymentRequiredError(
      `x402 PAYMENT-REQUIRED header exceeds ${X402_MAX_402_BODY_BYTES} bytes.`
    )
  }
}

/** Normalize x402 URLs for binding (scheme/host case, default port, trailing slash, sorted query). */
export function normalizeX402ComparableUrl(raw: string, base?: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw, base)
  } catch {
    throw new X402MalformedPaymentRequiredError('x402 URL binding check failed: invalid URL.')
  }
  parsed.hash = ''
  parsed.protocol = parsed.protocol.toLowerCase()
  parsed.hostname = parsed.hostname.toLowerCase()
  if (
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    parsed.port === ''
  ) {
    parsed.port = ''
  }
  let path = parsed.pathname
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1)
  }
  const sorted = new URLSearchParams()
  for (const key of [...parsed.searchParams.keys()].sort()) {
    for (const value of parsed.searchParams.getAll(key)) {
      sorted.append(key, value)
    }
  }
  const query = sorted.toString()
  return `${parsed.protocol}//${parsed.host}${path}${query ? `?${query}` : ''}`
}

/**
 * Paid retry must target the same origin, pathname, and query as the probe (F23).
 */
function normalizedOrigin(url: string, base?: string): string {
  const parsed = new URL(url, base)
  parsed.protocol = parsed.protocol.toLowerCase()
  parsed.hostname = parsed.hostname.toLowerCase()
  if (
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    parsed.port === ''
  ) {
    parsed.port = ''
  }
  return parsed.origin
}

export function assertX402FollowUpUrlMatches(requestUrl: string, responseUrl: string): void {
  const requested = normalizeX402ComparableUrl(requestUrl)
  const responded = normalizeX402ComparableUrl(responseUrl, requestUrl)
  if (requested === responded) {
    return
  }
  if (normalizedOrigin(requestUrl) !== normalizedOrigin(responseUrl, requestUrl)) {
    throw new X402MalformedPaymentRequiredError(
      'x402 follow-up origin does not match the original request; refusing auto-pay.'
    )
  }
  if (requested.split('?')[0] !== responded.split('?')[0]) {
    throw new X402MalformedPaymentRequiredError(
      'x402 follow-up path does not match the original request; refusing auto-pay.'
    )
  }
  throw new X402MalformedPaymentRequiredError(
    'x402 follow-up query does not match the original request; refusing auto-pay.'
  )
}

/** Run F23 + F25 checks on an already-received 402 probe. */
function assertX402ResourceUrlMatches(requestUrl: string, payload: unknown): void {
  if (!payload || typeof payload !== 'object') return
  const resourceUrl = (payload as { resource?: { url?: unknown } }).resource?.url
  if (typeof resourceUrl !== 'string' || resourceUrl.length === 0) return
  assertX402FollowUpUrlMatches(requestUrl, resourceUrl)
}

export async function guardX402ProbeResponse(requestUrl: string, probe: Response): Promise<void> {
  const header =
    probe.headers.get('payment-required') ?? probe.headers.get('x-payment-required')
  assertBounded402Header(header)
  if (probe.url && probe.url.length > 0) {
    assertX402FollowUpUrlMatches(requestUrl, probe.url)
  }
  if (header) {
    try {
      const decoded = decodeX402PaymentHeader(header)
      assertBoundedX402PaymentRequired(decoded)
      assertX402ResourceUrlMatches(requestUrl, decoded)
    } catch (error: unknown) {
      if (error instanceof X402MalformedPaymentRequiredError) throw error
      throw new X402MalformedPaymentRequiredError('x402 PAYMENT-REQUIRED header is not valid.')
    }
    return
  }
  const bodyBytes = await readBounded402BodyBytes(probe)
  if (bodyBytes.byteLength === 0) {
    return
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new X402MalformedPaymentRequiredError('x402 response body is not valid JSON.')
  }
  assertBoundedX402PaymentRequired(body)
  assertX402ResourceUrlMatches(requestUrl, body)
}