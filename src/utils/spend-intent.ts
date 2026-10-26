import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
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
 * with `agentpay-mcp spend-intents list | resolve <id> settled|unsettled`.
 * Exactly one process owns a state directory at a time (see "State-directory
 * ownership" below), so no other writer's record can be lost to compaction.
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

export const SPEND_STATE_LOCK_FILE = 'spend-intents.lock'
/**
 * A state-directory lock held by a process on ANOTHER host (shared volume)
 * is presumed abandoned once its heartbeat is this old. On the same host,
 * the holder's pid liveness decides instead.
 */
export const SPEND_STATE_LOCK_STALE_MS = 2 * 60 * 1000
const SPEND_STATE_LOCK_HEARTBEAT_MS = 30 * 1000

/**
 * Characters an idempotency key may not contain: C0/C1 controls and DEL,
 * plus invisible formatting, bidi overrides and line/paragraph separators.
 * Keys are echoed to operators (`spend-intents list`); none of these may
 * reach a terminal or forge an output line.
 */
const KEY_FORBIDDEN =
  '\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb'

/**
 * Published MCP JSON Schema for optional idempotencyKey on spend tools.
 * Runtime Zod applies the same minLength / maxLength / pattern to the raw
 * string (no trim-before-length); identity lookup still trims after
 * validation. The pattern requires a non-whitespace character and forbids
 * KEY_FORBIDDEN. It is deterministic (leading whitespace, then the first
 * non-whitespace character, then the rest), so it runs in linear time.
 */
export const IDEMPOTENCY_KEY_JSON_SCHEMA = {
  type: 'string' as const,
  minLength: 1,
  maxLength: 128,
  pattern: `^[^${KEY_FORBIDDEN}\\S]*[^${KEY_FORBIDDEN}\\s][^${KEY_FORBIDDEN}]*$`,
}

/**
 * Runtime check matching IDEMPOTENCY_KEY_JSON_SCHEMA: length and pattern
 * apply to the raw string (do not trim before min/max). Runtime also
 * rejects unpaired UTF-16 surrogates, which a JSON Schema pattern cannot
 * express portably.
 */
export const IdempotencyKeyZodSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(new RegExp(IDEMPOTENCY_KEY_JSON_SCHEMA.pattern), {
    message:
      'idempotencyKey needs a non-whitespace character and may not contain control, invisible formatting, or line-separator characters',
  })
  .refine((key) => !/[\uD800-\uDFFF]/u.test(key), {
    message: 'idempotencyKey may not contain unpaired surrogate characters',
  })

/**
 * Keys that are inert in a POSIX shell and are passed through it unchanged:
 * safe to print raw and to accept back as a command-line argument.
 */
const SHELL_PLAIN_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:#-]*$/

/**
 * Operator handle for an intent: `id:` plus a 128-bit digest of its key.
 * Shell-safe and collision-resistant, so pasting it can never select a
 * different intent than the one printed — whatever characters the
 * (caller-chosen) key contains.
 */
export function spendIntentHandle(key: string): string {
  return `id:${identityDigest(key)}`
}

/**
 * Operator-safe rendering of an intent key, for information only. Plain
 * keys (SHELL_PLAIN_KEY) print as is. Anything else prints single-quoted —
 * inert if pasted into a shell — with a backslash doubled, and `'` and every
 * non-printable or non-ASCII UTF-16 unit escaped as \uXXXX, so no key can inject a
 * terminal control sequence or forge an output line. Commands select such
 * intents by spendIntentHandle, never by this text.
 */
export function displaySpendIntentKey(key: string): string {
  if (SHELL_PLAIN_KEY.test(key)) {
    return key
  }
  let out = "'"
  for (let i = 0; i < key.length; i++) {
    const unit = key.charCodeAt(i)
    if (unit === 0x5c) {
      out += '\\\\'
    } else if (unit >= 0x20 && unit <= 0x7e && unit !== 0x27) {
      out += key[i]
    } else {
      out += '\\u' + unit.toString(16).padStart(4, '0')
    }
  }
  return out + "'"
}

/**
 * Resolve a command-line selector to an intent key: an `id:` handle, or a
 * key that is shell-plain (and so reached the process exactly as typed).
 * Anything else is refused — its printed form may not survive a shell.
 */
export function spendIntentKeyFromSelector(
  selector: string,
  keys: Iterable<string>
): { key: string } | { error: 'not-found' | 'not-plain' } {
  if (selector.startsWith('id:')) {
    for (const key of keys) {
      if (spendIntentHandle(key) === selector) return { key }
    }
    return { error: 'not-found' }
  }
  return SHELL_PLAIN_KEY.test(selector) ? { key: selector } : { error: 'not-plain' }
}

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
  /**
   * Keyed by a caller idempotencyKey: an operator "settled" resolution
   * retires the key permanently (tombstone) instead of freeing it.
   */
  durable?: boolean
}

