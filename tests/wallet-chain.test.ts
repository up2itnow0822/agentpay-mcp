/**
 * Tests for wallet-chain fail-closed helpers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/utils/client.js', () => ({
  getConfig: vi.fn(() => ({
    chainId: 8453,
    walletAddress: '0x1234567890123456789012345678901234567890',
  })),
}))

import { getConfig } from '../src/utils/client.js'
import {
  getConfiguredChainId,
  assertConfiguredChain,
  assertConfiguredBridgeSource,
} from '../src/utils/wallet-chain.js'

const mockGetConfig = vi.mocked(getConfig)

describe('wallet-chain', () => {
  beforeEach(() => {
    mockGetConfig.mockReturnValue({
      chainId: 8453,
      walletAddress: '0x1234567890123456789012345678901234567890',
    } as any)
  })

  it('returns the configured CHAIN_ID', () => {
    expect(getConfiguredChainId()).toBe(8453)
  })

  it('allows a matching chainId', () => {
    expect(() => assertConfiguredChain(8453, 'send_token')).not.toThrow()
  })

  it('refuses a chainId the wallet cannot sign', () => {
    expect(() => assertConfiguredChain(10, 'send_token')).toThrow(
      /refusing chainId 10/
    )
  })

  it('allows bridge fromChain=base on Base mainnet', () => {
    expect(() => assertConfiguredBridgeSource('base', 'bridge_usdc')).not.toThrow()
  })

  it('refuses a CCTP source the wallet cannot sign', () => {
    expect(() => assertConfiguredBridgeSource('optimism', 'bridge_usdc')).toThrow(
      /refusing fromChain "optimism"/
    )
  })

  it('refuses base burns when the wallet is on Base Sepolia', () => {
    mockGetConfig.mockReturnValue({
      chainId: 84532,
      walletAddress: '0x1234567890123456789012345678901234567890',
    } as any)
    expect(() => assertConfiguredBridgeSource('base', 'bridge_usdc')).toThrow(
      /CHAIN_ID 84532/
    )
  })

  it('refuses an unrecognized bridge source', () => {
    expect(() => assertConfiguredBridgeSource('solana', 'bridge_usdc')).toThrow(
      /does not recognize source chain "solana"/
    )
  })
})
