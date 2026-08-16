/**
 * Tests for max_payment_eth → asset base-unit conversion.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('agentwallet-sdk', () => ({
  getGlobalRegistry: vi.fn(() => ({
    getTokenByAddress: (address: string, chainId: number) => {
      if (
        chainId === 8453 &&
        address.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
      ) {
        return { symbol: 'USDC', decimals: 6, address, chainId }
      }
      return undefined
    },
    getToken: (symbol: string, chainId: number) => {
      if (symbol === 'USDC' && chainId === 8453) {
        return {
          symbol: 'USDC',
          decimals: 6,
          address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          chainId,
        }
      }
      return undefined
    },
  })),
}))

import { maxPaymentBaseUnits } from '../src/utils/payment-cap.js'

describe('maxPaymentBaseUnits', () => {
  it('converts USDC caps with 6 decimals (not ETH-wei)', () => {
    // Old bug: "0.01" * 1e18 = 1e16, which fails to cap a 500 USDC demand.
    // Correct: "0.01" USDC = 10000 base units.
    expect(
      maxPaymentBaseUnits(
        '0.01',
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        8453
      )
    ).toBe(10_000n)
  })

  it('resolves USDC by symbol', () => {
    expect(maxPaymentBaseUnits('1', 'USDC', 8453)).toBe(1_000_000n)
  })

  it('uses 18 decimals for native ETH', () => {
    expect(
      maxPaymentBaseUnits(
        '0.01',
        '0x0000000000000000000000000000000000000000',
        8453
      )
    ).toBe(10_000_000_000_000_000n)
  })
})
