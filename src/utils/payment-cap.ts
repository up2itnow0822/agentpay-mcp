/**
 * payment-cap.ts — Convert max_payment_eth human amounts into token base units.
 *
 * x402 payment demands use the selected asset's base units (e.g. 6 decimals for
 * USDC). Comparing those amounts against ETH-wei (×1e18) silently disables the
 * cap for stablecoin payments.
 */
import { isAddress, zeroAddress, type Address } from 'viem'
import { getGlobalRegistry } from 'agentwallet-sdk'
import { parseTokenAmount, resolveTokenDecimals } from '../tools/payments.js'
import { sanitizeUntrustedInline } from './format.js'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

/**
 * Validate a server-supplied x402 `payTo` before it is used or echoed.
 *
 * `accepts[].payTo` is fully remote-controlled. Downstream consumers embed it
 * verbatim in error messages — the SDK's SpendingPolicy allowlist rejection
 * (`Merchant "<payTo>" is not on the allowlist.`) and viem's
 * `InvalidAddressError` both do — which turns any multi-line payTo into an
 * injection channel in the tool result. It is also the address the payment
 * would be signed to, so anything that is not a well-formed EVM address must
 * fail closed here, before signing and before interpolation.
 *
 * ## The validated value must be the value paid
 *
 * This guard runs inside `onBeforePayment`, which the SDK calls with the
 * *selected* payment requirement object. Approving is not the end of the
 * story: `X402Client.executePayment(req)` then reads `req.payTo` again and
 * hands the RAW string to `agentTransferToken(..., { to: req.payTo })`
 * (agentwallet-sdk 6.3.0, dist/x402/client.js). Nothing this function returns
 * reaches the signer — the callers use the return value only for the spend
 * policy and the cap.
 *
 * So normalising here and returning the normalised form would validate one
 * value and pay another. That is not hypothetical damage: `executePayment`
 * transfers the 0.77% protocol fee on-chain *before* it encodes the payee, so
 * a payTo that we accept but viem's ABI encoder rejects burns real funds and
 * consumes on-chain budget, then throws.
 *
 * The fix is to accept only values that are already canonical, so "validated"
 * and "signed" are byte-identical by construction:
 *   - no `trim()`. Padding is rejected, not silently removed. A hostile server
 *     has no legitimate reason to send it, and a legitimate one does not.
 *   - `isAddress` with its default `strict: true`, which is exactly the test
 *     viem's `encodeAddress` applies when the transfer is encoded. Accepting a
 *     mis-checksummed address here would only mean failing later, after the
 *     fee transfer. (All-lowercase addresses still pass — viem's strict mode
 *     only checks casing when the value is mixed-case.)
 *
 * The alternative — writing the normalised value back onto the SDK's `req`
 * object so it flows onward — was rejected: it mutates a foreign object whose
 * re-read points are an implementation detail of a pinned dependency, and it
 * would silently "repair" hostile input instead of refusing it.
 *
 * The value is never echoed raw: the diagnostic quotes a sanitized, capped
 * form so the rejection itself cannot carry the payload.
 */
export function assertPayableX402Recipient(payTo: string | undefined): Address {
  // No normalisation: `candidate` is the exact string the SDK will sign to.
  // Non-strings can reach here via JSON.parse despite the declared type.
  const candidate = typeof payTo === 'string' ? payTo : ''
  if (!isAddress(candidate)) {
    throw new Error(
      `x402 payment recipient is not a valid EVM address: ` +
        `"${sanitizeUntrustedInline(payTo, 48)}". ` +
        'AgentPay failed closed and did not sign a payment.'
    )
  }
  // Syntactically valid is not payable: the zero address burns the principal
  // (or reverts after the protocol fee already left the wallet). The buyer
  // verifier in x402-buyer-flow.ts already encodes this invariant (F5).
  if (candidate.toLowerCase() === zeroAddress) {
    throw new Error(
      'x402 payment recipient is the zero address. AgentPay failed closed and did not sign a payment.'
    )
  }
  return candidate as Address
}

/**
 * Terms the caller approved before any payment may be signed.
 * `payTo` is mandatory; `asset` and `network` are optional extra bindings.
 */
export interface ApprovedX402Terms {
  payTo: string
  asset?: string
  network?: string
}

