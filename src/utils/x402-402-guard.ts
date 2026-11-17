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

/** Read a 402 JSON body with a byte cap (uses a cloned response). */
export async function readBounded402JsonBody(response: Response): Promise<unknown> {
  const clone = response.clone()
  const buf = await clone.arrayBuffer()
  if (buf.byteLength > X402_MAX_402_BODY_BYTES) {
    throw new X402MalformedPaymentRequiredError(
      `x402 response body exceeds ${X402_MAX_402_BODY_BYTES} bytes.`
    )
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

/**
 * Paid retry must target the same origin, pathname, and query as the probe (F23).
 */
export function assertX402FollowUpUrlMatches(requestUrl: string, responseUrl: string): void {
  let requested: URL
  let responded: URL
  try {
    requested = new URL(requestUrl)
    responded = new URL(responseUrl)
  } catch {
    throw new X402MalformedPaymentRequiredError('x402 URL binding check failed: invalid URL.')
  }
  requested.hash = ''
  responded.hash = ''
  if (requested.origin !== responded.origin) {
    throw new X402MalformedPaymentRequiredError(
      'x402 follow-up origin does not match the original request; refusing auto-pay.'
    )
  }
  if (requested.pathname !== responded.pathname) {
    throw new X402MalformedPaymentRequiredError(
      'x402 follow-up path does not match the original request; refusing auto-pay.'
    )
  }
  if (requested.search !== responded.search) {
    throw new X402MalformedPaymentRequiredError(
      'x402 follow-up query does not match the original request; refusing auto-pay.'
    )
  }
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
  const bodyBytes = await probe.clone().arrayBuffer()
  if (bodyBytes.byteLength === 0) {
    return
  }
  if (bodyBytes.byteLength > X402_MAX_402_BODY_BYTES) {
    throw new X402MalformedPaymentRequiredError(
      `x402 response body exceeds ${X402_MAX_402_BODY_BYTES} bytes.`
    )
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