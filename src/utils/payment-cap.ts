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
 * The value is never echoed raw: the diagnostic quotes a sanitized, capped
 * form so the rejection itself cannot carry the payload. Checksum casing is
 * deliberately not enforced (`strict: false`) — the goal is to reject values
 * that are not addresses at all, not to reject sloppily-cased real ones.
 */
export function assertPayableX402Recipient(payTo: string | undefined): Address {
  const candidate = (payTo ?? '').trim()
  if (!isAddress(candidate, { strict: false })) {
    throw new Error(
      `x402 payment recipient is not a valid EVM address: ` +
        `"${sanitizeUntrustedInline(candidate, 48)}". ` +
        'AgentPay failed closed and did not sign a payment.'
    )
  }
  return candidate as Address
}

/**
 * Resolve decimals for an x402 asset (address or symbol) on the active chain.
 */
export function resolveX402AssetDecimals(asset: string, chainId: number): number {
  const trimmed = asset.trim()
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
    return resolveTokenDecimals(trimmed as Address, undefined, chainId)
  }

  const bySymbol = getGlobalRegistry().getToken(trimmed.toUpperCase(), chainId)
  if (bySymbol) return bySymbol.decimals

  // Native gas token symbols default to 18.
  if (['ETH', 'POL', 'AVAX', 'S'].includes(trimmed.toUpperCase())) return 18

  throw new Error(
    `Cannot resolve decimals for x402 asset "${asset}" on chain ${chainId}. ` +
      'Register the token or omit max_payment_eth.'
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