/** Canonical Circle USDC per supported chain — the default x402 asset. */
export const X402_DEFAULT_ASSET_BY_CHAIN: Readonly<Record<number, Address>> = Object.freeze({
  8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
})

/** The asset an x402 payment is bound to when the caller names none. */
export function defaultX402Asset(chainId: number): Address {
  const asset = X402_DEFAULT_ASSET_BY_CHAIN[chainId]
  if (!asset) {
    throw new Error(`No default x402 asset for chain ${chainId}; pass asset explicitly.`)
  }
  return asset
}

/**
 * Canonical comparison form for an x402 asset on the configured chain:
 * a lower-cased contract address. Symbols resolve through the token
 * registry; anything unresolvable stays as-is (and so never matches an
 * address).
 */
function canonicalAsset(asset: string, chainId: number): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(asset)) return asset.toLowerCase()
  const bySymbol = getGlobalRegistry().getToken(asset.toUpperCase(), chainId)
  return (bySymbol?.address ?? asset).toLowerCase()
}

/** Same floor division as the SDK settlement client (0.77%). */
export const X402_PROTOCOL_FEE_BPS = 77n

/** What the wallet actually debits for an x402 payment: principal + fee. */
export function x402Debit(amount: bigint): bigint {
  return amount + (amount * X402_PROTOCOL_FEE_BPS) / 10000n
}

/**
 * Bind the remote-selected payment requirement to the caller's approval.
 * Every comparison runs on the exact values the SDK will sign (F3): a 402
 * that changes payee, asset, or network after approval is refused before
 * any fee or principal write.
 */
export function assertX402TermsApproved(
  req: { payTo?: string; asset?: string; network?: string },
  approved: ApprovedX402Terms,
  chainId: number
): void {
  const payTo = typeof req.payTo === 'string' ? req.payTo : ''
  if (payTo.toLowerCase() !== approved.payTo.toLowerCase()) {
    throw new Error(
      `x402 payee "${sanitizeUntrustedInline(payTo, 48)}" does not match the approved pay_to ` +
        `${approved.payTo}. AgentPay failed closed and did not sign a payment.`
    )
  }
  const network = typeof req.network === 'string' ? req.network : ''
  if (approved.network !== undefined && network.toLowerCase() !== approved.network.toLowerCase()) {
    throw new Error(
      `x402 network "${sanitizeUntrustedInline(network, 48)}" does not match the approved network ` +
        `"${sanitizeUntrustedInline(approved.network, 48)}". AgentPay did not sign a payment.`
    )
  }
  {
    // The asset is ALWAYS bound: an unnamed asset means the chain's USDC, so
    // a cap the caller meant in USDC can never be applied to 1 WETH (F3).
    const approvedAsset = approved.asset ?? defaultX402Asset(chainId)
    const offered = typeof req.asset === 'string' ? req.asset : ''
    if (canonicalAsset(offered, chainId) !== canonicalAsset(approvedAsset, chainId)) {
      throw new Error(
        `x402 asset "${sanitizeUntrustedInline(offered, 48)}" does not match the approved asset ` +
          `"${sanitizeUntrustedInline(approvedAsset, 48)}". AgentPay did not sign a payment.`
      )
    }
  }
}

/** Operator-wide ceiling applied on top of every per-call cap. */
export const X402_OPERATOR_MAX_PAYMENT_ENV = 'AGENTPAY_X402_MAX_PAYMENT'

/**
 * Validate a mandatory human-readable cap: plain positive decimal only.
 * Returns the trimmed string.
 */
export function assertPaymentCap(raw: string | undefined, field = 'max_payment_eth'): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!/^\d+(\.\d+)?$/.test(value) || !/[1-9]/.test(value)) {
    throw new Error(
      `${field} is required and must be a positive decimal amount (e.g. "0.01"). ` +
        'AgentPay never signs an x402 payment without an explicit cap.'
    )
  }
  return value
}

/**
 * Effective cap in the selected asset's base units: the smaller of the
 * caller's cap and the operator ceiling (if configured).
 *
 * The operator ceiling is denominated in USDC. When it is set, a payment in
 * any other asset is refused outright — a unitless ceiling of "1" must never
 * admit 1 WETH.
 */
