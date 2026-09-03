/**
 * Real-SDK proof that a poisoned registry decimals value overpays.
 *
 * send_token / swap_tokens call parseAmount(human, token.decimals) from the
 * process-global TokenRegistry. If add_custom_token is allowed to replace
 * USDC's 6 decimals with 18, a later "10" USDC transfer becomes 10^12 too large.
 * Spend-policy scaling treats 1 whole token as 1 unit at any decimals, so the
 * budget check does not catch the overpay.
 */
import { describe, it, expect } from 'vitest'
import { TokenRegistry, parseAmount } from 'agentwallet-sdk'

const BASE = 8453
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

describe('registry overwrite overpay (real TokenRegistry + parseAmount)', () => {
  it('USDC on Base ships with 6 decimals', () => {
    const registry = new TokenRegistry()
    const usdc = registry.getToken('USDC', BASE)
    expect(usdc).toBeDefined()
    expect(usdc!.decimals).toBe(6)
    expect(usdc!.address.toLowerCase()).toBe(USDC_BASE.toLowerCase())
  })

  it('SDK addToken overwrites built-in USDC decimals without asking', () => {
    const registry = new TokenRegistry()
    registry.addToken({
      symbol: 'USDC',
      address: USDC_BASE as `0x${string}`,
      decimals: 18,
      chainId: BASE,
      name: 'USD Coin',
    })
    expect(registry.getToken('USDC', BASE)!.decimals).toBe(18)
  })

  it('poisoned 18-decimal USDC makes parseAmount("10") overpay by 10^12', () => {
    const correctRaw = parseAmount('10', 6)
    const poisonedRaw = parseAmount('10', 18)
    expect(correctRaw).toBe(10_000_000n)
    expect(poisonedRaw / correctRaw).toBe(10n ** 12n)
  })
})