interface InflightIntent {
  promise: Promise<unknown>
  fingerprint: string
  startedAt: number
  scope?: readonly string[]
  durable?: boolean
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
  releaseStateDirLock()
  stateLockLost = null
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

export interface UnresolvedSpendIntentEntry {
  /** Opaque identity; render with displaySpendIntentKey before printing. */
  key: string
  /** Shell-safe selector for operator commands (spendIntentHandle). */
  handle: string
  since: number
  /** Human-readable payment locks this intent holds (hosts, payees). */
  blocks: string[]
  /** Keyed by a caller idempotencyKey ("settled" retires the key). */
  keyed: boolean
}

function unresolvedEntry(key: string, entry: UnresolvedIntent): UnresolvedSpendIntentEntry {
  return {
    key,
    handle: spendIntentHandle(key),
    since: entry.settledAt,
    blocks: (entry.scope ?? []).map(describeLockKey),
    keyed: isKeyedIntent(key, entry.durable),
  }
}

/** Unresolved intents awaiting reconciliation (keys are opaque identities). */
export function listUnresolvedSpendIntents(): UnresolvedSpendIntentEntry[] {
  ensureJournalLoaded()
  return Array.from(unresolved.entries()).map(([key, entry]) => unresolvedEntry(key, entry))
}

/**
 * Read-only view of the journaled locks, for `spend-intents list` while
 * another process owns the state directory. Takes no lock and writes
 * nothing; the owner journals every change before applying it, so this is
 * the owner's state as of the read.
 */
export function snapshotUnresolvedSpendIntents(): UnresolvedSpendIntentEntry[] {
  const path = spendJournalPath()
  if (!path || !existsSync(path)) {
    return []
  }
  const { open } = replayJournal(readFileSync(path, 'utf8'))
  return Array.from(open.entries()).map(([key, entry]) =>
    unresolvedEntry(key, {
      settledAt: entry.at,
      fingerprint: entry.fp,
      ...(entry.scope ? { scope: entry.scope } : {}),
      ...(entry.durable !== undefined ? { durable: entry.durable } : {}),
    })
  )
}

/**
 * What the operator found on-chain for a locked intent:
 * - `settled`: the value moved. A keyed intent's idempotencyKey is retired
 *   for good (tombstone), so a retry with it is refused, never paid again.
 * - `unsettled`: nothing moved. The lock is cleared and a retry may pay.
 */
export type SpendIntentOutcome = 'settled' | 'unsettled'

export interface ResolvedSpendIntent {
  key: string
  outcome: SpendIntentOutcome
  /** The settled intent's idempotencyKey is now permanently refused. */
  keyRetired: boolean
}

/**
 * Operator reconciliation of one locked intent, journaled before it takes
 * effect. Not exposed as an MCP tool on purpose — the constrained agent
 * must not be able to unlock its own ambiguous payments.
 */
export function resolveSpendIntent(key: string, outcome: SpendIntentOutcome): ResolvedSpendIntent | null {
  if (outcome !== 'settled' && outcome !== 'unsettled') {
    throw new TypeError(`Unknown spend-intent outcome: ${String(outcome)} (expected settled or unsettled)`)
  }
  ensureJournalLoaded()
  const entry = unresolved.get(key)
  if (!entry) {
    return null
  }
  const keyRetired = outcome === 'settled' && isKeyedIntent(key, entry.durable)
  journal(
    outcome === 'settled'
      ? { op: 'settle', key, fp: entry.fingerprint, durable: keyRetired }
      : { op: 'release', key }
  )
  unresolved.delete(key)
  if (keyRetired) {
    rememberTombstone(key, entry.fingerprint)
  }
  return { key, outcome, keyRetired }
}

/**
 * Whether an intent is keyed by a caller idempotencyKey. Records written
 * before the flag existed fall back to the key shape (`tool#key`), which
 * errs toward retiring the key — refusing a retry, never paying twice.
 */
function isKeyedIntent(key: string, durable: boolean | undefined): boolean {
  return durable ?? key.includes('#')
}

function keyedUnresolvedCount(): number {
  let count = 0
  for (const [key, entry] of unresolved) {
    if (isKeyedIntent(key, entry.durable)) count++
  }
  return count
}

/**
 * Forget a settled result so the next identical call is a new purchase.
 * Used when the purchased thing was explicitly discarded (x402_session_end).
 * Never touches unresolved locks.
 */
export function forgetSettledIntent(key: string): void {
  ensureJournalLoaded()
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
  | { op: 'begin'; key: string; fp: string; scope?: readonly string[]; durable?: boolean }
  | { op: 'settle'; key: string; fp: string; durable: boolean }
  | { op: 'definite'; key: string }
  | { op: 'lock'; key: string; fp: string; scope?: readonly string[]; durable?: boolean }
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
  ensureJournalLoaded()
  // Re-checked before EVERY write: if another process took the state
  // directory over (e.g. it judged this one dead), stop writing for good —
  // its journal is now authoritative and this process's memory is stale.
  assertStateDirOwnership(path)
  const dir = dirname(path)
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
 * non-fatal (the old journal stays authoritative) and backs off. Runs only
 * in the process that owns the state directory, so no other writer's
 * record can be renamed away.
 */
function compactJournal(path: string, dir: string): void {
  const lines: string[] = []
  const rec = (record: Record<string, unknown>) => lines.push(JSON.stringify({ v: 1, ...record }))
  const extras = (entry: { scope?: readonly string[]; durable?: boolean }) => ({
    ...(entry.scope ? { scope: entry.scope } : {}),
    ...(entry.durable !== undefined ? { durable: entry.durable } : {}),
  })
  for (const [key, entry] of inflight) {
    rec({ at: entry.startedAt, op: 'begin', key, fp: entry.fingerprint, ...extras(entry) })
  }
  for (const [key, entry] of unresolved) {
    rec({ at: entry.settledAt, op: 'lock', key, fp: entry.fingerprint, ...extras(entry) })
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
  if (!path) {
    journalLoaded = true
    return
  }
  // One owner per state directory, taken BEFORE the read: a second writer
  // (another server, or the operator CLI while the server runs) could
  // otherwise append records this process never sees, and the next
  // compaction would rename them away — losing a lock or a settled key.
  acquireStateDirLock(path)
  if (!existsSync(path)) {
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
  const { open, tombs } = replayJournal(text)
  for (const [kd, fd] of tombs) {
    tombstones.set(kd, fd)
  }
  for (const [key, entry] of open) {
    unresolved.set(key, {
      settledAt: entry.at,
      fingerprint: entry.fp,
      ...(entry.scope ? { scope: entry.scope } : {}),
      ...(entry.durable !== undefined ? { durable: entry.durable } : {}),
    })
  }
  journalLoaded = true
  journalBytes = Buffer.byteLength(text)
  compactedBytes = 0
  if (journalBytes >= compactThreshold) {
    compactJournal(path, dirname(path))
  }
}

interface ReplayedIntent {
  fp: string
  at: number
  scope?: readonly string[]
  durable?: boolean
}

/** Pure replay: the open (locked) intents and durable tombstones a journal holds. */
function replayJournal(text: string): { open: Map<string, ReplayedIntent>; tombs: Map<string, string> } {
  const open = new Map<string, ReplayedIntent>()
  const tombs = new Map<string, string>()
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
        const previous = open.get(rec.key)
        const scope = journalScope(rec.scope) ?? previous?.scope
        const durable = typeof rec.durable === 'boolean' ? rec.durable : previous?.durable
        open.set(rec.key, {
          fp: rec.fp,
          at,
          ...(scope ? { scope } : {}),
          ...(durable !== undefined ? { durable } : {}),
        })
        break
      }
      case 'settle':
        open.delete(rec.key)
        if (rec.durable) {
          tombs.set(identityDigest(rec.key), identityDigest(rec.fp))
        }
        break
      case 'definite':
      case 'release':
        open.delete(rec.key)
        break
      case 'forget':
        open.delete(rec.key)
        tombs.delete(identityDigest(rec.key))
        break
      case 'tomb':
        if (typeof rec.kd === 'string' && typeof rec.fd === 'string') tombs.set(rec.kd, rec.fd)
        break
    }
  }
  return { open, tombs }
}

function journalScope(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const keys = value.filter((key): key is string => typeof key === 'string')
  return keys.length > 0 ? keys : undefined
}

// ─── State-directory ownership ─────────────────────────────────────────────
//
// Exactly one process owns an AGENTPAY_STATE_DIR at a time: it alone appends
// to and compacts the journal. The owner creates `spend-intents.lock`
// atomically with its full content and keeps a descriptor on it. Ownership
// means "the lock path still holds my inode and my nonce"; it is checked
// before every journal write and by a heartbeat that rewrites the lock
// through that descriptor, so the filesystem (not a host clock) stamps its
// mtime and another process's lock is never touched.
//
// A lock is taken over only when its holder is provably gone:
// - same host, boot and PID namespace: its pid is not running, or is running
//   with a different start time (pid reuse);
// - otherwise (another host, or another container's PID namespace on a
//   shared volume): its heartbeat is older than SPEND_STATE_LOCK_STALE_MS,
//   measured against a fresh file on the same filesystem.
// Takeovers are serialised by `spend-intents.lock.takeover`, and the lock is
// re-verified under it, so only the exact lock judged stale is ever removed.

interface ProcessIdentity {
  pid: number
  host: string
  /** Linux: kernel boot id. */
  boot?: string
  /** Linux: PID namespace — pid liveness means something only inside one. */
  pidns?: string
  /** Linux: start time in clock ticks since boot (detects pid reuse). */
  start?: string
}

interface StateLockHolder extends ProcessIdentity {
  nonce: string
  at: number
}

interface OwnedStateLock {
  path: string
  fd: number
  ino: bigint
  dev: bigint
  nonce: string
  content: string
  heartbeat: ReturnType<typeof setInterval>
}

/** Another process owns the state directory (or took it over from this one). */
export class SpendStateDirBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpendStateDirBusyError'
  }
}