export function effectiveCapBaseUnits(
  callerCap: string,
  asset: string | undefined,
  chainId: number
): bigint {
  const callerRaw = maxPaymentBaseUnits(callerCap, asset, chainId)
  const operator = process.env[X402_OPERATOR_MAX_PAYMENT_ENV]?.trim()
  if (!operator) return callerRaw
  const ceiling = assertPaymentCap(operator, X402_OPERATOR_MAX_PAYMENT_ENV)
  const usdc = X402_DEFAULT_ASSET_BY_CHAIN[chainId]
  if (!usdc || canonicalAsset(asset ?? '', chainId) !== usdc.toLowerCase()) {
    throw new Error(
      `${X402_OPERATOR_MAX_PAYMENT_ENV} is denominated in USDC; refusing a payment in ` +
        `"${sanitizeUntrustedInline(asset, 48)}". AgentPay did not sign a payment.`
    )
  }
  const operatorRaw = maxPaymentBaseUnits(ceiling, usdc, chainId)
  return operatorRaw < callerRaw ? operatorRaw : callerRaw
}

/**
 * Validate a server-supplied x402 `amount` before it is parsed or echoed.
 *
 * `accepts[].amount` is fully remote-controlled and is fed to `BigInt()`,
 * whose V8 failure message interpolates the whole value verbatim and
 * untruncated (`Cannot convert <amount> to a BigInt`). The SDK reaches that
 * call inside `X402Client.fetch` *before* `onBeforePayment` runs, so this
 * guard cannot pre-empt the first parse — `formatError` fences that message
 * instead. What this does cover is the SDK's second parse, in
 * `executePayment`, plus any future caller that validates before signing.
 *
 * Fails closed on anything that is not a non-negative integer literal.
 *
 * Like `assertPayableX402Recipient`, this does not normalise. The SDK re-reads
 * `req.amount` and re-parses it with a bare `BigInt(req.amount)` in
 * `executePayment`, so the value we cap and hand to the spend policy must be
 * the raw string, not a cleaned-up copy of it. `BigInt()` happens to skip
 * leading/trailing whitespace too, so trimming was not yet an exploitable
 * divergence — but "the two parsers agree today" is luck, and the invariant
 * worth holding is that there is only one string.
 */
export function assertParsableX402Amount(amount: string | undefined): bigint {
  // No normalisation: this is the exact string the SDK will re-parse.
  const candidate = typeof amount === 'string' ? amount : ''
  if (!/^\d+$/.test(candidate)) {
    throw new Error(
      `x402 payment amount is not a non-negative integer in base units: ` +
        `"${sanitizeUntrustedInline(amount, 48)}". ` +
        'AgentPay failed closed and did not sign a payment.'
    )
  }
  return BigInt(candidate)
}

/**
 * Resolve decimals for an x402 asset (address or symbol) on the active chain.
 *
 * Also on the validated-value/used-value seam: `asset` is remote-controlled,
 * and the decimals resolved here set the scale of the `max_payment_eth` cap,
 * while the SDK resolves the token *contract* from the raw `req.asset` via
 * `resolveAssetAddress` — which does not trim either. Trimming here would let
 * a padded asset be capped in one token's decimals while the SDK resolved a
 * different one (or, today, silently declined to resolve it at all). Match the
 * SDK exactly instead: raw string, upper-cased for the symbol lookup only,
 * exactly as `resolveAssetAddress` does it.
 */
export function resolveX402AssetDecimals(asset: string, chainId: number): number {
  if (/^0x[a-fA-F0-9]{40}$/.test(asset)) {
    return resolveTokenDecimals(asset as Address, undefined, chainId)
  }

  const symbol = asset.toUpperCase()
  const bySymbol = getGlobalRegistry().getToken(symbol, chainId)
  if (bySymbol) return bySymbol.decimals

  // Native gas token symbols default to 18.
  if (['ETH', 'POL', 'AVAX', 'S'].includes(symbol)) return 18

  throw new Error(
    `Cannot resolve decimals for x402 asset "${sanitizeUntrustedInline(asset, 48)}" ` +
      `on chain ${chainId}. Register the token or omit max_payment_eth.`
  )
}

/**
 * Convert a human-readable max_payment_eth value into base units for `asset`.
 */
export function maxPaymentBaseUnits(
  maxPaymentEth: string,
  asset: string | undefined,
  chainId: number
): bigint {
  const decimals = resolveX402AssetDecimals(asset ?? ZERO_ADDRESS, chainId)
  return parseTokenAmount(maxPaymentEth, decimals)
}
