/**
 * In-process spend-intent cache so an identical send_token retry does not
 * broadcast a second transfer.
 *
 * The key is the settled payload (tool, chain, token address, recipient,
 * raw amount) plus an optional caller-supplied idempotency key. A matching
 * retry inside the TTL returns the original tx hash and skips both the
 * spend-policy check and the on-chain transfer.
 *
 * Failures that happen before broadcast (policy reject / draft) are definite
 * and may be retried. Any other rejection is treated as an unresolved
 * broadcast: the next identical call fail-closes instead of sending again.
 *
 * This is process-local, matching SpendingPolicy. It prevents duplicate
 * settlement from MCP tool retries; it is not a durable cross-process ledger.
 */
export const SEND_TOKEN_INTENT_TTL_MS = 5 * 60 * 1000

interface SettledIntent<T> {
  settledAt: number
  value: T
}

interface UnresolvedIntent {
  settledAt: number
}

const settled = new Map<string, SettledIntent<unknown>>()
const inflight = new Map<string, Promise<unknown>>()
const unresolved = new Map<string, UnresolvedIntent>()

/** Policy/validation rejected the send before any transfer was broadcast. */
export class DefiniteSpendFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DefiniteSpendFailure'
  }
}

/** A prior attempt for this intent may already have broadcast a transfer. */
export class UnresolvedSpendIntentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnresolvedSpendIntentError'
  }
}

export function sendTokenIntentKey(input: {
  chainId: number
  tokenAddress: string
  recipientAddress: string
  rawAmount: bigint
  idempotencyKey?: string
}): string {
  const payload = [
    'send_token',
    String(input.chainId),
    input.tokenAddress.toLowerCase(),
    input.recipientAddress.toLowerCase(),
    input.rawAmount.toString(),
  ].join(':')
  const explicit = input.idempotencyKey?.trim()
  return explicit ? `${payload}#${explicit}` : payload
}

export function _resetSpendIntentStore(): void {
  settled.clear()
  inflight.clear()
  unresolved.clear()
}

function pruneExpired(now = Date.now()): void {
  for (const [key, entry] of settled) {
    if (now - entry.settledAt > SEND_TOKEN_INTENT_TTL_MS) {
      settled.delete(key)
    }
  }
  for (const [key, entry] of unresolved) {
    if (now - entry.settledAt > SEND_TOKEN_INTENT_TTL_MS) {
      unresolved.delete(key)
    }
  }
}

function unresolvedMessage(): string {
  return (
    'A previous send_token for this intent did not return a transaction hash. ' +
    'Refusing to broadcast again until the original transfer is reconciled or the 5-minute intent TTL expires.'
  )
}

export async function withSpendIntent<T>(
  key: string,
  run: () => Promise<T>
): Promise<{ value: T; replayed: boolean }> {
  pruneExpired()

  const existing = settled.get(key)
  if (existing) {
    return { value: existing.value as T, replayed: true }
  }

  if (unresolved.has(key)) {
    throw new UnresolvedSpendIntentError(unresolvedMessage())
  }

  const running = inflight.get(key)
  if (running) {
    const value = (await running) as T
    return { value, replayed: true }
  }

  const promise = run()
  inflight.set(key, promise)
  try {
    const value = await promise
    settled.set(key, { settledAt: Date.now(), value })
    unresolved.delete(key)
    return { value, replayed: false }
  } catch (error: unknown) {
    if (error instanceof DefiniteSpendFailure) {
      throw error
    }
    unresolved.set(key, { settledAt: Date.now() })
    throw error
  } finally {
    inflight.delete(key)
  }
}