const TAKEOVER_MUTEX_STALE_MS = 30 * 1000
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])

let ownedStateLock: OwnedStateLock | null = null
let stateLockLost: string | null = null
let exitHookInstalled = false
let selfIdentity: ProcessIdentity | undefined

function stateLockPathFor(journalPath: string): string {
  return join(dirname(journalPath), SPEND_STATE_LOCK_FILE)
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

function readProcStart(pid: number | 'self'): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // Fields after "(comm) " start at field 3; starttime is field 22.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    return undefined
  }
}

function processIdentity(): ProcessIdentity {
  if (selfIdentity?.pid === process.pid) {
    return selfIdentity
  }
  const identity: ProcessIdentity = { pid: process.pid, host: hostname() }
  if (process.platform === 'linux') {
    try {
      identity.boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    } catch {
      // unavailable: treated as a different scope (heartbeat rule)
    }
    try {
      identity.pidns = readlinkSync('/proc/self/ns/pid')
    } catch {
      // unavailable: treated as a different scope (heartbeat rule)
    }
    const start = readProcStart('self')
    if (start !== undefined) identity.start = start
  }
  selfIdentity = identity
  return identity
}

/** Whether pid liveness of `holder` can be checked from this process. */
function sameProcessScope(holder: ProcessIdentity, me: ProcessIdentity): boolean {
  if (holder.host !== me.host || holder.boot !== me.boot || holder.pidns !== me.pidns) {
    return false
  }
  // On Linux, identical-but-missing ids prove nothing about the namespace.
  return process.platform !== 'linux' || (me.boot !== undefined && me.pidns !== undefined)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    // EPERM: the process exists but belongs to another user.
    return errorCode(error) !== 'ESRCH'
  }
}

