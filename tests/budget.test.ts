/**
 * Tests for set_spend_policy and check_budget tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

vi.mock('agentwallet-sdk', () => ({
  SpendingPolicy: vi.fn(),
  checkBudget: vi.fn(),
}))

// ─── Mock client utils ─────────────────────────────────────────────────────

vi.mock('../src/utils/client.js', () => ({
  getWallet: vi.fn(() => ({
    address: '0x1234567890123456789012345678901234567890',
    publicClient: {},
    walletClient: {},
    contract: {},
    chain: { id: 8453 },
  })),
}))

import {
  handleSetSpendPolicy,
  handleCheckBudget,
  enforceSpendPolicy,
  _resetPolicyStore,
} from '../src/tools/budget.js'
import { SpendingPolicy, checkBudget } from 'agentwallet-sdk'

const MockSpendingPolicy = vi.mocked(SpendingPolicy)
const mockCheckBudget = vi.mocked(checkBudget)

describe('set_spend_policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
    // Must use function (not arrow) so it works as a constructor with `new`
    MockSpendingPolicy.mockImplementation(function() { return { check: vi.fn() } } as any)
  })

  it('creates a policy with daily limit and per-tx cap', async () => {
    const result = await handleSetSpendPolicy({
      scopeKey: 'session-1',
      dailyLimitEth: '0.1',
      perTxCapEth: '0.01',
      allowedRecipients: [],
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.success).toBe(true)
    expect(data.scopeKey).toBe('session-1')
    expect(data.policy.dailyLimitEth).toBe('0.1')
    expect(data.policy.perTxCapEth).toBe('0.01')
    expect(MockSpendingPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        rollingCap: expect.objectContaining({ windowMs: 86_400_000 }),
        draftThreshold: expect.any(Number),
      })
    )
  })

  it('creates a policy with allowlisted recipients', async () => {
    const result = await handleSetSpendPolicy({
      allowedRecipients: ['0xabc', '0xdef'],
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.policy.allowedRecipients).toEqual(['0xabc', '0xdef'])
    expect(MockSpendingPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ merchantAllowlist: ['0xabc', '0xdef'] })
    )
  })

  it('creates a minimal policy with no limits', async () => {
    const result = await handleSetSpendPolicy({})

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.success).toBe(true)
    expect(data.policy.dailyLimitEth).toBeNull()
    expect(data.policy.perTxCapEth).toBeNull()
  })

  it('returns error for invalid ETH amount', async () => {
    const result = await handleSetSpendPolicy({ dailyLimitEth: 'banana' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('set_spend_policy failed')
  })

  it('returns error for non-positive ETH amount', async () => {
    const result = await handleSetSpendPolicy({ perTxCapEth: '-0.01' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('set_spend_policy failed')
  })

  it('returns error for scientific notation ETH amount', async () => {
    const result = await handleSetSpendPolicy({ dailyLimitEth: '1e-3' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('set_spend_policy failed')
  })
})

describe('enforceSpendPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
  })

  it('allows payments when no policy is configured', async () => {
    await expect(
      enforceSpendPolicy({
        merchant: '0xabc',
        amount: 1,
      })
    ).resolves.toEqual({ status: 'approved' })
  })

  it('invokes the configured SpendingPolicy.check for the scope', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'rejected', reason: 'blocked' })
    MockSpendingPolicy.mockImplementation(function() { return { check } } as any)

    await handleSetSpendPolicy({
      allowedRecipients: ['0xsafe'],
    })

    const decision = await enforceSpendPolicy({
      merchant: '0xattacker',
      amount: 1000,
    })

    expect(check).toHaveBeenCalledWith({
      merchant: '0xattacker',
      amount: 1000,
    })
    expect(decision).toEqual({ status: 'rejected', reason: 'blocked', draftId: undefined })
  })
})

describe('check_budget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
    MockSpendingPolicy.mockImplementation(function() { return { check: vi.fn() } } as any)
  })

  it('returns budget for ETH by default', async () => {
    mockCheckBudget.mockResolvedValue({
      token: '0x0000000000000000000000000000000000000000',
      perTxLimit: 10000000000000000n,
      remainingInPeriod: 90000000000000000n,
    } as any)

    const result = await handleCheckBudget({})

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.perTxLimit).toBe('10000000000000000')
    expect(data.remainingInPeriod).toBe('90000000000000000')
    expect(data.policy).toBeNull()
    expect(mockCheckBudget).toHaveBeenCalledWith(
      expect.anything(),
      '0x0000000000000000000000000000000000000000'
    )
  })

  it('includes policy config when policy has been set', async () => {
    // First set a policy
    await handleSetSpendPolicy({ scopeKey: 'session-a', dailyLimitEth: '0.5' })

    mockCheckBudget.mockResolvedValue({
      token: '0x0000000000000000000000000000000000000000',
      perTxLimit: 1000000000000000000n,
      remainingInPeriod: 500000000000000000n,
    } as any)

    const result = await handleCheckBudget({ scopeKey: 'session-a' })

    const data = JSON.parse(result.content[0].text)
    expect(data.policy).not.toBeNull()
    expect(data.policy.dailyLimitEth).toBe('0.5')
  })

  it('isolates policy config across scope keys', async () => {
    await handleSetSpendPolicy({ scopeKey: 'session-a', dailyLimitEth: '1.0' })
    await handleSetSpendPolicy({ scopeKey: 'session-b', dailyLimitEth: '2.0' })

    mockCheckBudget.mockResolvedValue({
      token: '0x0000000000000000000000000000000000000000',
      perTxLimit: 1000000000000000000n,
      remainingInPeriod: 500000000000000000n,
    } as any)

    const aResult = await handleCheckBudget({ scopeKey: 'session-a' })
    const bResult = await handleCheckBudget({ scopeKey: 'session-b' })

    const aData = JSON.parse(aResult.content[0].text)
    const bData = JSON.parse(bResult.content[0].text)

    expect(aData.policy.dailyLimitEth).toBe('1.0')
    expect(bData.policy.dailyLimitEth).toBe('2.0')
  })

  it('returns error when checkBudget fails', async () => {
    mockCheckBudget.mockRejectedValue(new Error('Contract not deployed'))

    const result = await handleCheckBudget({})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('check_budget failed')
    expect(result.content[0].text).toContain('Contract not deployed')
  })
})
