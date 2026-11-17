/**
 * SDK 7 UAID / broker guard: bounded I/O, timeouts, cache; broker JSON is untrusted.
 */
import { UAIDResolver } from 'agentwallet-sdk'

const TIMEOUT_ENV = 'AGENTPAY_IDENTITY_TIMEOUT_MS'
const CACHE_ENV = 'AGENTPAY_IDENTITY_CACHE_TTL_MS'
const BROKER_ENV = 'AGENTPAY_UAID_BROKER_URL'

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_CACHE_TTL_MS = 120_000
const MAX_TIMEOUT_MS = 30_000
const MAX_CACHE_TTL_MS = 600_000

function parseBoundedInt(raw: string | undefined, fallback: number, max: number, label: string): number {
  if (!raw?.trim()) return fallback
  const n = Number(raw.trim())
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return Math.min(n, max)
}

export function createBoundedUaidResolver(): UAIDResolver {
  const timeoutMs = parseBoundedInt(process.env[TIMEOUT_ENV], DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, TIMEOUT_ENV)
  const cacheTtlMs = parseBoundedInt(process.env[CACHE_ENV], DEFAULT_CACHE_TTL_MS, MAX_CACHE_TTL_MS, CACHE_ENV)
  const brokerUrl = process.env[BROKER_ENV]?.trim()
  return new UAIDResolver({
    ...(brokerUrl ? { brokerUrl } : {}),
    timeoutMs,
    cacheTtlMs,
  })
}