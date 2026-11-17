/**
 * SDK 7 CCTP wrapper: bound attestation polling and bind attestation to the
 * messageBytes from this burn (not an unrelated Circle response).
 */
import type { BridgeChain, BridgeModule, BridgeOptions, BridgeResult } from 'agentwallet-sdk'
import { CCTP_DOMAIN_IDS, MESSAGE_TRANSMITTER_V2 } from 'agentwallet-sdk'
import { attestationUrl, parseAttestationResponse } from 'agentwallet-sdk/dist/bridge/attestation.js'
import type { Address, Hash, Hex } from 'viem'
import { getAddress } from 'viem'
import { DefiniteSpendFailure } from './spend-intent.js'
import {
  assertAttestedMessageMatchesBurn,
  extractMessageSentFromTransmitter,
} from './cctp-message-guard.js'
import { ResponseTooLargeError } from './safe-fetch.js'

type EvmBridgeChain = Exclude<BridgeChain, 'solana'>

const MAX_POLLS_ENV = 'AGENTPAY_BRIDGE_ATTESTATION_MAX_POLLS'
const DEFAULT_MAX_POLLS = 24
const ATTESTATION_POLL_INTERVAL_MS = 5000
const MAX_ATTESTATION_POLLS = 60
const MAX_ATTESTATION_REQUEST_MS = 10_000
const MAX_ATTESTATION_RESPONSE_BYTES = 256 * 1024

export function attestationPollCap(): number {
  const raw = process.env[MAX_POLLS_ENV]?.trim()
  if (!raw) return DEFAULT_MAX_POLLS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new DefiniteSpendFailure(`${MAX_POLLS_ENV} must be a positive integer.`)
  }
  return Math.min(n, MAX_ATTESTATION_POLLS)
}

export interface BridgeAttestationPendingState {
  burnTxHash: Hash
  messageBytes: Hex
  amount: bigint
  toChain: EvmBridgeChain
  fromChain: EvmBridgeChain
  options: BridgeOptions
  mintRecipient: Address
  sourceDomain: number
  destinationDomain: number
  apiUrl?: string
  nonce?: bigint
}

const pendingByIntentKey = new Map<string, BridgeAttestationPendingState>()

export function stashBridgeAttestationPending(
  intentKey: string,
  state: BridgeAttestationPendingState
): void {
  pendingByIntentKey.set(intentKey, state)
}

export function getBridgeAttestationPending(intentKey: string): BridgeAttestationPendingState | undefined {
  return pendingByIntentKey.get(intentKey)
}

export function clearBridgeAttestationPending(intentKey: string): void {
  pendingByIntentKey.delete(intentKey)
}

export class BridgeAttestationTimeoutError extends Error {
  readonly burnTxHash: Hash
  readonly pending: BridgeAttestationPendingState

  constructor(pending: BridgeAttestationPendingState, message: string) {
    super(message)
    this.name = 'BridgeAttestationTimeoutError'
    this.burnTxHash = pending.burnTxHash
    this.pending = pending
  }
}

/** Test seam for F4 #12 oversized attestation bodies. */
export async function readAttestationResponseCapped(response: Response): Promise<string> {
  return readResponseCapped(response)
}

async function readResponseCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    const text = await response.text()
    if (text.length > MAX_ATTESTATION_RESPONSE_BYTES) {
      throw new ResponseTooLargeError(MAX_ATTESTATION_RESPONSE_BYTES)
    }
    return text
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > MAX_ATTESTATION_RESPONSE_BYTES) {
      throw new ResponseTooLargeError(MAX_ATTESTATION_RESPONSE_BYTES)
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(merged)
}

async function fetchAttestationBody(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MAX_ATTESTATION_REQUEST_MS)
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      if (response.status === 404) {
        return 'pending'
      }
      const text = await readResponseCapped(response)
      throw new DefiniteSpendFailure(`Circle API returned HTTP ${response.status}: ${text}.`)
    }
    const text = await readResponseCapped(response)
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

async function pollAttestationForBurn(
  fromChain: EvmBridgeChain,
  burnTxHash: Hash,
  messageBytes: Hex,
  apiUrl: string | undefined,
  maxPolls: number
): Promise<{ message: Hex; attestation: Hex; eventNonce?: Hex }> {
  const sourceDomain = CCTP_DOMAIN_IDS[fromChain]
  const baseUrl = apiUrl ?? 'https://iris-api.circle.com'
  const url = attestationUrl(baseUrl, sourceDomain, burnTxHash)
  const deadline = Date.now() + maxPolls * ATTESTATION_POLL_INTERVAL_MS
  let lastErr: unknown
  const fail = (m: string): never => {
    throw new DefiniteSpendFailure(`Circle attestation failed: ${m}.`)
  }
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    if (Date.now() > deadline) break
    try {
      const body = await fetchAttestationBody(url)
      if (body === 'pending') {
        await new Promise((r) => setTimeout(r, ATTESTATION_POLL_INTERVAL_MS))
        continue
      }
      const parsed = parseAttestationResponse(body as never, fail, messageBytes)
      if (parsed === 'pending') {
        await new Promise((r) => setTimeout(r, ATTESTATION_POLL_INTERVAL_MS))
        continue
      }
      if (parsed.message.toLowerCase() !== messageBytes.toLowerCase()) {
        throw new DefiniteSpendFailure(
          'Circle attestation message does not match the local burn transaction. Refusing to mint.'
        )
      }
      return parsed
    } catch (error: unknown) {
      if (error instanceof DefiniteSpendFailure) throw error
      if (error instanceof ResponseTooLargeError) throw error
      lastErr = error
      const msg = error instanceof Error ? error.message : String(error)
      if (!/404|pending|not received|abort/i.test(msg)) {
        throw error
      }
      await new Promise((r) => setTimeout(r, ATTESTATION_POLL_INTERVAL_MS))
    }
  }
  throw new DefiniteSpendFailure(
    `Bridge attestation timed out after ${maxPolls} polls (see ${MAX_POLLS_ENV}). Burn tx: ${burnTxHash}.` +
      (lastErr instanceof Error ? ` Last error: ${lastErr.message}` : '')
  )
}