/** Same scope only. Unverifiable start times count as running (fail closed). */
function holderRunning(holder: StateLockHolder): boolean {
  if (!pidAlive(holder.pid)) {
    return false
  }
  if (holder.start === undefined) {
    return true
  }
  const start = readProcStart(holder.pid)
  return start === undefined || start === holder.start
}

/** undefined: no lock file. null: present but unreadable or malformed. */
function readStateLockHolder(path: string): StateLockHolder | null | undefined {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    return errorCode(error) === 'ENOENT' ? undefined : null
  }
  try {
    const value = JSON.parse(text) as Partial<StateLockHolder>
    if (
      Number.isSafeInteger(value.pid) &&
      (value.pid as number) > 0 &&
      typeof value.host === 'string' &&
      typeof value.nonce === 'string'
    ) {
      const optional = (field: unknown) => (typeof field === 'string' ? field : undefined)
      const boot = optional(value.boot)
      const pidns = optional(value.pidns)
      const start = optional(value.start)
      return {
        pid: value.pid as number,
        host: value.host,
        nonce: value.nonce,
        at: typeof value.at === 'number' ? value.at : 0,
        ...(boot !== undefined ? { boot } : {}),
        ...(pidns !== undefined ? { pidns } : {}),
        ...(start !== undefined ? { start } : {}),
      }
    }
  } catch {
    // fall through: malformed
  }
  return null
}

