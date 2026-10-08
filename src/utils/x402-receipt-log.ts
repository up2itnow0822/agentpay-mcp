/**
 * Process-lifetime x402_pay settlement receipts.
 *
 * createX402Client is constructed per x402_pay call, so the SDK
 * transaction log is discarded when the handler returns. This log keeps
 * the last settled x402 payments so get_transaction_history can show the
 * golden path (tx hash, payee, amount, URL) and whether MCP retries
 * replayed that settlement instead of broadcasting again.
 *
 * Same lifetime as spend-intent. Not a durable cross-process ledger.
 */

export const X402_SETTLEMENT_LOG_MAX = 256

export interface X402SettlementReceipt {
  intentKey: string
  url: string
  method: string
  amount: string
  recipient: string
  txHash: string
  settledAt: number
  replayCount: number
  lastReplayAt?: number
}

const byKey = new Map<string, X402SettlementReceipt>()
const order: string[] = []

function evictIfNeeded(): void {
  while (order.length > X402_SETTLEMENT_LOG_MAX) {
    const evicted = order.shift()
    if (evicted) {
      byKey.delete(evicted)
    }
  }
}

export function recordX402Settlement(entry: {
  intentKey: string
  url: string
  method: string
  amount: string
  recipient: string
  txHash: string
}): X402SettlementReceipt {
  const existing = byKey.get(entry.intentKey)
  if (existing) {
    return existing
  }
  const receipt: X402SettlementReceipt = {
    ...entry,
    settledAt: Date.now(),
    replayCount: 0,
  }
  byKey.set(entry.intentKey, receipt)
  order.push(entry.intentKey)
  evictIfNeeded()
  return receipt
}

export function recordX402SettlementReplay(
  intentKey: string
): X402SettlementReceipt | undefined {
  const existing = byKey.get(intentKey)
  if (!existing) {
    return undefined
  }
  existing.replayCount += 1
  existing.lastReplayAt = Date.now()
  return existing
}

export function listX402Settlements(): X402SettlementReceipt[] {
  return order
    .map((key) => byKey.get(key))
    .filter((entry): entry is X402SettlementReceipt => entry !== undefined)
}

export function _resetX402SettlementLog(): void {
  byKey.clear()
  order.length = 0
}
