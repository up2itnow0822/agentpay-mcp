/**
 * payment-cap.ts — Convert max_payment_eth human amounts into token base units.
 *
 * x402 payment demands use the selected asset's base units (e.g. 6 decimals for
 * USDC). Comparing those amounts against ETH-wei (×1e18) silently disables the
 * cap for stablecoin payments.
 */
import type { Address } from 'viem'
import { getGlobalRegistry } from 'agentwallet-sdk'
import { parseTokenAmount, resolveTokenDecimals } from '../tools/payments.js'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

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
