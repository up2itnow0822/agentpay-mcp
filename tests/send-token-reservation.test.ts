/**
 * Codex P2: send_token reserves policy capacity and RELEASES it on a definite
 * pre-broadcast failure, so a transfer equal to the remaining daily allowance
 * can be retried. Runs the real SDK SpendingPolicy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/utils/wallet-binding.js', () => ({
  assertExpectedSmartWallet: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/utils/agent-transfer-outcome.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/agent-transfer-outcome.js')>()
  return {
    ...actual,
    agentTransferTokenWithOutcome: vi.fn(async (wallet: unknown, params: unknown) => {
      const hash = await agentTransferToken(wallet as never, params as never)
      return { status: 'executed', txHash: hash as `0x${string}` }
    }),
  }
})

const agentTransferToken = vi.hoisted(() => vi.fn())

vi.mock('agentwallet-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('agentwallet-sdk')>()
  return { ...actual, agentTransferToken }
})

vi.mock('../src/utils/client.js', () => ({
  getConfig: vi.fn(() => ({ chainId: 8453, walletAddress: '0x1234567890123456789012345678901234567890' })),
  getWallet: vi.fn(() => ({
    address: '0x1234567890123456789012345678901234567890',
    publicClient: {},
    walletClient: { writeContract: async () => '0xwrite' },
  })),
  _resetSingletons: vi.fn(),
}))

import { handleSendToken } from '../src/tools/transfers.js'
import { handleSetSpendPolicy, _resetPolicyStore } from '../src/tools/budget.js'
import { _resetSpendIntentStore } from '../src/utils/spend-intent.js'

const SEND = {
  tokenSymbol: 'USDC',
  chainId: 8453,
  recipientAddress: '0x00000000000000000000000000000000000000a1',
  amount: '1',
}

beforeEach(() => {
  _resetPolicyStore()
  _resetSpendIntentStore()
  agentTransferToken.mockReset()
})

describe('send_token policy reservation', () => {
  it('a definite pre-broadcast failure releases the daily allowance for the retry', async () => {
    // Daily cap of exactly 1 (one whole USDC counts as 1 ETH-equivalent).
    expect((await handleSetSpendPolicy({ dailyLimitEth: '1' })).isError).toBeUndefined()

    agentTransferToken
      .mockRejectedValueOnce(new Error('execution reverted (simulation)')) // no wallet write
      .mockResolvedValueOnce('0x' + 'cd'.repeat(32))

    const failed = await handleSendToken(SEND)
    expect(failed.isError).toBe(true)

    const retry = await handleSendToken(SEND)
    expect(retry.isError).toBeUndefined()
    expect(JSON.parse(retry.content[0]!.text).txHash).toBe('0x' + 'cd'.repeat(32))

    // The allowance is now actually spent: a third transfer is refused.
    const third = await handleSendToken({ ...SEND, idempotencyKey: 'another-invoice' })
    expect(third.isError).toBe(true)
    expect(agentTransferToken).toHaveBeenCalledTimes(2)
  })
})
