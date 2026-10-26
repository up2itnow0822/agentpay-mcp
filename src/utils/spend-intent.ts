import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { classifySpendError, isEvmTxHash } from 'agentwallet-sdk'
import { z } from 'zod'
import { normalizeHost } from './net-guard.js'

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
 * the spend-policy check and the on-chain transfer. x402_pay settles only
 * after a payment; an uncharged HTTP response is released and stays retryable.
 *
 * Keyed settled results stay until the durable LRU evicts them so the same
 * idempotencyKey replays after the keyless MCP-retry window; an evicted key
 * leaves a tombstone so it is refused, never re-executed. Tombstones are
 * NEVER evicted (they are compact digests); at SPEND_INTENT_MAX_TOMBSTONES
 * durable identities, new keyed spends are refused instead (fail closed).
 * Keyless settled results expire after SEND_TOKEN_INTENT_TTL_MS.
 *
 * Unresolved (possibly-broadcast) intents are NEVER evicted. When
 * SPEND_INTENT_MAX_UNRESOLVED of them are outstanding, new value movement is
 * refused (fail closed) until an operator reconciles them — capacity pressure
 * can never re-enable a settlement that may already have happened.
 *
 * By default this state is process-local. Set AGENTPAY_STATE_DIR to journal
 * every intent (begin / settle / lock / release) to an append-only file that
 * is replayed at startup: an intent that began but never reached a terminal
 * record — including one interrupted by a crash mid-broadcast — comes back
 * locked, and keyed settlements come back as tombstones. Operators reconcile
 * with `agentpay-mcp spend-intents list|resolve`.
 */
export const SEND_TOKEN_INTENT_TTL_MS = 5 * 60 * 1000
export const DEFAULT_SWAP_SLIPPAGE_BPS = 50
export const SPEND_INTENT_MAX_DURABLE = 1024
export const SPEND_INTENT_MAX_UNRESOLVED = 1024
/**
 * Ceiling on durable (idempotency-keyed) identities. Settled keys are
 * remembered forever as compact digests so reuse is refused; at this many,
 * NEW keyed spends are refused (fail closed) — capacity never evicts one.
 */
export const SPEND_INTENT_MAX_TOMBSTONES = 1_048_576
export const STATE_DIR_ENV = 'AGENTPAY_STATE_DIR'
export const SPEND_JOURNAL_FILE = 'spend-intents.jsonl'
/**
 * The journal is compacted (crash-safely) once it exceeds this size and twice
 * its last compacted size, so terminal histories never accumulate.
 */
export const SPEND_JOURNAL_COMPACT_BYTES = 1024 * 1024

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
  /**
   * Payment-lock keys (x402 host and payee) this intent blocks while it is
   * unresolved. Recorded on the intent's `begin` journal record, so the lock
   * cannot be lost to a crash or a torn record written after it.
   */
  scope?: readonly string[]
}

interface InflightIntent {
  promise: Promise<unknown>
  fingerprint: string
  startedAt: number
  scope?: readonly string[]
}

const settledEphemeral = new Map<string, SettledIntent<unknown>>()
const settledDurable = new Map<string, SettledIntent<unknown>>()
const inflight = new Map<string, InflightIntent>()
const unresolved = new Map<string, UnresolvedIntent>()
/**
 * Durable keys whose cached value was evicted (or predates a restart):
 * digest(key) -> digest(fingerprint). Never evicted.
 */
const tombstones = new Map<string, string>()
let durableIdentityCeiling = SPEND_INTENT_MAX_TOMBSTONES

/** 128-bit digest: tombstones stay small without ever being evicted. */
function identityDigest(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 22)
}

/** Test seam: lower the durable-identity ceiling (undefined restores it). */
export function _setDurableIdentityCeilingForTests(limit?: number): void {
  durableIdentityCeiling = limit ?? SPEND_INTENT_MAX_TOMBSTONES
}


