/**
 * Tests for bridge_usdc tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

vi.mock('agentwallet-sdk', () => ({
  createBridge: vi.fn(),
  SpendingPolicy: vi.fn(),
  checkBudget: vi.fn(),
}))

// ─── Mock client utils ─────────────────────────────────────────────────────

vi.mock('../src/utils/client.js', () => ({
  getConfig: vi.fn(() => ({
    chainId: 8453,
    walletAddress: '0x1234567890123456789012345678901234567890',
  })),
  getWallet: vi.fn(() => ({
    address: '0x1234567890123456789012345678901234567890',
    publicClient: {},
    walletClient: { account: { address: '0xagent' } },
    chain: { id: 8453 },
  })),
}))

import { handleBridgeUsdc } from '../src/tools/bridge.js'
import { handleSetSpendPolicy, _resetPolicyStore } from '../src/tools/budget.js'
import { _resetSpendIntentStore } from '../src/utils/spend-intent.js'
import { createBridge, SpendingPolicy } from 'agentwallet-sdk'

const mockCreateBridge = vi.mocked(createBridge)
const MockSpendingPolicy = vi.mocked(SpendingPolicy)

const baseToPolygon = {
  fromChain: 'base' as const,
  toChain: 'polygon' as const,
  amount: '100',
}

describe('bridge_usdc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
    _resetSpendIntentStore()
  })

  it('bridges USDC from base to polygon successfully', async () => {
    const mockBridge = vi.fn().mockResolvedValue({
      burnTxHash: '0xburntx123',
      mintTxHash: '0xminttx456',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 100000000n,
      elapsedMs: 12000,
    })
    mockCreateBridge.mockReturnValue({ bridge: mockBridge } as any)

    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'polygon',
      amount: '100',
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.success).toBe(true)
    expect(data.burnTxHash).toBe('0xburntx123')
    expect(data.mintTxHash).toBe('0xminttx456')
    expect(data.fromChain).toBe('base')
    expect(data.toChain).toBe('polygon')
    expect(data.amount).toBe('100')
    expect(data.rawAmount).toBe('100000000')
    expect(mockBridge).toHaveBeenCalledWith(100000000n, 'polygon')
  })

  it('returns error when fromChain equals toChain', async () => {
    mockCreateBridge.mockReturnValue({ bridge: vi.fn() } as any)

    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'base',
      amount: '50',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('bridge_usdc failed')
    expect(result.content[0].text).toContain('different')
  })

  it('returns error for invalid amount', async () => {
    mockCreateBridge.mockReturnValue({ bridge: vi.fn() } as any)

    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'arbitrum',
      amount: 'not-a-number',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('bridge_usdc failed')
  })

  it('rejects comma-formatted amount ("1,000") instead of parsing it as 1 USDC', async () => {
    const mockBridge = vi.fn()
    mockCreateBridge.mockReturnValue({ bridge: mockBridge } as any)

    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'polygon',
      amount: '1,000',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Invalid amount: "1,000"')
    expect(mockBridge).not.toHaveBeenCalled()
  })

  it('rejects exponent, hex, multi-dot, empty, and negative amounts', async () => {
    const mockBridge = vi.fn()
    mockCreateBridge.mockReturnValue({ bridge: mockBridge } as any)

    for (const bad of ['1e3', '0x10', '1.2.3', '', '-5']) {
      const result = await handleBridgeUsdc({
        fromChain: 'base',
        toChain: 'polygon',
        amount: bad,
      })

      expect(result.isError, `amount "${bad}" should be rejected`).toBe(true)
      expect(result.content[0].text).toContain('Invalid amount')
    }
    expect(mockBridge).not.toHaveBeenCalled()
  })

  it('rejects amounts with more than 6 decimal places', async () => {
    const mockBridge = vi.fn()
    mockCreateBridge.mockReturnValue({ bridge: mockBridge } as any)

    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'polygon',
      amount: '0.0000001',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Too many decimal places (max 6)')
    expect(mockBridge).not.toHaveBeenCalled()
  })

  it('converts large amounts exactly, beyond float precision', async () => {
    const mockBridge = vi.fn().mockResolvedValue({
      burnTxHash: '0xburntx789',
      mintTxHash: '0xminttxabc',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 10000000000000000001n,
      elapsedMs: 9000,
    })
    mockCreateBridge.mockReturnValue({ bridge: mockBridge } as any)

    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'polygon',
      amount: '10000000000000.000001',
    })

    expect(result.isError).toBeUndefined()
    // parseFloat would lose the final base unit (…000n); strict parsing keeps it.
    expect(mockBridge).toHaveBeenCalledWith(10000000000000000001n, 'polygon')
    const data = JSON.parse(result.content[0].text)
    expect(data.rawAmount).toBe('10000000000000000001')
  })

  it('returns error when bridge call fails', async () => {
    const mockBridge = vi.fn().mockRejectedValue(new Error('Circle attestation timeout'))
    mockCreateBridge.mockReturnValue({ bridge: mockBridge } as any)

    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'arbitrum',
      amount: '200',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('bridge_usdc failed')
    expect(result.content[0].text).toContain('Circle attestation timeout')
  })

  // ─── Spend policy enforcement ────────────────────────────────────────────

  it('blocks bridging when the spend policy allowlist rejects the wallet', async () => {
    const check = vi.fn().mockResolvedValue({
      status: 'rejected',
      reason: 'Merchant "0xagent" is not on the allowlist.',
    })
    MockSpendingPolicy.mockImplementation(function () { return { check } } as any)

    await handleSetSpendPolicy({
      allowedRecipients: ['0x0000000000000000000000000000000000000001'],
    })

    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'polygon',
      amount: '100',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('allowlist')
    expect(mockCreateBridge).not.toHaveBeenCalled()
    // Merchant is the bridging wallet itself (CCTP mints back to it), and
    // 100 USDC (6 decimals) is normalised to 1e20 ETH-equivalent wei.
    expect(check).toHaveBeenCalledWith({ merchant: '0xagent', amount: 1e20 })
  })

  it('blocks bridging when the spend policy cap is exceeded', async () => {
    const check = vi.fn().mockResolvedValue({
      status: 'rejected',
      reason: 'Rolling spend cap exceeded: spent 0, cap 5e19, attempted 1e20.',
    })
    MockSpendingPolicy.mockImplementation(function () { return { check } } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '50' })

    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'polygon',
      amount: '100',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Rolling spend cap exceeded')
    expect(mockCreateBridge).not.toHaveBeenCalled()
  })

  it('holds bridging as draft when the per-tx policy threshold is met', async () => {
    const check = vi.fn().mockResolvedValue({
      status: 'draft',
      reason: 'Amount meets draft threshold. Awaiting approval.',
      draftId: 'draft-123',
    })
    MockSpendingPolicy.mockImplementation(function () { return { check } } as any)

    await handleSetSpendPolicy({ perTxCapEth: '10' })

    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'polygon',
      amount: '100',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('queued as draft')
    expect(result.content[0].text).toContain('draft-123')
    expect(mockCreateBridge).not.toHaveBeenCalled()
  })

  it('bridges normally when the spend policy approves', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'approved' })
    MockSpendingPolicy.mockImplementation(function () { return { check } } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '1000' })

    const mockBridge = vi.fn().mockResolvedValue({
      burnTxHash: '0xburntx123',
      mintTxHash: '0xminttx456',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 100000000n,
      elapsedMs: 12000,
    })
    mockCreateBridge.mockReturnValue({ bridge: mockBridge } as any)

    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'polygon',
      amount: '100',
    })

    expect(result.isError).toBeUndefined()
    expect(check).toHaveBeenCalledOnce()
    expect(mockBridge).toHaveBeenCalledWith(100000000n, 'polygon')
  })

  it('refuses a CCTP source the wallet cannot sign before creating the bridge', async () => {
    const result = await handleBridgeUsdc({
      fromChain: 'optimism',
      toChain: 'base',
      amount: '100',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('bridge_usdc failed')
    expect(result.content[0].text).toContain('refusing fromChain "optimism"')
    expect(mockCreateBridge).not.toHaveBeenCalled()
  })

  it('replays an identical bridge_usdc retry without a second burn', async () => {
    const mockBridge = vi.fn().mockResolvedValue({
      burnTxHash: '0xburntx123',
      mintTxHash: '0xminttx456',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 100000000n,
      elapsedMs: 12000,
    })
    mockCreateBridge.mockReturnValue({ bridge: mockBridge } as any)

    const first = await handleBridgeUsdc(baseToPolygon)
    const retry = await handleBridgeUsdc(baseToPolygon)

    expect(first.isError).toBeUndefined()
    expect(retry.isError).toBeUndefined()
    const firstData = JSON.parse(first.content[0].text)
    const retryData = JSON.parse(retry.content[0].text)
    expect(firstData.burnTxHash).toBe('0xburntx123')
    expect(firstData.idempotentRetry).toBeUndefined()
    expect(retryData.burnTxHash).toBe('0xburntx123')
    expect(retryData.idempotentRetry).toBe(true)
    expect(mockBridge).toHaveBeenCalledTimes(1)
    expect(mockCreateBridge).toHaveBeenCalledTimes(1)
  })

  it('executes a second bridge when the destination or amount differs', async () => {
    const mockBridge = vi
      .fn()
      .mockResolvedValueOnce({
        burnTxHash: '0xburn1',
        mintTxHash: '0xmint1',
        fromChain: 'base',
        toChain: 'polygon',
        recipient: '0xagent',
        amount: 100000000n,
        elapsedMs: 1000,
      })
      .mockResolvedValueOnce({
        burnTxHash: '0xburn2',
        mintTxHash: '0xmint2',
        fromChain: 'base',
        toChain: 'arbitrum',
        recipient: '0xagent',
        amount: 100000000n,
        elapsedMs: 1000,
      })
    mockCreateBridge.mockReturnValue({ bridge: mockBridge } as any)

    const first = await handleBridgeUsdc(baseToPolygon)
    const second = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'arbitrum',
      amount: '100',
    })

    expect(JSON.parse(first.content[0].text).burnTxHash).toBe('0xburn1')
    expect(JSON.parse(second.content[0].text).burnTxHash).toBe('0xburn2')
    expect(JSON.parse(second.content[0].text).idempotentRetry).toBeUndefined()
    expect(mockBridge).toHaveBeenCalledTimes(2)
  })

  it('fail-closes an identical retry after an unresolved bridge broadcast', async () => {
    const mockBridge = vi.fn().mockRejectedValueOnce(new Error('rpc timeout'))
    mockCreateBridge.mockReturnValue({ bridge: mockBridge } as any)

    const failed = await handleBridgeUsdc(baseToPolygon)
    const retry = await handleBridgeUsdc(baseToPolygon)

    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('rpc timeout')
    expect(retry.isError).toBe(true)
    expect(retry.content[0].text).toContain('did not return a transaction hash')
    expect(mockBridge).toHaveBeenCalledTimes(1)
  })

  it('keeps a Circle attestation timeout locked after the keyless TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T22:00:00Z'))
    try {
      const mockBridge = vi.fn().mockRejectedValue(new Error('Circle attestation timeout'))
      mockCreateBridge.mockReturnValue({ bridge: mockBridge } as any)

      const failed = await handleBridgeUsdc(baseToPolygon)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1)
      const retry = await handleBridgeUsdc(baseToPolygon)

      expect(failed.isError).toBe(true)
      expect(failed.content[0].text).toContain('Circle attestation timeout')
      expect(retry.isError).toBe(true)
      expect(retry.content[0].text).toContain('did not return a transaction hash')
      expect(mockBridge).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a keyed retry that changes the amount', async () => {
    const mockBridge = vi.fn().mockResolvedValue({
      burnTxHash: '0xburntx123',
      mintTxHash: '0xminttx456',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 100000000n,
      elapsedMs: 12000,
    })
    mockCreateBridge.mockReturnValue({ bridge: mockBridge } as any)

    const first = await handleBridgeUsdc({
      ...baseToPolygon,
      idempotencyKey: 'invoice-1',
    })
    const conflict = await handleBridgeUsdc({
      ...baseToPolygon,
      amount: '50',
      idempotencyKey: 'invoice-1',
    })

    expect(JSON.parse(first.content[0].text).burnTxHash).toBe('0xburntx123')
    expect(conflict.isError).toBe(true)
    expect(conflict.content[0].text).toContain('different spend payload')
    expect(mockBridge).toHaveBeenCalledTimes(1)
  })
})
