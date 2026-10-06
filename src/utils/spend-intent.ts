import { z } from 'zod'

/**
 * In-process spend-intent cache so an identical send_token, swap_tokens, or
 * bridge_usdc retry does not broadcast a second settlement.
 *
 * Payment flow: reserve → execute → settle | release | hold-unknown.
 * Spend is counted at policy approve time. Definite not-charged outcomes
 * (quote, validation, confirmed uncharged revert, other pre-broadcast
 * failures) release that reservation and stay retryable. An unclear
 * post-broadcast outcome holds the reservation and locks the intent with
 * no timer — a later identical retry would otherwise double-settle.
 *
 * Keyless retries look up the settled payload (tool + tool-specific fields).
 * An explicit idempotencyKey is the lookup identity for that tool: the same
 * key with the same payload fingerprint replays, and the same key with a
 * different fingerprint fail-closes as a conflict instead of settling twice.
 *
 * A matching retry inside the TTL returns the original result and skips both
 * the spend-policy check and the on-chain transfer.
 *
 * Keyed settled results stay until the durable LRU evicts them so the same
 * idempotencyKey replays after the keyless MCP-retry window. Keyless settled
 * results expire after SEND_TOKEN_INTENT_TTL_MS. Durable and unresolved maps
 * are size-capped so a long-lived process cannot grow them without bound.
 *
 * This is process-local, matching SpendingPolicy. It prevents duplicate
 * settlement from MCP tool retries; it is not a durable cross-process ledger.
 */
export const SEND_TOKEN_INTENT_TTL_MS = 5 * 60 * 1000
export const DEFAULT_SWAP_SLIPPAGE_BPS = 50
export const SPEND_INTENT_MAX_DURABLE = 1024
export const SPEND_INTENT_MAX_UNRESOLVED = 1024

/**
 * Published MCP JSON Schema for optional idempotencyKey on spend tools.
 * Runtime Zod applies the same minLength / maxLength / non-whitespace
 * pattern to the raw string (no trim-before-length). Identity lookup still
 * trims after validation.
 */
export const IDEMPOTENCY_KEY_JSON_SCHEMA = {
  type: 'string' as const,
  minLength: 1,
  maxLength: 128,
  pattern: /.*\S.*/.source,
}

/**
 * Runtime check matching IDEMPOTENCY_KEY_JSON_SCHEMA: length and
 * non-whitespace apply to the raw string. Do not trim before min/max.
 */
export const IdempotencyKeyZodSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/.*\S.*/)

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

const settledEphemeral = new Map<string, SettledIntent<unknown>>()
const settledDurable = new Map<string, SettledIntent<unknown>>()
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

/**
 * Wrap SDK read methods so a failure inside swap()/bridge() is still
 * classified as definite. SwapModule.swap() calls this.getQuote() again;
 * BridgeModule.approveUsdc() re-reads allowance before any write.
 */
export function wrapDefiniteSdkReads<T extends object>(sdk: T): T {
  const record = sdk as Record<string, unknown>
  const quote = record.getQuote
  if (typeof quote === 'function') {
    const original = quote.bind(sdk) as (..._args: unknown[]) => Promise<unknown>
    record.getQuote = (..._args: unknown[]) =>
      runDefinitePreBroadcast(() => original(..._args))
  }
  const allowance = record.getUsdcAllowance
  if (typeof allowance === 'function') {
    const original = allowance.bind(sdk) as (..._args: unknown[]) => Promise<unknown>
    record.getUsdcAllowance = (..._args: unknown[]) =>
      runDefinitePreBroadcast(() => original(..._args))
  }
  const nested = record.swapModule
  if (nested && typeof nested === 'object') {
    wrapDefiniteSdkReads(nested)
  }
  return sdk
}

/**
 * BridgeModule.approveUsdc() inlines an allowance re-read before write.
 * Pre-check via getUsdcAllowance (already wrapped as definite). If allowance
 * is already sufficient, skip the original write path. Otherwise the original
 * re-read still runs; runClassifiedSpend treats a throw before write as
 * definite.
 */
export function classifyBridgeApproveUsdc<T>(bridge: T): T {
  const record = bridge as {
    getUsdcAllowance?: () => Promise<bigint>
    approveUsdc?: (_amount: bigint) => Promise<unknown>
  }
  const original = record.approveUsdc?.bind(record)
  const readAllowance = record.getUsdcAllowance?.bind(record)
  if (typeof original !== 'function' || typeof readAllowance !== 'function') {
    return bridge
  }
  record.approveUsdc = async (amount: bigint) => {
    const current = await runDefinitePreBroadcast(() => readAllowance())
    if (current >= amount) {
      return
    }
    return original(amount)
  }
  return bridge
}

/**
 * Classify a value-moving SDK call. Errors before wallet write stay definite.
 * A confirmed uncharged revert (approve/burn/swap simulation or receipt
 * revert) also stays definite. Once a write is submitted and the outcome is
 * unclear, the error stays generic so the intent locks.
 */
