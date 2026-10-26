/**
 * F2 (review follow-up): a caller-registered token cannot claim decimals the
 * contract does not report, so registry decimals stay authoritative for
 * send_payment / send_token / x402 caps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const readContract = vi.hoisted(() => vi.fn())
const agentTransferToken = vi.hoisted(() => vi.fn())

vi.mock('../src/utils/client.js', () => ({
  getConfig: vi.fn(() => ({ chainId: 8453, walletAddress: '0x1234567890123456789012345678901234567890' })),
  getWallet: vi.fn(() => ({
    address: '0x1234567890123456789012345678901234567890',
    publicClient: { readContract },
    walletClient: {},
  })),
  _resetSingletons: vi.fn(),
}))

vi.mock('agentwallet-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('agentwallet-sdk')>()
  return { ...actual, agentTransferToken }
})

import { handleAddCustomToken, _resetCustomTokenQuota } from '../src/tools/tokens.js'
import { handleSendPayment } from '../src/tools/payments.js'
import { _setDecimalsVerifierOverride } from '../src/utils/test-seams.js'
import { _resetSpendIntentStore } from '../src/utils/spend-intent.js'

// A real 6-decimal token address not in the built-in registry (unique per test run).
const TOKEN = '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42' as const

beforeEach(() => {
  _setDecimalsVerifierOverride(undefined) // use the real on-chain check
  _resetCustomTokenQuota()
  _resetSpendIntentStore()
  readContract.mockReset().mockResolvedValue(6)
  agentTransferToken.mockReset().mockResolvedValue('0x' + 'ab'.repeat(32))
})

describe('add_custom_token on-chain decimals verification', () => {
  it('refuses to register a 6-decimal token as 18 decimals', async () => {
    const result = await handleAddCustomToken({
      symbol: 'EURCX',
      address: TOKEN,
      decimals: 18,
      chainId: 8453,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('does not match')
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: TOKEN, functionName: 'decimals' }))

    // The inflation path from the review: the follow-up payment must be
    // denominated in the contract's real 6 decimals.
    const pay = await handleSendPayment({
      to: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      amount_eth: '1',
      token: TOKEN,
    })
    expect(pay.isError).toBeFalsy()
    expect(agentTransferToken.mock.calls[0]![1].amount).toBe(1_000_000n)
  })

  it('refuses tokens on a chain other than the configured one, and unreadable contracts', async () => {
    const otherChain = await handleAddCustomToken({ symbol: 'XC', address: TOKEN, decimals: 6, chainId: 84532 })
    expect(otherChain.isError).toBe(true)
    readContract.mockRejectedValueOnce(new Error('execution reverted'))
    const unreadable = await handleAddCustomToken({ symbol: 'XD', address: TOKEN, decimals: 6, chainId: 8453 })
    expect(unreadable.isError).toBe(true)
  })

  it('registers when the claimed decimals match the contract', async () => {
    const ok = await handleAddCustomToken({ symbol: 'EURCY', address: TOKEN, decimals: 6, chainId: 8453 })
    expect(ok.isError).toBeUndefined()
  })
})
