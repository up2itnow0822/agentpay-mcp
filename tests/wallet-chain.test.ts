/**
 * Tests for wallet-chain binding helpers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/utils/client.js', () => ({
  getConfig: vi.fn(),
}))

import { getConfig } from '../src/utils/client.js'
import {
  assertConfiguredChain,
  assertConfiguredBridgeSource,
} from '../src/utils/wallet-chain.js'

const mockGetConfig = vi.mocked(getConfig)

describe('assertConfiguredChain', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetConfig.mockReturnValue({ chainId: 8453 } as ReturnType<typeof getConfig>)
  })

  it('returns the wallet chain when the caller matches', () => {
    expect(assertConfiguredChain(8453)).toBe(8453)
  })

  it('rejects Optimism (WETH 0x4200…0006 collides with Base)', () => {
    expect(() => assertConfiguredChain(10)).toThrow(
      /Requested chainId 10 does not match the configured wallet chain 8453/
    )
  })

  it('rejects Ethereum mainnet', () => {
    expect(() => assertConfiguredChain(1)).toThrow(/chainId 1/)
  })
})

describe('assertConfiguredBridgeSource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows fromChain=base when the wallet is on Base Mainnet', () => {
    mockGetConfig.mockReturnValue({ chainId: 8453 } as ReturnType<typeof getConfig>)
    expect(() => assertConfiguredBridgeSource('base')).not.toThrow()
  })

  it('rejects fromChain=ethereum while the wallet is on Base', () => {
    mockGetConfig.mockReturnValue({ chainId: 8453 } as ReturnType<typeof getConfig>)
    expect(() => assertConfiguredBridgeSource('ethereum')).toThrow(
      /fromChain "ethereum" does not match the configured wallet chain \(base, 8453\)/
    )
  })

  it('rejects every CCTP source when the wallet is on Base Sepolia', () => {
    mockGetConfig.mockReturnValue({ chainId: 84532 } as ReturnType<typeof getConfig>)
    expect(() => assertConfiguredBridgeSource('base')).toThrow(
      /bridge_usdc cannot burn from chain 84532/
    )
  })
})