/**
 * Age of `path` by the filesystem's own clock: the mtime of a file written
 * now, minus the mtime of `path`. Immune to clock skew between hosts.
 */
function fileAgeMs(path: string, nonce: string): number | undefined {
  const probe = `${path}.${nonce}.probe`
  try {
    writeFileSync(probe, '0', { mode: 0o600 })
    return statSync(probe).mtimeMs - statSync(path).mtimeMs
  } catch {
    return undefined
  } finally {
    unlinkQuiet(probe)
  }
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // already gone
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Create the lock file with its full content in one atomic step (hard link
 * of a fsync'd temp file) and return a descriptor on it, or null if a lock
 * exists. Filesystems without hard links fall back to an exclusive create.
 */
function createStateLockFile(path: string, content: string, nonce: string): number | null {
  const tmp = `${path}.${nonce}.tmp`
  const fd = openSync(tmp, 'wx+', 0o600)
  let keep = false
  try {
    writeSync(fd, content, 0)
    fsyncSync(fd)
    try {
      linkSync(tmp, path)
      keep = true
      return fd
    } catch (error: unknown) {
      const code = errorCode(error)
      if (code === 'EEXIST') {
        return null
      }
      if (code !== undefined && NO_HARD_LINKS.has(code)) {
        return createStateLockFileExclusive(path, content)
      }
      throw error
    }
  } finally {
    unlinkQuiet(tmp)
    if (!keep) closeSync(fd)
  }
}

function createStateLockFileExclusive(path: string, content: string): number | null {
  let fd: number
  try {
    fd = openSync(path, 'wx+', 0o600)
  } catch (error: unknown) {
    if (errorCode(error) === 'EEXIST') {
      return null
    }
    throw error
  }
  try {
    writeSync(fd, content, 0)
    fsyncSync(fd)
  } catch (error: unknown) {
    closeSync(fd)
    unlinkQuiet(path)
    throw error
  }
  return fd
}

function ownsStateLock(owned: OwnedStateLock): boolean {
  try {
    const st = statSync(owned.path, { bigint: true })
    if (st.ino !== owned.ino || st.dev !== owned.dev) {
      return false
    }
  } catch {
    return false
  }
  return readStateLockHolder(owned.path)?.nonce === owned.nonce
}

function describeHolder(holder: StateLockHolder, me: ProcessIdentity): string {
  if (sameProcessScope(holder, me)) return `process ${holder.pid} on this host`
  if (holder.host === me.host) return `process ${holder.pid} in another PID namespace on host ${JSON.stringify(holder.host)}`
  return `process ${holder.pid} on host ${JSON.stringify(holder.host)}`
}

function staleVerdict(
  path: string,
  holder: StateLockHolder | null,
  me: StateLockHolder
): { stale: boolean; reason: string } {
  const dir = dirname(path)
  const abandonedAfter = `A lock that cannot be checked by process id is presumed abandoned ${SPEND_STATE_LOCK_STALE_MS / 1000}s after its last heartbeat.`
  if (holder === null) {
    const age = fileAgeMs(path, me.nonce)
    return {
      stale: age !== undefined && age > SPEND_STATE_LOCK_STALE_MS,
      reason:
        `Spend-intent state directory ${dir} is locked by an unreadable ${path}. Refusing value movement. ` +
        `${abandonedAfter} If no agentpay-mcp process uses this directory, remove that file.`,
    }
  }
  const owner = describeHolder(holder, me)
  const busy =
    `Spend-intent state directory ${dir} is owned by ${owner}. Refusing value movement here: only one ` +
    'agentpay-mcp process (server or spend-intents command) may use a state directory at a time. Stop the ' +
    'other process, or give each server its own AGENTPAY_STATE_DIR. '
  if (sameProcessScope(holder, me)) {
    return {
      // Same pid as this live process: the holder is this process or its
      // dead predecessor (live pids are unique within a namespace).
      stale: holder.pid === me.pid || !holderRunning(holder),
      reason: busy + `If process ${holder.pid} is not agentpay-mcp, remove ${path}.`,
    }
  }
  const age = fileAgeMs(path, me.nonce)
  return { stale: age !== undefined && age > SPEND_STATE_LOCK_STALE_MS, reason: busy + abandonedAfter }
}

/** Run `task` holding the takeover mutex; undefined if it stays contended. */
function withTakeoverMutex<T>(lockPath: string, nonce: string, task: () => T): T | undefined {
  const mutex = `${lockPath}.takeover`
  for (let attempt = 0; attempt < 100; attempt++) {
    let fd: number
    try {
      fd = openSync(mutex, 'wx', 0o600)
    } catch (error: unknown) {
      if (errorCode(error) !== 'EEXIST') throw error
      const age = fileAgeMs(mutex, nonce)
      if (age !== undefined && age > TAKEOVER_MUTEX_STALE_MS) {
        // Held for microseconds by design: this one outlived a crash.
        unlinkQuiet(mutex)
      } else {
        sleepSync(10)
      }
      continue
    }
    closeSync(fd)
    try {
      return task()
    } finally {
      unlinkQuiet(mutex)
    }
  }
  return undefined
}

function acquireStateDirLock(journalPath: string): void {
  const path = stateLockPathFor(journalPath)
  if (stateLockLost) {
    throw new SpendStateDirBusyError(stateLockLost)
  }
  if (ownedStateLock?.path === path) {
    return
  }
  releaseStateDirLock()
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const me: StateLockHolder = { ...processIdentity(), nonce: randomUUID(), at: Date.now() }
  const content = JSON.stringify(me)
  for (let attempt = 0; attempt < 4; attempt++) {
    const fd = createStateLockFile(path, content, me.nonce)
    if (fd !== null) {
      adoptStateLock(path, fd, me.nonce, content)
      return
    }
    const holder = readStateLockHolder(path)
    if (holder === undefined) {
      continue // released between our attempt and the read
    }
    const verdict = staleVerdict(path, holder, me)
    if (!verdict.stale) {
      throw new SpendStateDirBusyError(verdict.reason)
    }
    const removed = withTakeoverMutex(path, me.nonce, () => {
      // Re-verify under the mutex: remove only the exact lock judged stale.
      const again = readStateLockHolder(path)
      if (again === undefined) return true
      if ((again === null) !== (holder === null) || (again && holder && again.nonce !== holder.nonce)) {
        return false // replaced meanwhile; re-evaluate the new holder
      }
      unlinkQuiet(path)
      return true
    })
    if (removed === undefined) {
      break
    }
  }
  throw new SpendStateDirBusyError(
    `Could not take ownership of spend-intent state directory ${dir}; another process is contending for it. Refusing value movement.`
  )
}

function adoptStateLock(path: string, fd: number, nonce: string, content: string): void {
  const st = fstatSync(fd, { bigint: true })
  const heartbeat = setInterval(heartbeatStateLock, SPEND_STATE_LOCK_HEARTBEAT_MS)
  heartbeat.unref()
  ownedStateLock = { path, fd, ino: st.ino, dev: st.dev, nonce, content, heartbeat }
  if (!exitHookInstalled) {
    exitHookInstalled = true
    process.once('exit', releaseStateDirLock)
  }
}

/**
 * Refresh the lock's mtime by rewriting its (unchanged) content through our
 * own descriptor — never a path-based touch, which could refresh another
 * process's lock. A lock that is no longer ours ends ownership for good.
 */
function heartbeatStateLock(): void {
  const owned = ownedStateLock
  if (!owned) {
    return
  }
  if (!ownsStateLock(owned)) {
    loseStateLock(owned)
    return
  }
  try {
    writeSync(owned.fd, owned.content, 0)
    fsyncSync(owned.fd)
  } catch {
    loseStateLock(owned)
  }
}

/** Test seam: run one heartbeat now. */
export function _heartbeatSpendStateLockForTests(): void {
  heartbeatStateLock()
}

function loseStateLock(owned: OwnedStateLock): void {
  const holder = readStateLockHolder(owned.path)
  stateLockLost =
    `This process lost ownership of spend-intent state directory ${dirname(owned.path)}` +
    (holder ? ` to ${describeHolder(holder, processIdentity())}` : '') +
    '. Refusing value movement; restart the server so it replays the current journal.'
  clearInterval(owned.heartbeat)
  try {
    closeSync(owned.fd)
  } catch {
    // already closed
  }
  ownedStateLock = null
}

function assertStateDirOwnership(journalPath: string): void {
  if (stateLockLost) {
    throw new SpendStateDirBusyError(stateLockLost)
  }
  const path = stateLockPathFor(journalPath)
  if (ownedStateLock?.path !== path) {
    acquireStateDirLock(journalPath)
    return
  }
  if (!ownsStateLock(ownedStateLock)) {
    loseStateLock(ownedStateLock)
    throw new SpendStateDirBusyError(stateLockLost!)
  }
}

function releaseStateDirLock(): void {
  const owned = ownedStateLock
  if (!owned) {
    return
  }
  ownedStateLock = null
  clearInterval(owned.heartbeat)
  if (ownsStateLock(owned)) {
    unlinkQuiet(owned.path)
  }
  try {
    closeSync(owned.fd)
  } catch {
    // already closed
  }
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
  // keyed spends instead (in-flight keyed intents may all settle durably,
  // and a locked keyed intent becomes a tombstone if resolved as settled).
  if (
    options?.durable &&
    tombstones.size + settledDurable.size + inflight.size + keyedUnresolvedCount() >= durableIdentityCeiling
  ) {
    throw new DurableIdentityCapacityError()
  }

  const durable = Boolean(options?.durable)
  journal({ op: 'begin', key, fp: fingerprint, ...(scope ? { scope } : {}), durable })
  const startedAt = Date.now()
  const promise = run()
  inflight.set(key, { promise, fingerprint, startedAt, ...(scope ? { scope } : {}), durable })
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
    unresolved.set(key, { settledAt: Date.now(), fingerprint, ...(scope ? { scope } : {}), durable })
    journal({ op: 'lock', key, fp: fingerprint, ...(scope ? { scope } : {}), durable })
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
