/**
 * Tests for set_spend_policy and check_budget tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

vi.mock('agentwallet-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('agentwallet-sdk')>()
  return {
    ...actual,
    SpendingPolicy: vi.fn(),
    checkBudget: vi.fn(),
  }
})

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
  releaseSpendReservation,
  reserveSpendPolicy,
  withReservedSpend,
  _resetPolicyStore,
  ALLOW_UNPOLICED_SPEND_ENV,
  MAX_POLICY_LAYERS_PER_SCOPE,
  MAX_POLICY_SCOPES,
  OPERATOR_POLICY_ENV,
} from '../src/tools/budget.js'
import { SpendingPolicy, checkBudget } from 'agentwallet-sdk'
import { policyEngine, reservedResult } from './helpers/policy-engine.js'

const MockSpendingPolicy = vi.mocked(SpendingPolicy)
const mockCheckBudget = vi.mocked(checkBudget)

describe('set_spend_policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
    // Must use function (not arrow) so it works as a constructor with `new`
    MockSpendingPolicy.mockImplementation(function() {
      return policyEngine(vi.fn().mockResolvedValue(reservedResult()))
    } as any)
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
        rollingCap: expect.objectContaining({
          maxAmount: 1e8, // 0.1 ETH in 9-decimal policy units
          windowMs: 86_400_000,
        }),
        draftThreshold: 1e7, // 0.01 ETH
      })
    )
  })

  it('creates a policy with allowlisted recipients', async () => {
    const result = await handleSetSpendPolicy({
      allowedRecipients: ['0x00000000000000000000000000000000000000ab', '0x00000000000000000000000000000000000000de'],
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.policy.allowedRecipients).toEqual(['0x00000000000000000000000000000000000000ab', '0x00000000000000000000000000000000000000de'])
    expect(MockSpendingPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ merchantAllowlist: ['0x00000000000000000000000000000000000000ab', '0x00000000000000000000000000000000000000de'] })
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

  it('invokes the configured SpendingPolicy.reserve for the scope', async () => {
    const reserve = vi.fn().mockResolvedValue({ status: 'rejected', reason: 'blocked' })
    MockSpendingPolicy.mockImplementation(function() { return policyEngine(reserve) } as any)

    await handleSetSpendPolicy({
      allowedRecipients: ['0x0000000000000000000000000000000000005afe'],
    })

    const decision = await enforceSpendPolicy({
      merchant: '0xattacker',
      amount: 1000,
      decimals: 18,
    })

    expect(reserve).toHaveBeenCalledWith({
      merchant: '0xattacker',
      amount: 1,
    })
    expect(decision).toEqual({ status: 'rejected', reason: 'blocked' })
  })

  it('normalises token base units to 9-decimal ETH-equivalent for the policy', async () => {
    const reserve = vi.fn().mockResolvedValue(reservedResult())
    MockSpendingPolicy.mockImplementation(function() { return policyEngine(reserve) } as any)

    await handleSetSpendPolicy({ perTxCapEth: '5' })

    // 10 USDC = 10_000_000 base units (6 decimals) → 1e10 policy units
    // (9-decimal ETH-equivalent) — NOT 10_000_000, which would slip 1e3
    // under every cap, and not 1e19 wei, which overflows MAX_SAFE_INTEGER.
    const decision = await enforceSpendPolicy({
      merchant: '0xmerchant',
      amount: 10_000_000n,
      decimals: 6,
    })

    expect(decision).toEqual({ status: 'approved' })
    expect(reserve).toHaveBeenCalledWith({
      merchant: '0xmerchant',
      amount: 1e10,
    })
  })

  it('enforces policies configured under a non-default scopeKey', async () => {
    const reserve = vi.fn().mockResolvedValue({ status: 'rejected', reason: 'scoped block' })
    MockSpendingPolicy.mockImplementation(function() { return policyEngine(reserve) } as any)

    await handleSetSpendPolicy({ scopeKey: 'session-1', perTxCapEth: '0.01' })

    // Call sites never pass a scope — the scoped policy must still apply.
    const decision = await enforceSpendPolicy({
      merchant: '0xabc',
      amount: 10n ** 18n,
      decimals: 18,
    })

    expect(reserve).toHaveBeenCalledWith({ merchant: '0xabc', amount: 1e9 })
    expect(decision).toEqual({ status: 'rejected', reason: 'scoped block' })
  })

  it('requires every configured scope to approve (union enforcement)', async () => {
    const approve = vi.fn().mockResolvedValue(reservedResult())
    const reject = vi.fn().mockResolvedValue({ status: 'rejected', reason: 'scoped cap' })
    MockSpendingPolicy
      .mockImplementationOnce(function() { return policyEngine(approve) } as any)
      .mockImplementationOnce(function() { return policyEngine(reject) } as any)

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

  it('never under-reports remainders when scaling 18-decimal wei down to 9', async () => {
    const reserve = vi.fn().mockResolvedValue(reservedResult())
    MockSpendingPolicy.mockImplementation(function() { return policyEngine(reserve) } as any)

    await handleSetSpendPolicy({ perTxCapEth: '5' })

    // 1_000_000_001 wei / 1e9 = 1 remainder 1 → fail-closed rounds up to 2.
    await enforceSpendPolicy({
      merchant: '0xmerchant',
      amount: 1_000_000_001n,
      decimals: 18,
    })

    expect(reserve).toHaveBeenCalledWith({
      merchant: '0xmerchant',
      amount: 2,
    })
  })

  // ─── Fail-closed behaviour ─────────────────────────────────────────────

  it('releases earlier holds when a later policy.reserve throws', async () => {
    const firstRelease = vi.fn().mockReturnValue(true)
    const firstReserve = vi.fn().mockResolvedValue(reservedResult())
    const secondReserve = vi.fn().mockRejectedValue(new Error('second scope exploded'))
    MockSpendingPolicy
      .mockImplementationOnce(function () {
        return { ...policyEngine(firstReserve), release: firstRelease }
      } as any)
      .mockImplementationOnce(function () {
        return policyEngine(secondReserve)
      } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '1' })
    await handleSetSpendPolicy({ scopeKey: 'session-2', dailyLimitEth: '1' })

    const { decision, reservation } = await reserveSpendPolicy({
      merchant: '0xabc',
      amount: 1n,
      decimals: 9,
    })

    expect(decision.status).toBe('rejected')
    expect((decision as { reason?: string }).reason).toContain('second scope exploded')
    expect(reservation).toBeNull()
    expect(firstReserve).toHaveBeenCalledOnce()
    expect(firstRelease).toHaveBeenCalledOnce()
  })

  it('fails closed when SpendingPolicy.reserve throws', async () => {
    const reserve = vi.fn().mockRejectedValue(new Error('policy engine exploded'))
    MockSpendingPolicy.mockImplementation(function() { return policyEngine(reserve) } as any)

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
    const reserve = vi.fn().mockResolvedValue({ status: 'maybe-later' })
    MockSpendingPolicy.mockImplementation(function() { return policyEngine(reserve) } as any)

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
    const reserve = vi.fn().mockResolvedValue(reservedResult())
    MockSpendingPolicy.mockImplementation(function() { return policyEngine(reserve) } as any)

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
    expect(reserve).not.toHaveBeenCalled()
  })

  it('fails closed for out-of-range decimals', async () => {
    const reserve = vi.fn().mockResolvedValue(reservedResult())
    MockSpendingPolicy.mockImplementation(function() { return policyEngine(reserve) } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '0.1' })

    for (const decimals of [-1, 19, 1.5, NaN]) {
      const decision = await enforceSpendPolicy({
        merchant: '0xabc',
        amount: 1n,
        decimals,
      })
      expect(decision.status).toBe('rejected')
    }
    expect(reserve).not.toHaveBeenCalled()
  })

  it('fails closed for negative and non-finite amounts', async () => {
    const reserve = vi.fn().mockResolvedValue(reservedResult())
    MockSpendingPolicy.mockImplementation(function() { return policyEngine(reserve) } as any)

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

    expect(reserve).not.toHaveBeenCalled()
  })
})

describe('check_budget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
    MockSpendingPolicy.mockImplementation(function() {
      return policyEngine(vi.fn().mockResolvedValue(reservedResult()))
    } as any)
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

describe('reserveSpendPolicy / releaseSpendReservation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
  })

  it('releases a reserved 100-unit spend so a retry fits under a 150 cap', async () => {
    const { SpendingPolicy: RealPolicy } = await vi.importActual<
      typeof import('agentwallet-sdk')
    >('agentwallet-sdk')
    MockSpendingPolicy.mockImplementation(function (this: unknown, config: unknown) {
      return new RealPolicy(config as ConstructorParameters<typeof RealPolicy>[0])
    } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '150' })

    const first = await reserveSpendPolicy({
      merchant: '0x1234567890123456789012345678901234567890',
      amount: 100_000_000n,
      decimals: 6,
    })
    expect(first.decision.status).toBe('approved')
    expect(first.reservation).not.toBeNull()

    const blocked = await reserveSpendPolicy({
      merchant: '0x1234567890123456789012345678901234567890',
      amount: 100_000_000n,
      decimals: 6,
    })
    expect(blocked.decision.status).toBe('rejected')
    expect(blocked.decision).toEqual(
      expect.objectContaining({ reason: expect.stringMatching(/Rolling spend cap exceeded/i) })
    )

    releaseSpendReservation(first.reservation)

    const retried = await reserveSpendPolicy({
      merchant: '0x1234567890123456789012345678901234567890',
      amount: 100_000_000n,
      decimals: 6,
    })
    expect(retried.decision.status).toBe('approved')
  })

  it('commits a reserved spend on success so a second 100-unit payment stays over a 150 cap', async () => {
    const { SpendingPolicy: RealPolicy } = await vi.importActual<
      typeof import('agentwallet-sdk')
    >('agentwallet-sdk')
    MockSpendingPolicy.mockImplementation(function (this: unknown, config: unknown) {
      return new RealPolicy(config as ConstructorParameters<typeof RealPolicy>[0])
    } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '150' })

    await withReservedSpend(
      {
        merchant: '0x1234567890123456789012345678901234567890',
        amount: 100_000_000n,
        decimals: 6,
      },
      async () => 'settled'
    )

    const blocked = await reserveSpendPolicy({
      merchant: '0x1234567890123456789012345678901234567890',
      amount: 100_000_000n,
      decimals: 6,
    })
    expect(blocked.decision.status).toBe('rejected')
    expect(blocked.decision).toEqual(
      expect.objectContaining({ reason: expect.stringMatching(/Rolling spend cap exceeded/i) })
    )
  })
})

// ─── F11: policy administration is monotonic and operator-anchored ─────────

describe('spend policy administration (F11)', () => {
  const R1 = '0x0000000000000000000000000000000000000001'
  const R2 = '0x0000000000000000000000000000000000000002'

  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
    MockSpendingPolicy.mockImplementation(function () {
      return policyEngine(vi.fn().mockResolvedValue(reservedResult()))
    } as any)
  })

  it('denies value movement by default when no operator policy is configured', async () => {
    delete process.env[ALLOW_UNPOLICED_SPEND_ENV]
    _resetPolicyStore()
    // A caller-created policy is NOT a trusted policy.
    await handleSetSpendPolicy({ perTxCapEth: '1000' })
    const decision = await enforceSpendPolicy({ merchant: R1, amount: 1n, decimals: 18 })
    expect(decision.status).toBe('rejected')
    expect((decision as { reason?: string }).reason).toContain('No operator spend policy')
  })

  it('loads an immutable operator policy from the environment', async () => {
    delete process.env[ALLOW_UNPOLICED_SPEND_ENV]
    process.env[OPERATOR_POLICY_ENV.perTxCapEth] = '0.5'
    process.env[OPERATOR_POLICY_ENV.allowedRecipients] = `${R1},${R2}`
    try {
      _resetPolicyStore()
      const decision = await enforceSpendPolicy({ merchant: R1, amount: 1n, decimals: 18 })
      expect(decision.status).toBe('approved')
      expect(MockSpendingPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ merchantAllowlist: [R1, R2], draftThreshold: 500_000_000 })
      )
      const tamper = await handleSetSpendPolicy({ scopeKey: 'operator', perTxCapEth: '100' })
      expect(tamper.isError).toBe(true)
      expect(tamper.content[0].text).toContain('reserved for the operator')
    } finally {
      delete process.env[OPERATOR_POLICY_ENV.perTxCapEth]
      delete process.env[OPERATOR_POLICY_ENV.allowedRecipients]
    }
  })

  it('refuses to raise a limit, drop a constraint, or widen an allowlist', async () => {
    await handleSetSpendPolicy({ dailyLimitEth: '1', perTxCapEth: '0.1', allowedRecipients: [R1] })
    for (const loosen of [
      { dailyLimitEth: '2', perTxCapEth: '0.1', allowedRecipients: [R1] },
      { perTxCapEth: '0.1', allowedRecipients: [R1] },
      { dailyLimitEth: '1', perTxCapEth: '0.2', allowedRecipients: [R1] },
      { dailyLimitEth: '1', perTxCapEth: '0.1', allowedRecipients: [R1, R2] },
      { dailyLimitEth: '1', perTxCapEth: '0.1', allowedRecipients: [] },
      {},
    ]) {
      const result = await handleSetSpendPolicy(loosen)
      expect(result.isError, JSON.stringify(loosen)).toBe(true)
      expect(result.content[0].text).toContain('can only tighten')
    }
    const tighter = await handleSetSpendPolicy({
      dailyLimitEth: '0.5',
      perTxCapEth: '0.05',
      allowedRecipients: [R1],
    })
    expect(tighter.isError).toBeUndefined()
    expect(JSON.parse(tighter.content[0].text).layers).toBe(2)
  })

  it('keeps earlier layers (and their accounting) in force after tightening', async () => {
    const firstReserve = vi.fn().mockResolvedValue({ status: 'rejected', reason: 'daily cap spent' })
    const secondReserve = vi.fn().mockResolvedValue(reservedResult())
    MockSpendingPolicy.mockImplementationOnce(function () {
      return policyEngine(firstReserve)
    } as any).mockImplementationOnce(function () {
      return policyEngine(secondReserve)
    } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '1' })
    await handleSetSpendPolicy({ dailyLimitEth: '0.9' })

    const decision = await enforceSpendPolicy({ merchant: R1, amount: 1n, decimals: 18 })
    expect(decision).toEqual({ status: 'rejected', reason: 'daily cap spent' })
    expect(firstReserve).toHaveBeenCalled()
  })

  it('bounds the number of scopes and layers', async () => {
    for (let i = 0; i < MAX_POLICY_SCOPES; i++) {
      expect((await handleSetSpendPolicy({ scopeKey: `s${i}`, perTxCapEth: '1' })).isError).toBeUndefined()
    }
    const overflow = await handleSetSpendPolicy({ scopeKey: 'one-too-many', perTxCapEth: '1' })
    expect(overflow.isError).toBe(true)

    for (let i = 1; i < MAX_POLICY_LAYERS_PER_SCOPE; i++) {
      expect((await handleSetSpendPolicy({ scopeKey: 's0', perTxCapEth: '1' })).isError).toBeUndefined()
    }
    expect((await handleSetSpendPolicy({ scopeKey: 's0', perTxCapEth: '1' })).isError).toBe(true)
  })

  it('rejects malformed allowlist addresses', async () => {
    const result = await handleSetSpendPolicy({ allowedRecipients: ['0xnot-an-address'] })
    expect(result.isError).toBe(true)
  })
})
