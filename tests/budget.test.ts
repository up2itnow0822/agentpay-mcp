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
        decimals: 18,
      })
    ).resolves.toEqual({ status: 'approved' })
  })

  it('does not evaluate the decimals thunk when no policy is configured', async () => {
    const decimals = vi.fn(() => {
      throw new Error('should not be called')
    })

    await expect(
      enforceSpendPolicy({
        merchant: '0xabc',
        amount: 1n,
        decimals,
      })
    ).resolves.toEqual({ status: 'approved' })
    expect(decimals).not.toHaveBeenCalled()
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
      decimals: 18,
    })

    expect(check).toHaveBeenCalledWith({
      merchant: '0xattacker',
      amount: 1000,
    })
    expect(decision).toEqual({ status: 'rejected', reason: 'blocked' })
  })

  it('normalises token base units to 18-decimal ETH-equivalent for the policy', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'approved' })
    MockSpendingPolicy.mockImplementation(function() { return { check } } as any)

    await handleSetSpendPolicy({ perTxCapEth: '5' })

    // 10 USDC = 10_000_000 base units (6 decimals) → 1e19 ETH-equivalent
    // wei — NOT 10_000_000, which would slip 1e12 under every cap.
    const decision = await enforceSpendPolicy({
      merchant: '0xmerchant',
      amount: 10_000_000n,
      decimals: 6,
    })

    expect(decision).toEqual({ status: 'approved' })
    expect(check).toHaveBeenCalledWith({
      merchant: '0xmerchant',
      amount: 1e19,
    })
  })

  it('enforces policies configured under a non-default scopeKey', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'rejected', reason: 'scoped block' })
    MockSpendingPolicy.mockImplementation(function() { return { check } } as any)

    await handleSetSpendPolicy({ scopeKey: 'session-1', perTxCapEth: '0.01' })

    // Call sites never pass a scope — the scoped policy must still apply.
    const decision = await enforceSpendPolicy({
      merchant: '0xabc',
      amount: 10n ** 18n,
      decimals: 18,
    })

    expect(check).toHaveBeenCalledWith({ merchant: '0xabc', amount: 1e18 })
    expect(decision).toEqual({ status: 'rejected', reason: 'scoped block' })
  })

  it('requires every configured scope to approve (union enforcement)', async () => {
    const approve = vi.fn().mockResolvedValue({ status: 'approved' })
    const reject = vi.fn().mockResolvedValue({ status: 'rejected', reason: 'scoped cap' })
    MockSpendingPolicy
      .mockImplementationOnce(function() { return { check: approve } } as any)
      .mockImplementationOnce(function() { return { check: reject } } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '1' })
    await handleSetSpendPolicy({ scopeKey: 'session-1', dailyLimitEth: '0.001' })

    const decision = await enforceSpendPolicy({
      merchant: '0xabc',
      amount: 10n ** 17n,
      decimals: 18,
    })

    expect(approve).toHaveBeenCalledOnce()
    expect(reject).toHaveBeenCalledOnce()
    expect(decision).toEqual({ status: 'rejected', reason: 'scoped cap' })
  })

  it('never under-reports amounts that exceed float precision', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'approved' })
    MockSpendingPolicy.mockImplementation(function() { return { check } } as any)

    await handleSetSpendPolicy({ perTxCapEth: '5' })

    // 2^53 + 1 wei rounds DOWN to 2^53 as a float; the fail-closed bias must
    // round the policy-visible amount up instead.
    await enforceSpendPolicy({
      merchant: '0xmerchant',
      amount: 2n ** 53n + 1n,
      decimals: 18,
    })

    const seen = check.mock.calls[0]![0].amount as number
    expect(seen).toBeGreaterThan(Number(2n ** 53n))
  })

  // ─── Fail-closed behaviour ─────────────────────────────────────────────

  it('fails closed when SpendingPolicy.check throws', async () => {
    const check = vi.fn().mockRejectedValue(new Error('policy engine exploded'))
    MockSpendingPolicy.mockImplementation(function() { return { check } } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '0.1' })

    const decision = await enforceSpendPolicy({
      merchant: '0xabc',
      amount: 1n,
      decimals: 18,
    })

    expect(decision.status).toBe('rejected')
    expect((decision as { reason?: string }).reason).toContain('fail-closed')
    expect((decision as { reason?: string }).reason).toContain('policy engine exploded')
  })

  it('fails closed when the policy returns an unrecognised status', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'maybe-later' })
    MockSpendingPolicy.mockImplementation(function() { return { check } } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '0.1' })

    const decision = await enforceSpendPolicy({
      merchant: '0xabc',
      amount: 1n,
      decimals: 18,
    })

    expect(decision.status).toBe('rejected')
    expect((decision as { reason?: string }).reason).toContain('maybe-later')
  })

  it('fails closed when the decimals thunk throws', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'approved' })
    MockSpendingPolicy.mockImplementation(function() { return { check } } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '0.1' })

    const decision = await enforceSpendPolicy({
      merchant: '0xabc',
      amount: 1n,
      decimals: () => {
        throw new Error('Cannot resolve decimals for asset')
      },
    })

    expect(decision.status).toBe('rejected')
    expect((decision as { reason?: string }).reason).toContain('Cannot resolve decimals')
    expect(check).not.toHaveBeenCalled()
  })

  it('fails closed for out-of-range decimals', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'approved' })
    MockSpendingPolicy.mockImplementation(function() { return { check } } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '0.1' })

    for (const decimals of [-1, 19, 1.5, NaN]) {
      const decision = await enforceSpendPolicy({
        merchant: '0xabc',
        amount: 1n,
        decimals,
      })
      expect(decision.status).toBe('rejected')
    }
    expect(check).not.toHaveBeenCalled()
  })

  it('fails closed for negative and non-finite amounts', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'approved' })
    MockSpendingPolicy.mockImplementation(function() { return { check } } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '0.1' })

    const negative = await enforceSpendPolicy({
      merchant: '0xabc',
      amount: -1n,
      decimals: 18,
    })
    expect(negative.status).toBe('rejected')

    // 10^400 scaled overflows Number → Infinity → reject, never approve.
    const huge = await enforceSpendPolicy({
      merchant: '0xabc',
      amount: 10n ** 400n,
      decimals: 18,
    })
    expect(huge.status).toBe('rejected')

    expect(check).not.toHaveBeenCalled()
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
