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
 * Keyless spend intents may settle again after SEND_TOKEN_INTENT_TTL_MS
 * with the same intent key; each distinct tx hash is its own generation.
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

const receipts: X402SettlementReceipt[] = []
const latestByIntent = new Map<string, X402SettlementReceipt>()

function sameTxHash(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function evictIfNeeded(): void {
  while (receipts.length > X402_SETTLEMENT_LOG_MAX) {
    const evicted = receipts.shift()
    if (!evicted) {
      continue
    }
    if (latestByIntent.get(evicted.intentKey) !== evicted) {
      continue
    }
    latestByIntent.delete(evicted.intentKey)
    for (let i = receipts.length - 1; i >= 0; i--) {
      const candidate = receipts[i]
      if (candidate?.intentKey === evicted.intentKey) {
        latestByIntent.set(evicted.intentKey, candidate)
        break
      }
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
  const existingSameHash = receipts.find(
    (receipt) =>
      receipt.intentKey === entry.intentKey &&
      sameTxHash(receipt.txHash, entry.txHash)
  )
  if (existingSameHash) {
    return existingSameHash
  }

  const receipt: X402SettlementReceipt = {
    ...entry,
    settledAt: Date.now(),
    replayCount: 0,
  }
  receipts.push(receipt)
  latestByIntent.set(entry.intentKey, receipt)
  evictIfNeeded()
  return receipt
}

export function recordX402SettlementReplay(
  intentKey: string
): X402SettlementReceipt | undefined {
  const existing = latestByIntent.get(intentKey)
  if (!existing) {
    return undefined
  }
  existing.replayCount += 1
  existing.lastReplayAt = Date.now()
  return existing
}

export function listX402Settlements(): X402SettlementReceipt[] {
  return receipts.slice()
}

export function _resetX402SettlementLog(): void {
  receipts.length = 0
  latestByIntent.clear()
}