/** Continue attestation polling + mint from a prior burn (never re-burn). */
export async function bridgeUsdcResumeAfterBurn(
  bridge: BridgeModule,
  pending: BridgeAttestationPendingState
): Promise<BridgeResult> {
  const startMs = Date.now()
  const maxPolls = attestationPollCap()
  const attested = await pollAttestationForBurn(
    pending.fromChain,
    pending.burnTxHash,
    pending.messageBytes,
    pending.apiUrl,
    maxPolls
  )
  assertAttestedMessageMatchesBurn(attested.message, {
    sourceDomain: pending.sourceDomain,
    destinationDomain: pending.destinationDomain,
    amount: pending.amount,
    mintRecipient: pending.mintRecipient,
    fromChain: pending.fromChain,
    toChain: pending.toChain,
  })
  const mintTxHash = await bridge.mint(
    attested.message,
    attested.attestation,
    pending.toChain,
    pending.options.destinationRpcUrl
  )
  return {
    burnTxHash: pending.burnTxHash,
    mintTxHash,
    amount: pending.amount,
    fromChain: pending.fromChain,
    toChain: pending.toChain,
    recipient: pending.mintRecipient,
    nonce: pending.nonce ?? 0n,
    eventNonce: attested.eventNonce,
    elapsedMs: Date.now() - startMs,
  }
}

/** Full bridge with capped polling and message binding (replaces bare bridge.bridge()). */
export async function bridgeUsdcWithAttestationGuard(
  bridge: BridgeModule,
  amount: bigint,
  toChain: EvmBridgeChain,
  options: BridgeOptions = {},
  fromChain: EvmBridgeChain,
  intentKey?: string
): Promise<BridgeResult> {
  const startMs = Date.now()
  const maxPolls = attestationPollCap()
  const burn = await bridge.burn(amount, toChain, options)
  const bridgeRecord = bridge as unknown as {
    publicClient: { getTransactionReceipt: (args: { hash: Hash }) => Promise<{ logs: readonly unknown[] }> }
    fromChain: EvmBridgeChain
    walletClient: { account?: { address: Address } }
  }
  const receipt = await bridgeRecord.publicClient.getTransactionReceipt({ hash: burn.burnTxHash })
  const transmitter = MESSAGE_TRANSMITTER_V2[bridgeRecord.fromChain]
  const boundBytes = extractMessageSentFromTransmitter(
    { logs: receipt.logs as never },
    transmitter
  ).messageBytes
  if (boundBytes.toLowerCase() !== burn.messageBytes.toLowerCase()) {
    throw new DefiniteSpendFailure(
      'Burn messageBytes from SDK does not match MessageSent emitted by MESSAGE_TRANSMITTER_V2.'
    )
  }
  const mintRecipient = getAddress(
    (options.destinationAddress ?? bridgeRecord.walletClient.account?.address) as Address
  )
  const pending: BridgeAttestationPendingState = {
    burnTxHash: burn.burnTxHash,
    messageBytes: boundBytes,
    amount,
    toChain,
    fromChain: bridgeRecord.fromChain,
    options,
    mintRecipient,
    sourceDomain: burn.sourceDomain,
    destinationDomain: burn.destinationDomain,
    apiUrl: options.attestationApiUrl,
    nonce: burn.nonce,
  }
  try {
    const attested = await pollAttestationForBurn(
      bridgeRecord.fromChain,
      burn.burnTxHash,
      boundBytes,
      options.attestationApiUrl,
      maxPolls
    )
    assertAttestedMessageMatchesBurn(attested.message, {
      sourceDomain: burn.sourceDomain,
      destinationDomain: burn.destinationDomain,
      amount,
      mintRecipient,
      fromChain: bridgeRecord.fromChain,
      toChain: toChain as EvmBridgeChain,
    })
    const mintTxHash = await bridge.mint(attested.message, attested.attestation, toChain, options.destinationRpcUrl)
    return {
      burnTxHash: burn.burnTxHash,
      mintTxHash,
      amount,
      fromChain,
      toChain,
      recipient: mintRecipient,
      nonce: burn.nonce,
      eventNonce: attested.eventNonce,
      elapsedMs: Date.now() - startMs,
    }
  } catch (error: unknown) {
    if (error instanceof ResponseTooLargeError) {
      throw new DefiniteSpendFailure(
        `Circle attestation response exceeded ${MAX_ATTESTATION_RESPONSE_BYTES} bytes. Burn tx: ${burn.burnTxHash}.`
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    if (
      error instanceof DefiniteSpendFailure &&
      /timed out|ATTESTATION_TIMEOUT/i.test(message)
    ) {
      if (intentKey) {
        stashBridgeAttestationPending(intentKey, pending)
      }
      throw new BridgeAttestationTimeoutError(
        pending,
        `Bridge attestation timed out after ${maxPolls} polls. Burn tx: ${burn.burnTxHash}.`
      )
    }
    throw error
  }
}