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
/** Max resource/request URL length before comparable-URL normalize (B2). */
export const X402_MAX_COMPARABLE_URL_LENGTH = 8 * 1024
/** Max query-parameter entries (including duplicate keys) before normalize (B2). */
export const X402_MAX_QUERY_PARAMETER_COUNT = 256

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

function assertComparableUrlLength(raw: string): void {
  if (raw.length > X402_MAX_COMPARABLE_URL_LENGTH) {
    throw new X402MalformedPaymentRequiredError(
      `x402 URL exceeds ${X402_MAX_COMPARABLE_URL_LENGTH} bytes.`
    )
  }
}

/** Normalize x402 URLs for binding (scheme/host case, default port, trailing slash, sorted query). */
export function normalizeX402ComparableUrl(raw: string, base?: string): string {
  assertComparableUrlLength(raw)
  if (typeof base === 'string') assertComparableUrlLength(base)
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
  const entries = [...parsed.searchParams]
  if (entries.length > X402_MAX_QUERY_PARAMETER_COUNT) {
    throw new X402MalformedPaymentRequiredError(
      `x402 URL has too many query parameters (max ${X402_MAX_QUERY_PARAMETER_COUNT}).`
    )
  }
  const sorted = entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const query = new URLSearchParams(sorted).toString()
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

/**
 * Same validity test the SDK's parse402Response uses before trusting a
 * PAYMENT-REQUIRED header. A decoy that fails this must never skip the body.
 */
function isValidX402PaymentRequired(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const candidate = value as {
    x402Version?: unknown
    resource?: { url?: unknown }
    accepts?: unknown
  }
  if (candidate.x402Version !== 1) return false
  if (!candidate.resource || typeof candidate.resource.url !== 'string') return false
  if (!Array.isArray(candidate.accepts) || candidate.accepts.length === 0) return false
  return candidate.accepts.every(
    (req) =>
      !!req &&
      typeof req === 'object' &&
      typeof (req as { scheme?: unknown }).scheme === 'string' &&
      typeof (req as { network?: unknown }).network === 'string' &&
      typeof (req as { asset?: unknown }).asset === 'string' &&
      typeof (req as { amount?: unknown }).amount === 'string' &&
      /^\d+$/.test((req as { amount: string }).amount) &&
      typeof (req as { payTo?: unknown }).payTo === 'string' &&
      typeof (req as { maxTimeoutSeconds?: unknown }).maxTimeoutSeconds === 'number' &&
      (req as { maxTimeoutSeconds: number }).maxTimeoutSeconds > 0 &&
      (req as { maxTimeoutSeconds: number }).maxTimeoutSeconds <= 300
  )
}

/** Hand the SDK a clone of only the bytes we already bounded and validated. */
function pinValidated402Body(probe: Response, bodyBytes: Uint8Array): void {
  const headers = new Headers(probe.headers)
  const status = probe.status
  const statusText = probe.statusText
  const rebuilt = () => new Response(bodyBytes, { status, statusText, headers })
  try {
    Object.defineProperty(probe, 'clone', {
      configurable: true,
      value: () => rebuilt(),
    })
  } catch {
    /* Response.clone may be non-configurable; body was still validated */
  }
}

export async function guardX402ProbeResponse(requestUrl: string, probe: Response): Promise<void> {
  const header =
    probe.headers.get('payment-required') ?? probe.headers.get('x-payment-required')
  assertBounded402Header(header)
  if (probe.url && probe.url.length > 0) {
    assertX402FollowUpUrlMatches(requestUrl, probe.url)
  }
  if (header) {
    let decoded: unknown
    let decodedOk = false
    try {
      decoded = decodeX402PaymentHeader(header)
      decodedOk = true
    } catch {
      decodedOk = false
    }
    if (decodedOk && isValidX402PaymentRequired(decoded)) {
      try {
        assertBoundedX402PaymentRequired(decoded)
        assertX402ResourceUrlMatches(requestUrl, decoded)
      } catch (error: unknown) {
        if (error instanceof X402MalformedPaymentRequiredError) throw error
        throw new X402MalformedPaymentRequiredError('x402 PAYMENT-REQUIRED header is not valid.')
      }
      return
    }
  }
  const bodyBytes = await readBounded402BodyBytes(probe)
  if (bodyBytes.byteLength === 0) {
    if (header) {
      throw new X402MalformedPaymentRequiredError('x402 PAYMENT-REQUIRED header is not valid.')
    }
    return
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes)
  } catch {
    throw new X402MalformedPaymentRequiredError('x402 response body is not valid UTF-8.')
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new X402MalformedPaymentRequiredError('x402 response body is not valid JSON.')
  }
  assertBoundedX402PaymentRequired(body)
  assertX402ResourceUrlMatches(requestUrl, body)
  pinValidated402Body(probe, bodyBytes)
}