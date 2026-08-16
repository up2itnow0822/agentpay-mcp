/**
 * Tests for create_escrow tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

vi.mock('agentwallet-sdk', () => ({
  MutualStakeEscrow: vi.fn(),
  SpendingPolicy: vi.fn(),
  checkBudget: vi.fn(),
}))

// ─── Mock client utils ─────────────────────────────────────────────────────

vi.mock('../src/utils/client.js', () => ({
  getConfig: vi.fn(() => ({
    chainId: 8453,
    walletAddress: '0x1234567890123456789012345678901234567890',
    factoryAddress: '0xfactory0000000000000000000000000000000001',
  })),
  getWallet: vi.fn(() => ({
    address: '0x1234567890123456789012345678901234567890',
    publicClient: {},
    walletClient: { account: { address: '0xbuyer000000000000000000000000000000000001' } },
    chain: { id: 8453 },
  })),
}))

import { handleCreateEscrow } from '../src/tools/escrow.js'
import { handleSetSpendPolicy, _resetPolicyStore } from '../src/tools/budget.js'
import { MutualStakeEscrow, SpendingPolicy } from 'agentwallet-sdk'

const MockMutualStakeEscrow = vi.mocked(MutualStakeEscrow)
const MockSpendingPolicy = vi.mocked(SpendingPolicy)

describe('create_escrow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
  })

  it('creates an escrow successfully with factory from config', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      address: '0xvault000000000000000000000000000000000001',
      txHash: '0xescrowtx123',
    })
    MockMutualStakeEscrow.mockImplementation(function() { return { create: mockCreate } } as any)

    const result = await handleCreateEscrow({
      counterpartyAddress: '0xseller00000000000000000000000000000000001',
      stakeAmount: '100',
      terms: 'Build a website for 100 USDC',
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.success).toBe(true)
    expect(data.vaultAddress).toBe('0xvault000000000000000000000000000000000001')
    expect(data.txHash).toBe('0xescrowtx123')
    expect(data.seller).toBe('0xseller00000000000000000000000000000000001')
    expect(data.paymentAmount).toBe('100')
    expect(data.terms).toBe('Build a website for 100 USDC')

    expect(MockMutualStakeEscrow).toHaveBeenCalledWith(
      expect.objectContaining({
        factoryAddress: '0xfactory0000000000000000000000000000000001',
        chainId: 8453,
      })
    )
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        seller: '0xseller00000000000000000000000000000000001',
        paymentAmount: 100000000n,
        buyerStake: 100000000n,
        sellerStake: 100000000n,
        verifier: 'optimistic',
      })
    )
  })

  it('uses factoryAddress param over config', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      address: '0xvault000000000000000000000000000000000002',
      txHash: '0xescrowtx456',
    })
    MockMutualStakeEscrow.mockImplementation(function() { return { create: mockCreate } } as any)

    await handleCreateEscrow({
      counterpartyAddress: '0xseller00000000000000000000000000000000001',
      stakeAmount: '50',
      terms: 'Custom terms',
      factoryAddress: '0xcustomfactory000000000000000000000000001',
    })

    expect(MockMutualStakeEscrow).toHaveBeenCalledWith(
      expect.objectContaining({
        factoryAddress: '0xcustomfactory000000000000000000000000001',
      })
    )
  })

  it('returns error for invalid stakeAmount', async () => {
    MockMutualStakeEscrow.mockImplementation(function() { return { create: vi.fn() } } as any)

    const result = await handleCreateEscrow({
      counterpartyAddress: '0xseller00000000000000000000000000000000001',
      stakeAmount: 'not-a-number',
      terms: 'Bad amount test',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('create_escrow failed')
  })

  it('rejects comma-formatted stakeAmount ("1,000") instead of parsing it as 1 USDC', async () => {
    const mockCreate = vi.fn()
    MockMutualStakeEscrow.mockImplementation(function() { return { create: mockCreate } } as any)

    const result = await handleCreateEscrow({
      counterpartyAddress: '0xseller00000000000000000000000000000000001',
      stakeAmount: '1,000',
      terms: 'Escrow for 1,000 USDC',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Invalid stakeAmount: "1,000"')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects exponent, hex, multi-dot, empty, and negative stakeAmounts', async () => {
    const mockCreate = vi.fn()
    MockMutualStakeEscrow.mockImplementation(function() { return { create: mockCreate } } as any)

    for (const bad of ['1e3', '0x10', '1.2.3', '', '-5']) {
      const result = await handleCreateEscrow({
        counterpartyAddress: '0xseller00000000000000000000000000000000001',
        stakeAmount: bad,
        terms: 'Bad amount test',
      })

      expect(result.isError, `stakeAmount "${bad}" should be rejected`).toBe(true)
      expect(result.content[0].text).toContain('Invalid stakeAmount')
    }
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('rejects stakeAmount with more than 6 decimal places', async () => {
    const mockCreate = vi.fn()
    MockMutualStakeEscrow.mockImplementation(function() { return { create: mockCreate } } as any)

    const result = await handleCreateEscrow({
      counterpartyAddress: '0xseller00000000000000000000000000000000001',
      stakeAmount: '0.0000001',
      terms: 'Sub-unit amount test',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Too many decimal places (max 6)')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('converts the minimum USDC unit exactly (0.000001 → 1 base unit)', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      address: '0xvault000000000000000000000000000000000003',
      txHash: '0xescrowtx789',
    })
    MockMutualStakeEscrow.mockImplementation(function() { return { create: mockCreate } } as any)

    const result = await handleCreateEscrow({
      counterpartyAddress: '0xseller00000000000000000000000000000000001',
      stakeAmount: '0.000001',
      terms: 'Minimum unit test',
    })

    expect(result.isError).toBeUndefined()
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentAmount: 1n,
        buyerStake: 1n,
        sellerStake: 1n,
      })
    )
  })

  it('accepts whitespace-padded stakeAmount (" 5 " → 5 USDC)', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      address: '0xvault000000000000000000000000000000000004',
      txHash: '0xescrowtxabc',
    })
    MockMutualStakeEscrow.mockImplementation(function() { return { create: mockCreate } } as any)

    const result = await handleCreateEscrow({
      counterpartyAddress: '0xseller00000000000000000000000000000000001',
      stakeAmount: ' 5 ',
      terms: 'Trim test',
    })

    expect(result.isError).toBeUndefined()
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ paymentAmount: 5000000n })
    )
  })

  it('returns error when escrow creation fails', async () => {
    const mockCreate = vi.fn().mockRejectedValue(new Error('Factory not deployed'))
    MockMutualStakeEscrow.mockImplementation(function() { return { create: mockCreate } } as any)

    const result = await handleCreateEscrow({
      counterpartyAddress: '0xseller00000000000000000000000000000000001',
      stakeAmount: '100',
      terms: 'Test terms',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('create_escrow failed')
    expect(result.content[0].text).toContain('Factory not deployed')
  })

  // ─── Spend policy enforcement ────────────────────────────────────────────

  it('blocks escrow creation when the counterparty is not allowlisted', async () => {
    const check = vi.fn().mockResolvedValue({
      status: 'rejected',
      reason:
        'Merchant "0xseller00000000000000000000000000000000001" is not on the allowlist.',
    })
    MockSpendingPolicy.mockImplementation(function () { return { check } } as any)

    const mockCreate = vi.fn()
    MockMutualStakeEscrow.mockImplementation(function() { return { create: mockCreate } } as any)

    await handleSetSpendPolicy({
      allowedRecipients: ['0x0000000000000000000000000000000000000001'],
    })

    const result = await handleCreateEscrow({
      counterpartyAddress: '0xseller00000000000000000000000000000000001',
      stakeAmount: '100',
      terms: 'Blocked escrow',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('allowlist')
    expect(mockCreate).not.toHaveBeenCalled()
    // Total buyer commitment = payment + equal buyer stake = 200 USDC
    // (6 decimals), normalised to 2e20 ETH-equivalent wei.
    expect(check).toHaveBeenCalledWith({
      merchant: '0xseller00000000000000000000000000000000001',
      amount: 2e20,
    })
  })

  it('blocks escrow creation when the spend cap is exceeded', async () => {
    const check = vi.fn().mockResolvedValue({
      status: 'rejected',
      reason: 'Rolling spend cap exceeded: spent 0, cap 1e20, attempted 2e20.',
    })
    MockSpendingPolicy.mockImplementation(function () { return { check } } as any)

    const mockCreate = vi.fn()
    MockMutualStakeEscrow.mockImplementation(function() { return { create: mockCreate } } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '100' })

    const result = await handleCreateEscrow({
      counterpartyAddress: '0xseller00000000000000000000000000000000001',
      stakeAmount: '100',
      terms: 'Over-cap escrow',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Rolling spend cap exceeded')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates the escrow when the spend policy approves', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'approved' })
    MockSpendingPolicy.mockImplementation(function () { return { check } } as any)

    const mockCreate = vi.fn().mockResolvedValue({
      address: '0xvault000000000000000000000000000000000003',
      txHash: '0xescrowtx789',
    })
    MockMutualStakeEscrow.mockImplementation(function() { return { create: mockCreate } } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '1000' })

    const result = await handleCreateEscrow({
      counterpartyAddress: '0xseller00000000000000000000000000000000001',
      stakeAmount: '100',
      terms: 'Approved escrow',
    })

    expect(result.isError).toBeUndefined()
    expect(check).toHaveBeenCalledOnce()
    expect(mockCreate).toHaveBeenCalledOnce()
  })
})
