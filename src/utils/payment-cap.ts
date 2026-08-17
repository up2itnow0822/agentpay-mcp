/**
 * payment-cap.ts — Convert max_payment_eth human amounts into token base units.
 *
 * x402 payment demands use the selected asset's base units (e.g. 6 decimals for
 * USDC). Comparing those amounts against ETH-wei (×1e18) silently disables the
 * cap for stablecoin payments.
 */
import { isAddress, type Address } from 'viem'
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
 * (agentwallet-sdk 6.2.1, dist/x402/client.js). Nothing this function returns
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
  return candidate as Address
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
