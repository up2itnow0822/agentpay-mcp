/**
 * In-process spend-intent cache so an identical send_token, swap_tokens, or
 * bridge_usdc retry does not broadcast a second settlement.
 *
 * Keyless retries look up the settled payload (tool + tool-specific fields).
 * An explicit idempotencyKey is the lookup identity for that tool: the same
 * key with the same payload fingerprint replays, and the same key with a
 * different fingerprint fail-closes as a conflict instead of settling twice.
 *
 * A matching retry inside the TTL returns the original result and skips both
 * the spend-policy check and the on-chain transfer.
 *
 * Failures that happen before broadcast (policy reject / draft, SDK quote
 * fetch, SDK allowance read) are definite and may be retried. Any other
 * rejection is treated as an unresolved broadcast: the next identical call
 * fail-closes instead of sending again. Unresolved locks do not expire on a
 * timer — a later identical retry would otherwise double-settle after an
 * ambiguous burn, swap, or transfer.
 *
 * Keyed settled results stay for the process lifetime so the same
 * idempotencyKey replays after the keyless MCP-retry window. Keyless settled
 * results expire after SEND_TOKEN_INTENT_TTL_MS.
 *
 * This is process-local, matching SpendingPolicy. It prevents duplicate
 * settlement from MCP tool retries; it is not a durable cross-process ledger.
 */
export const SEND_TOKEN_INTENT_TTL_MS = 5 * 60 * 1000
export const DEFAULT_SWAP_SLIPPAGE_BPS = 50

export interface SpendIntentIdentity {
  key: string
  fingerprint: string
}

interface SettledIntent<T> {
  settledAt: number
  value: T
  durable: boolean
  fingerprint: string
}

interface UnresolvedIntent {
  settledAt: number
  fingerprint: string
}

interface InflightIntent {
  promise: Promise<unknown>
  fingerprint: string
}

const settled = new Map<string, SettledIntent<unknown>>()
const inflight = new Map<string, InflightIntent>()
const unresolved = new Map<string, UnresolvedIntent>()

/** Policy/validation rejected the send before any transfer was broadcast. */
export class DefiniteSpendFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DefiniteSpendFailure'
  }
}

/**
 * Run a pre-broadcast SDK phase (quote fetch, allowance read). Failures here
 * cannot have settled, so they stay retryable instead of locking the intent.
 */
export async function runDefinitePreBroadcast<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    if (error instanceof DefiniteSpendFailure) {
      throw error
    }
    throw new DefiniteSpendFailure(
      error instanceof Error ? error.message : String(error)
    )
  }
}

/** A prior attempt for this intent may already have broadcast a transfer. */
export class UnresolvedSpendIntentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnresolvedSpendIntentError'
  }
}

/** The same idempotency key was reused with a different spend payload. */
export class SpendIntentConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpendIntentConflictError'
  }
}

function spendIntentIdentity(
  tool: string,
  fingerprint: string,
  idempotencyKey?: string
): SpendIntentIdentity {
  const explicit = idempotencyKey?.trim()
  return {
    key: explicit ? `${tool}#${explicit}` : fingerprint,
    fingerprint,
  }
}

export function sendTokenIntentIdentity(input: {
  chainId: number
  tokenAddress: string
  recipientAddress: string
  rawAmount: bigint
  idempotencyKey?: string
}): SpendIntentIdentity {
  const fingerprint = [
    'send_token',
    String(input.chainId),
    input.tokenAddress.toLowerCase(),
    input.recipientAddress.toLowerCase(),
    input.rawAmount.toString(),
  ].join(':')
  return spendIntentIdentity('send_token', fingerprint, input.idempotencyKey)
}

export function sendTokenIntentKey(input: {
  chainId: number
  tokenAddress: string
  recipientAddress: string
  rawAmount: bigint
  idempotencyKey?: string
}): string {
  return sendTokenIntentIdentity(input).key
}

