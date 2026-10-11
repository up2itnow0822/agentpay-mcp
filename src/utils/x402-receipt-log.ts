/**
 * Process-lifetime x402_pay settlement receipts.
 *
 * createX402Client is constructed per x402_pay call, so the SDK
 * transaction log is discarded when the handler returns. This log keeps
 * the last settled x402 payments so get_transaction_history can show the
 * golden path (tx hash, payee, amount, token, URL) and whether MCP retries
 * replayed that settlement instead of broadcasting again.
 *
 * Same lifetime as spend-intent. Not a durable cross-process ledger.
 * Keyless spend intents may settle again after SEND_TOKEN_INTENT_TTL_MS
 * with the same intent key; each distinct tx hash is its own generation.
 */

export const X402_SETTLEMENT_LOG_MAX = 256

export interface X402SettlementReceipt {
  intentKey: string
  /** URL whose 402 response was paid (final URL after redirects). */
  url: string
  /** Caller-supplied URL, when it differs from `url`. */
  requestedUrl?: string
  /** Paid retry failed, so the redirect target that issued the 402 is unknown. */
  finalUrlUnknown?: boolean
  /** Monotonic order captured when the payment callback ran. */
  seq?: number
  method: string
  amount: string
  token: string
  recipient: string
  txHash: string
  settledAt: number
  replayCount: number
  lastReplayAt?: number
}

const receipts: X402SettlementReceipt[] = []
let seqCounter = 0

/** Call from onPaymentComplete to capture callback order (timestamps are whole seconds). */
export function nextX402SettlementSeq(): number {
  seqCounter += 1
  return seqCounter
}
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
  requestedUrl?: string
  /** Paid retry failed, so the redirect target that issued the 402 is unknown. */
  finalUrlUnknown?: boolean
  /** Monotonic order captured when the payment callback ran. */
  seq?: number
  method: string
  amount: string
  token: string
  recipient: string
  txHash: string
  /** Payment callback time (ms). Defaults to now. */
  settledAt?: number
}): X402SettlementReceipt {
  const existingSameHash = receipts.find(
    (receipt) =>
      receipt.intentKey === entry.intentKey &&
      sameTxHash(receipt.txHash, entry.txHash)
  )
  if (existingSameHash) {
    return existingSameHash
  }

  const { settledAt, ...rest } = entry
  const receipt: X402SettlementReceipt = {
    ...rest,
    settledAt: typeof settledAt === 'number' && Number.isFinite(settledAt) ? settledAt : Date.now(),
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

/** Receipts ordered oldest → newest by payment callback time (stable). */
export function listX402Settlements(): X402SettlementReceipt[] {
  return receipts
    .map((receipt, index) => ({ receipt, index }))
    .sort(
      (a, b) =>
        a.receipt.settledAt - b.receipt.settledAt ||
        (a.receipt.seq ?? Number.MAX_SAFE_INTEGER) - (b.receipt.seq ?? Number.MAX_SAFE_INTEGER) ||
        a.index - b.index
    )
    .map(({ receipt }) => receipt)
}

export function _resetX402SettlementLog(): void {
  receipts.length = 0
  latestByIntent.clear()
}
