/**
 * SDK 7 UAID / broker guard: bounded I/O, timeouts, cache; broker JSON is untrusted.
 */
import { UAIDResolver } from 'agentwallet-sdk'
import { readBrokerResponseWithCap } from './identity-broker-fetch.js'

const TIMEOUT_ENV = 'AGENTPAY_IDENTITY_TIMEOUT_MS'
const CACHE_ENV = 'AGENTPAY_IDENTITY_CACHE_TTL_MS'
const BROKER_ENV = 'AGENTPAY_UAID_BROKER_URL'

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_CACHE_TTL_MS = 120_000
export const MAX_IDENTITY_TIMEOUT_MS = 30_000
export const MAX_IDENTITY_CACHE_TTL_MS = 600_000
const BOUNDED_BROKER = Symbol.for('agentpay.uaid.boundedBroker')

type BrokerRequest = (
  _method: string,
  _path: string,
  _body?: unknown
) => Promise<Response>

function installBoundedBrokerRequest(): void {
  type ResolverHost = {
    brokerRequest: BrokerRequest
    brokerUrl: string
    apiKey?: string
    timeoutMs: number
  }
  const proto = UAIDResolver.prototype as unknown as ResolverHost & Record<symbol, boolean>
  if (proto[BOUNDED_BROKER]) {
    return
  }
  const original = proto.brokerRequest
  proto.brokerRequest = async function boundedBrokerRequest(
    this: ResolverHost,
    method: string,
    path: string,
    body?: unknown
  ) {
    const url = `${this.brokerUrl}${path}`
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'agentwallet-sdk/uaid-resolver',
    }
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`
    }
    if (body) {
      headers['Content-Type'] = 'application/json'
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      if (!response.ok) {
        const text = await readBrokerResponseWithCap(response)
        return new Response(text, { status: response.status, headers: response.headers })
      }
      const text = await readBrokerResponseWithCap(response)
      return new Response(text, {
        status: response.status,
        headers: response.headers,
      })
    } finally {
      clearTimeout(timeout)
    }
  }
  Object.defineProperty(proto, BOUNDED_BROKER, { value: true })
  Object.defineProperty(proto.brokerRequest, 'agentpayOriginal', { value: original })
}

let brokerBounded = false
function ensureBoundedBrokerRequest(): void {
  if (brokerBounded) return
  installBoundedBrokerRequest()
  brokerBounded = true
}

function parseBoundedInt(raw: string | undefined, fallback: number, max: number, label: string): number {
  if (!raw?.trim()) return fallback
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return Math.min(n, max)
}

/** Exposed for tests: effective broker timeout/cache TTL after env ceilings (F29). */
export function identityIoLimitsFromEnv(): { timeoutMs: number; cacheTtlMs: number } {
  return {
    timeoutMs: parseBoundedInt(
      process.env[TIMEOUT_ENV],
      DEFAULT_TIMEOUT_MS,
      MAX_IDENTITY_TIMEOUT_MS,
      TIMEOUT_ENV
    ),
    cacheTtlMs: parseBoundedInt(
      process.env[CACHE_ENV],
      DEFAULT_CACHE_TTL_MS,
      MAX_IDENTITY_CACHE_TTL_MS,
      CACHE_ENV
    ),
  }
}

export function createBoundedUaidResolver(): UAIDResolver {
  ensureBoundedBrokerRequest()
  const { timeoutMs, cacheTtlMs } = identityIoLimitsFromEnv()
  const brokerUrl = process.env[BROKER_ENV]?.trim()
  return new UAIDResolver({
    ...(brokerUrl ? { brokerUrl } : {}),
    timeoutMs,
    cacheTtlMs,
  })
}