/** Policy/validation rejected the send before any transfer was broadcast. */
export class DefiniteSpendFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DefiniteSpendFailure'
  }
}

/**
 * Payment already settled, but the follow-up HTTP response failed.
 * The intent must lock; the caller must not resubmit.
 */
export class PostSettlementSpendError extends Error {
  readonly txHash: string
  readonly amount: string
  readonly recipient: string
  readonly cause: unknown

  constructor(input: {
    txHash: string
    amount: bigint | string
    recipient: string
    cause?: unknown
  }) {
    const amount =
      typeof input.amount === 'bigint' ? input.amount.toString() : input.amount
    super(
      'x402 payment already settled; do not resubmit. ' +
        `txHash=${input.txHash} amount=${amount} recipient=${input.recipient}`
    )
    this.name = 'PostSettlementSpendError'
    this.txHash = input.txHash
    this.amount = amount
    this.recipient = input.recipient
    this.cause = input.cause
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
 *
 * Taxonomy comes from agentwallet-sdk `classifySpendError`. Wallet-write
 * instrumentation remains the fail-closed broadcast detector: the SDK
 * classifier treats unknown errors as released (pre-broadcast), which is
 * wrong after sendTransaction/writeContract has run.
 *
 * x402 sends the protocol fee before the merchant transfer. Pass
 * `lockAfterBroadcast: true` so a later revert cannot release the intent
 * and allow a second fee.
 */
export async function runClassifiedSpend<T>(
  walletClient: { sendTransaction?: unknown; writeContract?: unknown } | null | undefined,
  run: () => Promise<T>,
  options?: { lockAfterBroadcast?: boolean }
): Promise<T> {
  installBroadcastHook(walletClient)
  const state: BroadcastState = { broadcastStarted: false }
  try {
    // The hook reports writes to the store of the async context that made
    // them, so concurrent spends on the shared singleton client each see only
    // their own broadcasts. Nothing is swapped in or restored per call.
    return await broadcastContext.run(state, run)
  } catch (error: unknown) {
    if (error instanceof DefiniteSpendFailure) {
      throw error
    }
    const outcome = classifySpendError(error)
    if (!state.broadcastStarted) {
      throw new DefiniteSpendFailure(
        error instanceof Error ? error.message : String(error)
      )
    }
    if (options?.lockAfterBroadcast) {
      throw error
    }
    if (
      outcome.status === 'released' &&
      isConfirmedUnchargedRevert(error)
    ) {
      throw new DefiniteSpendFailure(
        error instanceof Error ? error.message : String(error)
      )
    }
    throw error
  }
}

interface BroadcastState {
  broadcastStarted: boolean
}

/**
 * Request-scoped broadcast detection.
 *
 * The wallet client is a process-wide singleton. Earlier versions swapped
 * sendTransaction/writeContract for wrappers at the start of each spend and
 * restored the captured originals at the end, which raced when two spends
 * interleaved: one restore could strip the other's detector (a real
 * broadcast then classified as "definitely uncharged" and released for
 * retry) or leave a stale wrapper installed.
 *
 * Now each client is wrapped exactly once, permanently, and the wrapper
 * marks whichever spend's AsyncLocalStorage context issued the write. Writes
 * made outside any classified spend are passed straight through.
 */
const broadcastContext = new AsyncLocalStorage<BroadcastState>()
const HOOKED = Symbol.for('agentpay.broadcastHook')

function installBroadcastHook(
  walletClient: { sendTransaction?: unknown; writeContract?: unknown } | null | undefined
): void {
  if (!walletClient) {
    return
  }
  const client = walletClient as Record<string | symbol, unknown>
  if (client[HOOKED]) {
    return
  }
  for (const method of ['sendTransaction', 'writeContract'] as const) {
    const original = client[method]
    if (typeof original !== 'function') {
      continue
    }
    const wrapped = function (this: unknown, ...args: unknown[]): unknown {
      const store = broadcastContext.getStore()
      if (store) {
        store.broadcastStarted = true
      }
      return (original as (..._a: unknown[]) => unknown).apply(this ?? walletClient, args)
    }
    Object.defineProperty(wrapped, 'agentpayOriginal', { value: original })
    client[method] = wrapped
  }
  Object.defineProperty(client, HOOKED, { value: true })
}

/** The un-hooked method behind a broadcast hook (for tests and diagnostics). */
export function originalWalletMethod<T>(method: T): T {
  const original = (method as { agentpayOriginal?: unknown } | undefined)?.agentpayOriginal
  return (original ?? method) as T
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

/**
 * Too many intents are awaiting reconciliation. Nothing was broadcast for the
 * refused call, so it is definite; it stays refused until locks are cleared.
 */
export class SpendIntentCapacityError extends DefiniteSpendFailure {
  constructor() {
    super(
      `${SPEND_INTENT_MAX_UNRESOLVED} spend intents are awaiting reconciliation. ` +
        'Refusing new value movement until an operator reconciles them ' +
        '(agentpay-mcp spend-intents list / resolve).'
    )
    this.name = 'SpendIntentCapacityError'
  }
}

/** A keyed settlement predates the in-memory cache; it is never re-executed. */
export class SettledIntentTombstoneError extends Error {
  constructor() {
    super(
      'This idempotency key already settled, but its result is no longer cached ' +
        '(evicted or from before a restart). Refusing to settle it again; use a new key.'
    )
    this.name = 'SettledIntentTombstoneError'
  }
}

export class DurableIdentityCapacityError extends DefiniteSpendFailure {
  constructor() {
    super(
      'This server has recorded the maximum number of settled idempotency keys. ' +
        'Refusing new keyed spends rather than forgetting an old key (which could let it settle twice). ' +
        'Retry without an idempotencyKey, or have the operator archive the spend journal.'
    )
    this.name = 'DurableIdentityCapacityError'
  }
}

/**
 * Require a complete EVM settlement hash before a spend callback may resolve
 * into the settled cache. A hashless or malformed SDK result is ambiguous —
 * the transfer may already have been broadcast — so this throws a generic
 * Error and the intent stays locked instead of replaying success:true with
 * a non-usable hash such as "pending" or "0x123".
 *
 * Canonical form is lowercase `0x` plus 64 hex chars. The SDK helper accepts
 * `0X`; that prefix is rejected here so cached hashes stay 0x-prefixed.
 */
export function requireSettlementHash(hash: unknown, label: string): string {
  if (typeof hash !== 'string' || hash.trim().length === 0) {
    throw new Error(
      `${label} returned without a transaction hash. ` +
        'Refusing to cache a hashless success; reconcile the original transfer before retrying.'
    )
  }
  const normalized = hash.trim()
  if (!normalized.startsWith('0x') || !isEvmTxHash(normalized)) {
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

/**
 * send_payment identity. Its own namespace (not send_token's) because the two
 * tools have different payload semantics; the native-ETH branch uses the zero
 * address as the token.
 */
export function sendPaymentIntentIdentity(input: {
  chainId: number
  tokenAddress: string
  recipientAddress: string
  rawAmount: bigint
  idempotencyKey?: string
}): SpendIntentIdentity {
  const fingerprint = [
    'send_payment',
    String(input.chainId),
    input.tokenAddress.toLowerCase(),
    input.recipientAddress.toLowerCase(),
    input.rawAmount.toString(),
  ].join(':')
  return spendIntentIdentity('send_payment', fingerprint, input.idempotencyKey)
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

/**
 * Length-safe x402_pay identity: JSON-encode method/url/body/headers, then
 * hash. Colon-joined fields collide (`url=…/a` + `body=b:c` vs `url=…/a:b`
 * + `body=c`), and raw header values must not become Map keys.
 */
function encodeX402PayFingerprint(input: {
  url: string
  method: string
  body?: string
  headers?: Record<string, string>
  terms?: Record<string, string>
}): string {
  const headers = Object.entries(input.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort((left, right) => {
      if (left[0] !== right[0]) {
        return left[0] < right[0] ? -1 : 1
      }
      if (left[1] !== right[1]) {
        return left[1] < right[1] ? -1 : 1
      }
      return 0
    })
  const encoded = JSON.stringify([
    'x402_pay',
    input.method.toUpperCase(),
    input.url,
    input.body ?? '',
    headers,
    ...(input.terms ? [Object.entries(input.terms).sort(([a], [b]) => (a < b ? -1 : 1))] : []),
  ])
  return `x402_pay:${createHash('sha256').update(encoded).digest('hex')}`
}

export function x402PayIntentIdentity(input: {
  url: string
  method: string
  body?: string
  headers?: Record<string, string>
  idempotencyKey?: string
  /** Caller-approved terms (cap, payee, …) — part of the payload identity. */
  terms?: Record<string, string>
}): SpendIntentIdentity {
  return spendIntentIdentity(
    'x402_pay',
    encodeX402PayFingerprint(input),
    input.idempotencyKey
  )
}

/**
 * x402_session_start identity: the endpoint's canonical HOST. Path, query,
 * port, scope, method, body and headers are all excluded, so neither a
 * reworded request, a sibling path nor a host alias can step around an
 * in-flight purchase or a post-settlement lock on the same paid service (F1).
 * The same key is the serialisation unit used by withKeyedLock.
 */
export function sessionStartIntentIdentity(input: { endpoint: string }): SpendIntentIdentity {
  const fingerprint = `x402_session_start:${x402PaymentHost(input.endpoint)}`
  return { key: fingerprint, fingerprint }
}

// ─── x402 payment locks: host + payee ──────────────────────────────────────

/**
 * Canonical host for x402 payment locks: lower-case, without the trailing
 * root dot (however it was spelled: `.`, `%2e`, `。` all parse to it) and
 * without the port. Every alias of one host maps to one lock.
 */
export function x402PaymentHost(url: string | URL): string {
  return normalizeHost(new URL(url).hostname)
}

export interface X402PaymentScope {
  /** Canonical host (see x402PaymentHost). */
  host: string
  /** Caller-approved payee, lower-cased. */
  payee: string
}

export function x402PaymentScope(url: string | URL, payTo: string): X402PaymentScope {
  return { host: x402PaymentHost(url), payee: payTo.toLowerCase() }
}

const X402_HOST_LOCK_PREFIX = 'x402-host#'
const X402_PAYEE_LOCK_PREFIX = 'x402-payee#'

/** Lock keys an x402 payment intent carries (pass as withSpendIntent `lockScope`). */
export function x402LockScope(scope: X402PaymentScope): string[] {
  return [`${X402_HOST_LOCK_PREFIX}${scope.host}`, `${X402_PAYEE_LOCK_PREFIX}${scope.payee}`]
}

function describeLockKey(key: string): string {
  if (key.startsWith(X402_HOST_LOCK_PREFIX)) return key.slice(X402_HOST_LOCK_PREFIX.length)
  if (key.startsWith(X402_PAYEE_LOCK_PREFIX)) return `payee ${key.slice(X402_PAYEE_LOCK_PREFIX.length)}`
  return key
}

/**
 * Refuse a new intent while ANY unresolved intent shares one of its lock
 * keys. For x402 that means: an earlier payment to the same host or the same
 * payee settled (or may have settled) without its response being delivered —
 * that service has shown it can take money without delivering, under any
 * path, port, host alias or (for the payee) any other host. Only the
 * operator CLI clears it. Enforced inside withSpendIntent admission, with no
 * await between this check and the begin record.
 */
function assertScopeUnlocked(scope: readonly string[]): void {
  for (const entry of unresolved.values()) {
    const hit = entry.scope?.find((key) => scope.includes(key))
    if (hit) {
      throw scopeLockedError(hit)
    }
  }
}

function scopeLockedError(lockKey: string): UnresolvedSpendIntentError {
  return new UnresolvedSpendIntentError(
    `New x402 payments to ${describeLockKey(lockKey)} are locked: an earlier x402 payment there ` +
      'settled (or may have settled) but its response was never delivered. Reconcile it ' +
      '(agentpay-mcp spend-intents list / resolve) before paying again.'
  )
}

export function x402PayIntentKey(input: {
  url: string
  method: string
  body?: string
  headers?: Record<string, string>
  idempotencyKey?: string
}): string {
  return x402PayIntentIdentity(input).key
}

export function _resetSpendIntentStore(): void {
  settledEphemeral.clear()
  settledDurable.clear()
  inflight.clear()
  unresolved.clear()
  tombstones.clear()
  durableIdentityCeiling = SPEND_INTENT_MAX_TOMBSTONES
  compactThreshold = SPEND_JOURNAL_COMPACT_BYTES
  journalBytes = 0
  compactedBytes = 0
  journalLoaded = false
}

export function _spendIntentStoreSizes(): {
  ephemeral: number
  durable: number
  unresolved: number
  tombstones: number
} {
  return {
    ephemeral: settledEphemeral.size,
    durable: settledDurable.size,
    unresolved: unresolved.size,
    tombstones: tombstones.size,
  }
}

/** Unresolved intents awaiting reconciliation (keys are opaque identities). */
export function listUnresolvedSpendIntents(): Array<{
  key: string
  since: number
  /** Human-readable payment locks this intent holds (hosts, payees). */
  blocks: string[]
}> {
  ensureJournalLoaded()
  return Array.from(unresolved.entries()).map(([key, entry]) => ({
    key,
    since: entry.settledAt,
    blocks: (entry.scope ?? []).map(describeLockKey),
  }))
}

/**
 * Operator reconciliation: the intent was checked on-chain and is known
 * either to have settled or to have moved nothing. Clears the lock (and
 * journals that decision). Not exposed as an MCP tool on purpose — the
 * constrained agent must not be able to unlock its own ambiguous payments.
 */
export function resolveSpendIntent(key: string): boolean {
  ensureJournalLoaded()
  const existed = unresolved.delete(key)
  if (existed) {
    journal({ op: 'release', key })
  }
  return existed
}

/**
 * Forget a settled result so the next identical call is a new purchase.
 * Used when the purchased thing was explicitly discarded (x402_session_end).
 * Never touches unresolved locks.
 */
export function forgetSettledIntent(key: string): void {
  settledEphemeral.delete(key)
  settledDurable.delete(key)
  tombstones.delete(identityDigest(key))
  journal({ op: 'forget', key })
}

function rememberDurable(key: string, value: SettledIntent<unknown>): void {
  settledDurable.delete(key)
  settledDurable.set(key, value)
  while (settledDurable.size > SPEND_INTENT_MAX_DURABLE) {
    const oldest = settledDurable.keys().next()
    if (oldest.done) {
      break
    }
    const evicted = settledDurable.get(oldest.value)
    settledDurable.delete(oldest.value)
    if (evicted) {
      rememberTombstone(oldest.value, evicted.fingerprint)
    }
  }
}

function rememberTombstone(key: string, fingerprint: string): void {
  tombstones.set(identityDigest(key), identityDigest(fingerprint))
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

// ─── Journal (opt-in durability) ───────────────────────────────────────────

type JournalRecord =
  | { op: 'begin'; key: string; fp: string; scope?: readonly string[] }
  | { op: 'settle'; key: string; fp: string; durable: boolean }
  | { op: 'definite'; key: string }
  | { op: 'lock'; key: string; fp: string; scope?: readonly string[] }
  | { op: 'release'; key: string }
  | { op: 'forget'; key: string }
  /** Compacted durable tombstone: digests of key and fingerprint. */
  | { op: 'tomb'; kd: string; fd: string }

let journalLoaded = false
let compactThreshold = SPEND_JOURNAL_COMPACT_BYTES
let journalBytes = 0
let compactedBytes = 0

/** Test seam: lower the compaction threshold (undefined restores it). */
export function _setJournalCompactionThresholdForTests(bytes?: number): void {
  compactThreshold = bytes ?? SPEND_JOURNAL_COMPACT_BYTES
}

export function spendJournalPath(): string | null {
  const dir = process.env[STATE_DIR_ENV]?.trim()
  return dir ? join(dir, SPEND_JOURNAL_FILE) : null
}

function journal(record: JournalRecord): void {
  const path = spendJournalPath()
  if (!path) {
    return
  }
  const dir = join(path, '..')
  // Compact BEFORE appending: in-memory state already reflects every earlier
  // record, and this record lands after the compacted state, so nothing it
  // guards (e.g. a begin for a wallet write about to start) can be dropped.
  if (journalBytes >= Math.max(compactThreshold, 2 * compactedBytes)) {
    compactJournal(path, dir)
  }
  const created = !existsSync(path)
  // Synchronous + fsync: a begin record must be on disk before any wallet
  // write it guards, or a crash could lose the evidence that one happened.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // A crash can leave a torn final line with no newline. Appending straight
  // onto it would weld this record into the unparseable fragment and replay
  // would silently drop it — losing a lock. Start a fresh line first.
  const prefix = !created && !endsWithNewline(path) ? '\n' : ''
  const line = prefix + JSON.stringify({ v: 1, at: Date.now(), ...record }) + '\n'
  appendFileSync(path, line, { mode: 0o600 })
  journalBytes += Buffer.byteLength(line)
  // File fsync failures PROPAGATE: a begin record that may not be durable
  // must abort the spend before any wallet write.
  fsyncFile(path)
  if (created) {
    // Make the new directory entry itself durable (best effort: directory
    // fsync is unsupported on some platforms).
    fsyncDirBestEffort(dir)
  }
}

/**
 * Rewrite the journal as exactly the live state: in-flight begins (with
 * scope), open locks (with scope), and durable tombstones (digests). Crash
 * safe: temp file, fsync, atomic rename, directory fsync — a crash at any
 * point leaves either the old or the new journal, both complete. Failure is
 * non-fatal (the old journal stays authoritative) and backs off.
 */
function compactJournal(path: string, dir: string): void {
  const lines: string[] = []
  const rec = (record: Record<string, unknown>) => lines.push(JSON.stringify({ v: 1, ...record }))
  for (const [key, entry] of inflight) {
    rec({ at: entry.startedAt, op: 'begin', key, fp: entry.fingerprint, ...(entry.scope ? { scope: entry.scope } : {}) })
  }
  for (const [key, entry] of unresolved) {
    rec({ at: entry.settledAt, op: 'lock', key, fp: entry.fingerprint, ...(entry.scope ? { scope: entry.scope } : {}) })
  }
  for (const [kd, fd] of tombstones) rec({ op: 'tomb', kd, fd })
  for (const [key, entry] of settledDurable) {
    rec({ op: 'tomb', kd: identityDigest(key), fd: identityDigest(entry.fingerprint) })
  }
  const text = lines.length > 0 ? lines.join('\n') + '\n' : ''
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, text, { mode: 0o600 })
    fsyncFile(tmp)
    renameSync(tmp, path)
    fsyncDirBestEffort(dir)
    journalBytes = compactedBytes = Buffer.byteLength(text)
  } catch (error: unknown) {
    compactedBytes = journalBytes // back off; the old journal is intact
    console.error(
      `[agentpay] spend journal compaction failed; keeping the existing journal: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function endsWithNewline(path: string): boolean {
  const fd = openSync(path, 'r')
  try {
    const { size } = fstatSync(fd)
    if (size === 0) return true
    const last = Buffer.alloc(1)
    readSync(fd, last, 0, 1, size - 1)
    return last[0] === 0x0a
  } finally {
    closeSync(fd)
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function fsyncDirBestEffort(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // Unsupported on some platforms; the file fsync is the content guarantee.
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Replay the journal once per process (or after a test reset). */
export function ensureJournalLoaded(): void {
  if (journalLoaded) {
    return
  }
  const path = spendJournalPath()
  if (!path || !existsSync(path)) {
    journalLoaded = true
    return
  }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    // Not marked loaded: every call retries the replay and refuses value
    // movement until it succeeds — an unread journal may hold live locks.
    throw new Error(
      `Spend-intent journal ${path} could not be read (${error instanceof Error ? error.message : String(error)}); ` +
        'refusing value movement until it can be replayed.'
    )
  }
  const open = new Map<string, { fp: string; at: number; scope?: readonly string[] }>()
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let rec: (JournalRecord & { at?: number }) | null = null
    try {
      rec = JSON.parse(line) as JournalRecord & { at?: number }
    } catch {
      // A torn final line from a crash: ignore it. A torn BEGIN means the
      // write it guarded never started (journal precedes the wallet call).
      continue
    }
    const at = typeof rec.at === 'number' ? rec.at : Date.now()
    switch (rec.op) {
      case 'begin':
      case 'lock': {
        // The begin record carries the payment locks, so a torn or missing
        // lock record after it cannot drop them.
        const scope = journalScope(rec.scope) ?? open.get(rec.key)?.scope
        open.set(rec.key, { fp: rec.fp, at, ...(scope ? { scope } : {}) })
        break
      }
      case 'settle':
        open.delete(rec.key)
        if (rec.durable) {
          rememberTombstone(rec.key, rec.fp)
        }
        break
      case 'definite':
      case 'release':
        open.delete(rec.key)
        break
      case 'forget':
        open.delete(rec.key)
        tombstones.delete(identityDigest(rec.key))
        break
      case 'tomb':
        if (typeof rec.kd === 'string' && typeof rec.fd === 'string') tombstones.set(rec.kd, rec.fd)
        break
    }
  }
  for (const [key, entry] of open) {
    unresolved.set(key, {
      settledAt: entry.at,
      fingerprint: entry.fp,
      ...(entry.scope ? { scope: entry.scope } : {}),
    })
  }
  journalLoaded = true
  journalBytes = Buffer.byteLength(text)
  compactedBytes = 0
  if (journalBytes >= compactThreshold) {
    compactJournal(path, join(path, '..'))
  }
}

function journalScope(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const keys = value.filter((key): key is string => typeof key === 'string')
  return keys.length > 0 ? keys : undefined
}

// ─── Intent execution ──────────────────────────────────────────────────────

type SpendIntentOptions<T> = {
  durable?: boolean
  fingerprint?: string
  shouldSettle?: (_value: T) => boolean
  /**
   * Payment-lock keys (see x402LockScope) this intent blocks if it ends
   * unresolved. Journaled on the begin record, before `run()` starts.
   * Intents sharing any scope key also run one at a time: a payment that
   * has settled but is still delivering holds its host and payee, so a
   * concurrent payment to either cannot settle in the window before a
   * post-settlement failure installs the lock.
   */
  lockScope?: readonly string[]
}

export async function withSpendIntent<T>(
  key: string,
  run: () => Promise<T>,
  options?: SpendIntentOptions<T>
): Promise<{ value: T; replayed: boolean }> {
  const scope = options?.lockScope && options.lockScope.length > 0 ? [...new Set(options.lockScope)].sort() : undefined
  if (!scope) return admitAndRun(key, run, options, undefined)
  // Sorted acquisition order: two intents can never wait on each other.
  const acquire = (index: number): Promise<{ value: T; replayed: boolean }> =>
    index === scope.length
      ? admitAndRun(key, run, options, scope)
      : withKeyedLock(`spend-scope:${scope[index]}`, () => acquire(index + 1))
  return acquire(0)
}

async function admitAndRun<T>(
  key: string,
  run: () => Promise<T>,
  options: SpendIntentOptions<T> | undefined,
  scope: string[] | undefined
): Promise<{ value: T; replayed: boolean }> {
  ensureJournalLoaded()
  pruneExpired()
  const fingerprint = options?.fingerprint ?? key

  const existing = touch(settledDurable, key) ?? settledEphemeral.get(key)
  if (existing) {
    assertFingerprint(existing.fingerprint, fingerprint)
    return { value: existing.value as T, replayed: true }
  }

  const tombstone = tombstones.get(identityDigest(key))
  if (tombstone !== undefined) {
    assertFingerprint(tombstone, identityDigest(fingerprint))
    throw new SettledIntentTombstoneError()
  }

  const locked = unresolved.get(key)
  if (locked) {
    assertFingerprint(locked.fingerprint, fingerprint)
    const lockKey = locked.scope?.[0]
    throw lockKey ? scopeLockedError(lockKey) : new UnresolvedSpendIntentError(unresolvedMessage())
  }

  const running = inflight.get(key)
  if (running) {
    assertFingerprint(running.fingerprint, fingerprint)
    const value = (await running.promise) as T
    return { value, replayed: true }
  }

  if (scope) {
    assertScopeUnlocked(scope)
  }

  // Fail closed under reconciliation backlog: never evict an unresolved lock
  // to make room, and never admit new value movement past the ceiling.
  // In-flight intents count too: each could end ambiguous and become a lock,
  // so admission reserves capacity for them (no unbounded overshoot).
  if (unresolved.size + inflight.size >= SPEND_INTENT_MAX_UNRESOLVED) {
    throw new SpendIntentCapacityError()
  }
  // Durable identities are never forgotten; past the ceiling, refuse new
  // keyed spends instead (in-flight keyed intents may all settle durably).
  if (options?.durable && tombstones.size + settledDurable.size + inflight.size >= durableIdentityCeiling) {
    throw new DurableIdentityCapacityError()
  }

  journal({ op: 'begin', key, fp: fingerprint, ...(scope ? { scope } : {}) })
  const startedAt = Date.now()
  const promise = run()
  inflight.set(key, { promise, fingerprint, startedAt, ...(scope ? { scope } : {}) })
  try {
    const value = await promise
    if (options?.shouldSettle && !options.shouldSettle(value)) {
      journal({ op: 'definite', key })
      return { value, replayed: false }
    }
    const entry: SettledIntent<T> = {
      settledAt: Date.now(),
      value,
      durable: Boolean(options?.durable),
      fingerprint,
    }
    if (entry.durable) {
      rememberDurable(key, entry)
    } else {
      settledEphemeral.set(key, entry)
    }
    unresolved.delete(key)
    journal({ op: 'settle', key, fp: fingerprint, durable: entry.durable })
    return { value, replayed: false }
  } catch (error: unknown) {
    if (error instanceof DefiniteSpendFailure) {
      journal({ op: 'definite', key })
      throw error
    }
    // Possibly broadcast: lock with no timer and no eviction. Admission
    // counted this intent while in flight, so the ceiling holds.
    unresolved.set(key, { settledAt: Date.now(), fingerprint, ...(scope ? { scope } : {}) })
    journal({ op: 'lock', key, fp: fingerprint, ...(scope ? { scope } : {}) })
    throw error
  } finally {
    inflight.delete(key)
  }
}

// ─── Keyed serialisation ───────────────────────────────────────────────────

const keyedTails = new Map<string, Promise<void>>()

/**
 * Run `task` after every earlier task with the same key has finished.
 * Used to make "check for an existing purchase, then buy" atomic per
 * resource (x402_session_start per origin).
 */
export async function withKeyedLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = keyedTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  keyedTails.set(key, tail)
  try {
    await previous
    return await task()
  } finally {
    release()
    if (keyedTails.get(key) === tail) {
      keyedTails.delete(key)
    }
  }
}