export function swapTokensIntentIdentity(input: {
  chainId: number
  fromTokenAddress: string
  toTokenAddress: string
  rawAmountIn: bigint
  slippageBps?: number
  idempotencyKey?: string
}): SpendIntentIdentity {
  const fingerprint = [
    'swap_tokens',
    String(input.chainId),
    input.fromTokenAddress.toLowerCase(),
    input.toTokenAddress.toLowerCase(),
    input.rawAmountIn.toString(),
    String(input.slippageBps ?? DEFAULT_SWAP_SLIPPAGE_BPS),
  ].join(':')
  return spendIntentIdentity('swap_tokens', fingerprint, input.idempotencyKey)
}

export function swapTokensIntentKey(input: {
  chainId: number
  fromTokenAddress: string
  toTokenAddress: string
  rawAmountIn: bigint
  slippageBps?: number
  idempotencyKey?: string
}): string {
  return swapTokensIntentIdentity(input).key
}

export function bridgeUsdcIntentIdentity(input: {
  fromChain: string
  toChain: string
  rawAmount: bigint
  idempotencyKey?: string
}): SpendIntentIdentity {
  const fingerprint = [
    'bridge_usdc',
    input.fromChain.toLowerCase(),
    input.toChain.toLowerCase(),
    input.rawAmount.toString(),
  ].join(':')
  return spendIntentIdentity('bridge_usdc', fingerprint, input.idempotencyKey)
}

export function bridgeUsdcIntentKey(input: {
  fromChain: string
  toChain: string
  rawAmount: bigint
  idempotencyKey?: string
}): string {
  return bridgeUsdcIntentIdentity(input).key
}

export function _resetSpendIntentStore(): void {
  settled.clear()
  inflight.clear()
  unresolved.clear()
}

function pruneExpired(now = Date.now()): void {
  for (const [key, entry] of settled) {
    if (!entry.durable && now - entry.settledAt > SEND_TOKEN_INTENT_TTL_MS) {
      settled.delete(key)
    }
  }
}

function unresolvedMessage(): string {
  return (
    'A previous attempt for this spend intent did not return a transaction hash. ' +
    'Refusing to broadcast again until the original transfer is reconciled.'
  )
}

function conflictMessage(): string {
  return (
    'This idempotency key was already used with a different spend payload. ' +
    'Refusing to broadcast a second settlement.'
  )
}

function assertFingerprint(stored: string, incoming: string): void {
  if (stored !== incoming) {
    throw new SpendIntentConflictError(conflictMessage())
  }
}

export async function withSpendIntent<T>(
  key: string,
  run: () => Promise<T>,
  options?: { durable?: boolean; fingerprint?: string }
): Promise<{ value: T; replayed: boolean }> {
  pruneExpired()
  const fingerprint = options?.fingerprint ?? key

  const existing = settled.get(key)
  if (existing) {
    assertFingerprint(existing.fingerprint, fingerprint)
    return { value: existing.value as T, replayed: true }
  }

  const locked = unresolved.get(key)
  if (locked) {
    assertFingerprint(locked.fingerprint, fingerprint)
    throw new UnresolvedSpendIntentError(unresolvedMessage())
  }

  const running = inflight.get(key)
  if (running) {
    assertFingerprint(running.fingerprint, fingerprint)
    const value = (await running.promise) as T
    return { value, replayed: true }
  }

  const promise = run()
  inflight.set(key, { promise, fingerprint })
  try {
    const value = await promise
    settled.set(key, {
      settledAt: Date.now(),
      value,
      durable: Boolean(options?.durable),
      fingerprint,
    })
    unresolved.delete(key)
    return { value, replayed: false }
  } catch (error: unknown) {
    if (error instanceof DefiniteSpendFailure) {
      throw error
    }
    unresolved.set(key, { settledAt: Date.now(), fingerprint })
    throw error
  } finally {
    inflight.delete(key)
  }
}
