/**
 * Shared AgentPay x402 client.
 *
 * x402_pay and x402_session_start used to each construct createX402Client
 * with a copy of the same onBeforePayment guards. One factory owns:
 *   - payable payTo / parsable amount
 *   - the caller-approved terms (pay_to, optional asset/network) — F3
 *   - the MANDATORY max_payment_eth cap (and operator ceiling) in the
 *     selected asset's base units
 *   - SpendingPolicy reserve on approve, commit on payment, release if unused
 *   - the outbound transport: every hop (the unpaid probe and the paid retry)
 *     goes through one pinned, byte-capped safe transport (F8, F15). The SDK's
 *     own fetch() would use globalThis.fetch, so the probe is made here and
 *     the challenge is handed to settle402AndRetry with the same transport.
 */
import { createX402Client, type X402TransactionLog } from 'agentwallet-sdk'
import type { AgentWalletInstance } from './client.js'
import { supportedX402NetworksForChainId } from './x402-networks.js'
import {
  assertPayableX402Recipient,
  assertParsableX402Amount,
  assertPaymentCap,
  assertX402TermsApproved,
  effectiveCapBaseUnits,
  resolveX402AssetDecimals,
  type ApprovedX402Terms,
} from './payment-cap.js'
import type { OutboundFetch } from './safe-fetch.js'
import {
  commitSpendReservation,
  lockSpendReservation,
  releaseSpendReservation,
  reserveSpendPolicy,
  type SpendReservation,
} from '../tools/budget.js'
import { DefiniteSpendFailure } from './spend-intent.js'

export type AgentPayX402Kind = 'payment' | 'session'

export interface AgentPayX402ClientOptions {
  chainId: number
  /** Mandatory per-call cap (human amount in the selected asset). */
  maxPaymentEth: string
  /** Mandatory caller-approved terms. */
  approved: ApprovedX402Terms
  /** Pinned, byte-capped transport for every hop of this call. */
  transport: OutboundFetch
  kind?: AgentPayX402Kind
  onPaymentComplete?: (log: X402TransactionLog) => void
}

export interface AgentPayX402Fetcher {
  fetch: (_url: string, _init?: RequestInit) => Promise<Response>
}

export interface AgentPayX402Client {
  client: AgentPayX402Fetcher
  releaseUnusedReservation: () => void
  lockUnusedReservation: () => void
  /**
   * Drop a hold that never reached onPaymentComplete.
   * Definite pre-broadcast failures release so the cap can be retried.
   * Any other error may be post-broadcast — lock, never auto-unlock.
   */
  disposeUnusedReservation: (_error?: unknown) => void
}

function capExceededMessage(
  kind: AgentPayX402Kind,
  amount: bigint,
  maxRaw: bigint,
  asset: string | undefined,
  cap: string
): string {
  if (kind === 'session') {
    return (
      `Session payment (${amount} base units) exceeds max_payment_eth cap ` +
      `(${maxRaw} base units for asset ${asset} = ${cap}). ` +
      `Set a higher max_payment_eth to proceed.`
    )
  }
  return (
    `Payment required (${amount} base units) exceeds max_payment_eth cap ` +
    `(${maxRaw} base units for asset ${asset} = ${cap}). ` +
    `Increase max_payment_eth or the payment will not proceed.`
  )
}

function policyBlockedMessage(
  kind: AgentPayX402Kind,
  status: string,
  reason?: string
): string {
  if (reason) {
    return reason
  }
  if (kind === 'session') {
    return `Session payment blocked by spend policy (${status}).`
  }
  return `x402 payment blocked by spend policy (${status}).`
}

/**
 * Create the shared x402 client used by paid fetch and session start.
 */
export function createAgentPayX402Client(
  wallet: AgentWalletInstance,
  options: AgentPayX402ClientOptions
): AgentPayX402Client {
  const kind = options.kind ?? 'payment'
  const cap = assertPaymentCap(options.maxPaymentEth)
  const approvedPayTo = assertPayableX402Recipient(options.approved.payTo)
  let reservation: SpendReservation | null = null

  const sdk = createX402Client(wallet, {
    autoPay: true,
    maxRetries: 1,
    supportedNetworks: supportedX402NetworksForChainId(options.chainId),
    onBeforePayment: async (req) => {
      try {
        // The 402's payTo is remote-controlled and ends up inside error
        // messages (SDK allowlist rejection, viem InvalidAddressError).
        // Reject non-addresses before signing or interpolating.
        const merchant = assertPayableX402Recipient(req.payTo)
        assertX402TermsApproved(req, { ...options.approved, payTo: approvedPayTo })
        // req.amount is remote-controlled; a raw BigInt() here would put the
        // whole value verbatim into V8's "Cannot convert <amount> to a
        // BigInt" message.
        const amount = assertParsableX402Amount(req.amount)
        if (amount === 0n) {
          throw new DefiniteSpendFailure('x402 payment amount is zero; refusing to sign.')
        }
        // The cap is mandatory: there is no code path that signs without it.
        const maxRaw = effectiveCapBaseUnits(cap, req.asset, options.chainId)
        if (amount > maxRaw) {
          throw new DefiniteSpendFailure(
            capExceededMessage(kind, amount, maxRaw, req.asset, cap)
          )
        }

        // amount is in the offered asset's base units; the decimals thunk
        // only runs when a policy is configured, and resolution failures
        // reject (fail closed) inside reserveSpendPolicy.
        const { decision, reservation: reserved } = await reserveSpendPolicy({
          merchant,
          amount,
          decimals: () =>
            resolveX402AssetDecimals(
              req.asset ?? '0x0000000000000000000000000000000000000000',
              options.chainId
            ),
        })
        if (decision.status !== 'approved') {
          throw new DefiniteSpendFailure(
            policyBlockedMessage(kind, decision.status, decision.reason)
          )
        }
        reservation = reserved
        return true
      } catch (error: unknown) {
        // onBeforePayment runs before executePayment. Every failure here is
        // a definite not-charged outcome — never lock a hold that was never
        // exposed to a wallet write.
        if (error instanceof DefiniteSpendFailure) {
          throw error
        }
        throw new DefiniteSpendFailure(
          error instanceof Error ? error.message : String(error)
        )
      }
    },
    onPaymentComplete: (log) => {
      commitSpendReservation(reservation)
      reservation = null
      options.onPaymentComplete?.(log)
    },
  })

  const transport = options.transport
  // The SDK types its fetch hook like global fetch; we only ever pass URLs.
  const sdkTransport = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (typeof input !== 'string' && !(input instanceof URL)) {
      return Promise.reject(new TypeError('safe transport accepts URL strings only'))
    }
    return transport(input.toString(), init)
  }
  const client: AgentPayX402Fetcher = {
    async fetch(url: string, init: RequestInit = {}) {
      // Never follow redirects automatically: a 3xx is returned as-is, and
      // the SDK refuses to pay a challenge reached through one.
      const hopInit: RequestInit = { ...init, redirect: 'manual' }
      const probe = await transport(url, hopInit)
      if (probe.status !== 402) {
        return probe
      }
      return sdk.settle402AndRetry(probe, url, hopInit, sdkTransport)
    },
  }

  return {
    client,
    releaseUnusedReservation() {
      releaseSpendReservation(reservation)
      reservation = null
    },
    lockUnusedReservation() {
      lockSpendReservation(reservation)
      reservation = null
    },
    disposeUnusedReservation(error?: unknown) {
      if (!error || error instanceof DefiniteSpendFailure) {
        releaseSpendReservation(reservation)
      } else {
        lockSpendReservation(reservation)
      }
      reservation = null
    },
  }
}
