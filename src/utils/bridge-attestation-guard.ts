/**
 * SDK 7 CCTP wrapper: bound attestation polling and bind attestation to the
 * messageBytes from this burn (not an unrelated Circle response).
 */
import type { BridgeModule, BridgeOptions, BridgeResult } from 'agentwallet-sdk'
import type { Address, Hash, Hex } from 'viem'
import { DefiniteSpendFailure } from './spend-intent.js'

const MAX_POLLS_ENV = 'AGENTPAY_BRIDGE_ATTESTATION_MAX_POLLS'
const DEFAULT_MAX_POLLS = 24
const ATTESTATION_POLL_INTERVAL_MS = 5000
const MAX_ATTESTATION_POLLS = 60

type EVMBridgeChain = Parameters<BridgeModule['burn']>[1]

export function attestationPollCap(): number {
  const raw = process.env[MAX_POLLS_ENV]?.trim()
  if (!raw) return DEFAULT_MAX_POLLS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) {
    throw new DefiniteSpendFailure(`${MAX_POLLS_ENV} must be a positive integer.`)
  }
  return Math.min(n, MAX_ATTESTATION_POLLS)
}

async function pollAttestationForBurn(
  bridge: BridgeModule,
  burnTxHash: Hash,
  messageBytes: Hex,
  apiUrl: string | undefined,
  maxPolls: number
): Promise<{ message: Hex; attestation: Hex; eventNonce?: Hex }> {
  const deadline = Date.now() + maxPolls * ATTESTATION_POLL_INTERVAL_MS
  let lastErr: unknown
  for (let attempt = 0; attempt < maxPolls; attempt++) {
    if (Date.now() > deadline) break
    try {
      const attested = await bridge.waitForAttestation(burnTxHash, apiUrl)
      if (attested.message.toLowerCase() !== messageBytes.toLowerCase()) {
        throw new DefiniteSpendFailure(
          'Circle attestation message does not match the local burn transaction. Refusing to mint.'
        )
      }
      return attested
    } catch (error: unknown) {
      if (error instanceof DefiniteSpendFailure) throw error
      lastErr = error
      const msg = error instanceof Error ? error.message : String(error)
      if (!/404|pending|not received|ATTESTATION_TIMEOUT/i.test(msg)) {
        throw error
      }
      await new Promise((r) => setTimeout(r, ATTESTATION_POLL_INTERVAL_MS))
    }
  }
  throw new DefiniteSpendFailure(
    `Bridge attestation timed out after ${maxPolls} polls (see ${MAX_POLLS_ENV}). Burn tx: ${burnTxHash}.`
  )
}

/** Full bridge with capped polling and message binding (replaces bare bridge.bridge()). */
export async function bridgeUsdcWithAttestationGuard(
  bridge: BridgeModule,
  amount: bigint,
  toChain: EVMBridgeChain,
  options: BridgeOptions = {},
  fromChain: EVMBridgeChain
): Promise<BridgeResult> {
  const startMs = Date.now()
  const maxPolls = attestationPollCap()
  const burn = await bridge.burn(amount, toChain, options)
  const attested = await pollAttestationForBurn(
    bridge,
    burn.burnTxHash,
    burn.messageBytes,
    options.attestationApiUrl,
    maxPolls
  )
  const mintTxHash = await bridge.mint(attested.message, attested.attestation, toChain, options.destinationRpcUrl)
  const account = (bridge as unknown as { walletClient: { account?: { address: Address } } }).walletClient.account
  const recipient = options.destinationAddress ?? account?.address
  if (!recipient) {
    throw new DefiniteSpendFailure('Bridge recipient address is unknown.')
  }
  return {
    burnTxHash: burn.burnTxHash,
    mintTxHash,
    amount,
    fromChain,
    toChain,
    recipient,
    nonce: burn.nonce,
    eventNonce: attested.eventNonce,
    elapsedMs: Date.now() - startMs,
  }
}