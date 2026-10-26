/**
 * Tests for create_escrow tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

vi.mock('agentwallet-sdk', () => ({
  MutualStakeEscrow: vi.fn(),
  SpendingPolicy: vi.fn(),
  checkBudget: vi.fn(),
  isEvmTxHash: (value: unknown) =>
    typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value),
  classifySpendError: (error: unknown) => ({
    status: 'released' as const,
    retrySafe: true,
    txHashes: [] as string[],
    reason: error instanceof Error ? error.message : String(error ?? ''),
  }),
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
import { _resetSpendIntentStore } from '../src/utils/spend-intent.js'
import { MutualStakeEscrow, SpendingPolicy } from 'agentwallet-sdk'
import { policyEngine, reservedResult } from './helpers/policy-engine.js'

const MockMutualStakeEscrow = vi.mocked(MutualStakeEscrow)
const MockSpendingPolicy = vi.mocked(SpendingPolicy)

describe('create_escrow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
    _resetSpendIntentStore()
  })

  it('creates an escrow successfully with factory from config', async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      address: '0xvault000000000000000000000000000000000001',
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
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
    expect(data.txHash).toBe('0x1111111111111111111111111111111111111111111111111111111111111111')
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
      txHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
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
      txHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
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
      txHash: '0x4444444444444444444444444444444444444444444444444444444444444444',
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
    MockSpendingPolicy.mockImplementation(function () { return policyEngine(check) } as any)

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
    // (6 decimals), normalised to 2e11 9-decimal policy units.
    expect(check).toHaveBeenCalledWith({
      merchant: '0xseller00000000000000000000000000000000001',
      amount: 2e11,
    })
  })

  it('blocks escrow creation when the spend cap is exceeded', async () => {
    const check = vi.fn().mockResolvedValue({
      status: 'rejected',
      reason: 'Rolling spend cap exceeded: spent 0, cap 1e11, attempted 2e11.',
    })
    MockSpendingPolicy.mockImplementation(function () { return policyEngine(check) } as any)

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
    const check = vi.fn().mockResolvedValue(reservedResult())
    MockSpendingPolicy.mockImplementation(function () { return policyEngine(check) } as any)

    const mockCreate = vi.fn().mockResolvedValue({
      address: '0xvault000000000000000000000000000000000003',
      txHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
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

describe('create_escrow spend-intent contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
    _resetSpendIntentStore()
  })

  const input = {
    counterpartyAddress: '0x00000000000000000000000000000000000000c0',
    stakeAmount: '5',
    terms: 'deliver report',
    deadlineDays: 7,
    challengeWindowHours: 24,
  }

  it('replays a duplicate delivery instead of creating a second vault', async () => {
    const create = vi.fn().mockResolvedValue({ address: '0xvault', txHash: '0x' + '55'.repeat(32) })
    MockMutualStakeEscrow.mockImplementation(function () { return { create } } as any)
    const a = await handleCreateEscrow({ ...input, idempotencyKey: 'deal-1' })
    const b = await handleCreateEscrow({ ...input, idempotencyKey: 'deal-1' })
    expect(a.isError).toBeUndefined()
    expect(JSON.parse(b.content[0].text).idempotentRetry).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('locks after a hashless result rather than creating again', async () => {
    const create = vi.fn().mockResolvedValue({ address: '0xvault', txHash: 'pending' })
    MockMutualStakeEscrow.mockImplementation(function () { return { create } } as any)
    expect((await handleCreateEscrow(input)).isError).toBe(true)
    const retry = await handleCreateEscrow(input)
    expect(retry.content[0].text).toContain('did not return a transaction hash')
    expect(create).toHaveBeenCalledTimes(1)
  })
})

