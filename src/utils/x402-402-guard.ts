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

function jsonDepth(value: unknown, depth = 0): number {
  if (value === null || typeof value !== 'object') return depth
  let max = depth + 1
  if (Array.isArray(value)) {
    for (const item of value) {
      max = Math.max(max, jsonDepth(item, depth + 1))
    }
    return max
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, jsonDepth(v, depth + 1))
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
  try {
    const body = JSON.parse(new TextDecoder('utf-8').decode(bodyBytes))
    if (bodyBytes.byteLength > X402_MAX_402_BODY_BYTES) {
      throw new X402MalformedPaymentRequiredError(
        `x402 response body exceeds ${X402_MAX_402_BODY_BYTES} bytes.`
      )
    }
    assertBoundedX402PaymentRequired(body)
  } catch (error: unknown) {
    if (error instanceof X402MalformedPaymentRequiredError) throw error
    return
  }
}