export async function runClassifiedSpend<T>(
  walletClient: { sendTransaction?: unknown; writeContract?: unknown } | null | undefined,
  run: () => Promise<T>
): Promise<T> {
  const state = { broadcastStarted: false }
  const restore = instrumentWalletBroadcast(walletClient, () => {
    state.broadcastStarted = true
  })
  try {
    return await run()
  } catch (error: unknown) {
    if (error instanceof DefiniteSpendFailure) {
      throw error
    }
    if (!state.broadcastStarted || isConfirmedUnchargedRevert(error)) {
      throw new DefiniteSpendFailure(
        error instanceof Error ? error.message : String(error)
      )
    }
    throw error
  } finally {
    restore()
  }
}

function instrumentWalletBroadcast(
  walletClient: { sendTransaction?: unknown; writeContract?: unknown } | null | undefined,
  onWrite: () => void
): () => void {
  if (!walletClient) {
    return () => undefined
  }
  const client = walletClient as {
    sendTransaction?: (..._args: unknown[]) => unknown
    writeContract?: (..._args: unknown[]) => unknown
  }
  const originalSend = client.sendTransaction
  const originalWrite = client.writeContract
  if (typeof originalSend === 'function') {
    client.sendTransaction = (...args: unknown[]) => {
      onWrite()
      return originalSend.apply(client, args)
    }
  }
  if (typeof originalWrite === 'function') {
    client.writeContract = (...args: unknown[]) => {
      onWrite()
      return originalWrite.apply(client, args)
    }
  }
  return () => {
    client.sendTransaction = originalSend
    client.writeContract = originalWrite
  }
}

const POST_VALUE_MOVE =
  /MINT_FAILED|receiveMessage|attestation|ATTESTATION|Circle attestation/i
const UNCHARGED_REVERT =
  /transaction reverted|execution reverted|approve failed \(tx:|depositForBurn transaction reverted/i

/** Receipt-confirmed revert of an approve/burn/swap that did not move funds. */
export function isConfirmedUnchargedRevert(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  if (POST_VALUE_MOVE.test(msg)) {
    return false
  }
  return UNCHARGED_REVERT.test(msg)
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

/** 32-byte 0x-prefixed EVM transaction hash. */
const EVM_TX_HASH = /^0x[a-fA-F0-9]{64}$/

/**
 * Require a complete EVM settlement hash before a spend callback may resolve
 * into the settled cache. A hashless or malformed SDK result is ambiguous —
 * the transfer may already have been broadcast — so this throws a generic
 * Error and the intent stays locked instead of replaying success:true with
 * a non-usable hash such as "pending" or "0x123".
 */
export function requireSettlementHash(hash: unknown, label: string): string {
  if (typeof hash !== 'string' || hash.trim().length === 0) {
    throw new Error(
      `${label} returned without a transaction hash. ` +
        'Refusing to cache a hashless success; reconcile the original transfer before retrying.'
    )
  }
  const normalized = hash.trim()
  if (!EVM_TX_HASH.test(normalized)) {
    throw new Error(
      `${label} returned a malformed transaction hash. ` +
        'Refusing to cache success without a 32-byte 0x-prefixed hash; ' +
        'reconcile the original transfer before retrying.'
    )
  }
  return normalized
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

export function x402PayIntentIdentity(input: {
  url: string
  method: string
  body?: string
  idempotencyKey?: string
}): SpendIntentIdentity {
  const fingerprint = [
    'x402_pay',
    input.method.toUpperCase(),
    input.url,
    input.body ?? '',
  ].join(':')
  return spendIntentIdentity('x402_pay', fingerprint, input.idempotencyKey)
}

export function x402PayIntentKey(input: {
  url: string
  method: string
  body?: string
  idempotencyKey?: string
}): string {
  return x402PayIntentIdentity(input).key
}

export function _resetSpendIntentStore(): void {
  settledEphemeral.clear()
  settledDurable.clear()
  inflight.clear()
  unresolved.clear()
}

export function _spendIntentStoreSizes(): {
  ephemeral: number
  durable: number
  unresolved: number
} {
  return {
    ephemeral: settledEphemeral.size,
    durable: settledDurable.size,
    unresolved: unresolved.size,
  }
}

function remember<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  if (map.has(key)) {
    map.delete(key)
  }
  map.set(key, value)
  while (map.size > max) {
    const oldest = map.keys().next().value
    if (oldest === undefined) {
      break
    }
    map.delete(oldest)
  }
}

function touch<V>(map: Map<string, V>, key: string): V | undefined {
  const value = map.get(key)
  if (value === undefined) {
    return undefined
  }
  map.delete(key)
  map.set(key, value)
  return value
}

function pruneExpired(now = Date.now()): void {
  for (const [key, entry] of settledEphemeral) {
    if (now - entry.settledAt > SEND_TOKEN_INTENT_TTL_MS) {
      settledEphemeral.delete(key)
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

  const existing = touch(settledDurable, key) ?? settledEphemeral.get(key)
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
    const entry: SettledIntent<T> = {
      settledAt: Date.now(),
      value,
      durable: Boolean(options?.durable),
      fingerprint,
    }
    if (entry.durable) {
      remember(settledDurable, key, entry, SPEND_INTENT_MAX_DURABLE)
    } else {
      settledEphemeral.set(key, entry)
    }
    unresolved.delete(key)
    return { value, replayed: false }
  } catch (error: unknown) {
    if (error instanceof DefiniteSpendFailure) {
      throw error
    }
    remember(unresolved, key, { settledAt: Date.now(), fingerprint }, SPEND_INTENT_MAX_UNRESOLVED)
    throw error
  } finally {
    inflight.delete(key)
  }
}
