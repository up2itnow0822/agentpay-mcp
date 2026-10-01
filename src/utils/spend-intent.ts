/**
 * In-process spend-intent cache so an identical send_token retry does not
 * broadcast a second transfer.
 *
 * The key is the settled payload (tool, chain, token address, recipient,
 * raw amount). A matching retry inside the TTL returns the original tx hash
 * and skips both the spend-policy check and the on-chain transfer. Failures
 * are not cached, so a true failed send can be retried.
 *
 * This is process-local, matching SpendingPolicy. It prevents duplicate
 * settlement from MCP tool retries; it is not a durable cross-process ledger.
 */
export const SEND_TOKEN_INTENT_TTL_MS = 5 * 60 * 1000

interface SettledIntent<T> {
  settledAt: number
  value: T
}

const settled = new Map<string, SettledIntent<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

export function sendTokenIntentKey(input: {
  chainId: number
  tokenAddress: string
  recipientAddress: string
  rawAmount: bigint
}): string {
  return [
    'send_token',
    String(input.chainId),
    input.tokenAddress.toLowerCase(),
    input.recipientAddress.toLowerCase(),
    input.rawAmount.toString(),
  ].join(':')
}

export function _resetSpendIntentStore(): void {
  settled.clear()
  inflight.clear()
}

function pruneExpired(now = Date.now()): void {
  for (const [key, entry] of settled) {
    if (now - entry.settledAt > SEND_TOKEN_INTENT_TTL_MS) {
      settled.delete(key)
    }
  }
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
    return { value, replayed: false }
  } finally {
    inflight.delete(key)
  }
}
