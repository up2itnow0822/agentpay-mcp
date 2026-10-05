/**
 * Tests for bridge_usdc tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

vi.mock('agentwallet-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('agentwallet-sdk')>()
  return {
    ...actual,
    createBridge: vi.fn(),
    SpendingPolicy: vi.fn(),
    checkBudget: vi.fn(),
  }
})

// ─── Mock client utils ─────────────────────────────────────────────────────

vi.mock('../src/utils/client.js', () => {
  const walletClient = {
    account: { address: '0xagent' },
    sendTransaction: vi.fn().mockResolvedValue('0xsend'),
    writeContract: vi.fn().mockResolvedValue('0xwrite'),
  }
  return {
    getConfig: vi.fn(() => ({
      chainId: 8453,
      walletAddress: '0x1234567890123456789012345678901234567890',
    })),
    getWallet: vi.fn(() => ({
      address: '0x1234567890123456789012345678901234567890',
      publicClient: {},
      walletClient,
      chain: { id: 8453 },
    })),
  }
})

import { handleBridgeUsdc } from '../src/tools/bridge.js'
import { handleSetSpendPolicy, _resetPolicyStore } from '../src/tools/budget.js'
import { _resetSpendIntentStore } from '../src/utils/spend-intent.js'
import { getWallet } from '../src/utils/client.js'
import { createBridge, SpendingPolicy } from 'agentwallet-sdk'

const mockCreateBridge = vi.mocked(createBridge)
const MockSpendingPolicy = vi.mocked(SpendingPolicy)

const baseToPolygon = {
  fromChain: 'base' as const,
  toChain: 'polygon' as const,
  amount: '100',
}

function withAllowance(
  bridgeImpl: (...args: unknown[]) => unknown,
  getUsdcAllowance = vi.fn().mockResolvedValue(0n)
) {
  const approveUsdc = async (amount: bigint) => {
    const current = await getUsdcAllowance()
    if (current >= amount) return
  }
  const bridge = vi.fn(async (...args: unknown[]) => {
    await approveUsdc(args[0] as bigint)
    return bridgeImpl(...args)
  })
  return { bridge, getUsdcAllowance, approveUsdc }
}

async function broadcastThenThrow(message: string): Promise<never> {
  await (getWallet() as { walletClient: { writeContract: (tx: unknown) => Promise<unknown> } })
    .walletClient.writeContract({ to: '0x1', data: '0x' })
  throw new Error(message)
}

describe('bridge_usdc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
    _resetSpendIntentStore()
  })

  it('bridges USDC from base to polygon successfully', async () => {
    const mockBridge = vi.fn().mockResolvedValue({
      burnTxHash: '0x0bcf0cd90bcd3694b04c4e810e626777e17b49dca45660a84e0b6619ae8ac1a9',
      mintTxHash: '0xb2f5e43fac373c03f76f7ec086f320bc572965866e7083e5bf1877c225635529',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 100000000n,
      elapsedMs: 12000,
    })
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'polygon',
      amount: '100',
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.success).toBe(true)
    expect(data.burnTxHash).toBe('0x0bcf0cd90bcd3694b04c4e810e626777e17b49dca45660a84e0b6619ae8ac1a9')
    expect(data.mintTxHash).toBe('0xb2f5e43fac373c03f76f7ec086f320bc572965866e7083e5bf1877c225635529')
    expect(data.fromChain).toBe('base')
    expect(data.toChain).toBe('polygon')
    expect(data.amount).toBe('100')
    expect(data.rawAmount).toBe('100000000')
    expect(mockBridge).toHaveBeenCalledWith(100000000n, 'polygon')
  })

  it('returns error when fromChain equals toChain', async () => {
    mockCreateBridge.mockReturnValue(withAllowance(vi.fn()) as any)

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
    mockCreateBridge.mockReturnValue(withAllowance(vi.fn()) as any)

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
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

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
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

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
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

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
      burnTxHash: '0x2ccda0565bb57928c180850e54af1b1d4fe9cd0eb7d25025d6c42ecfc3c62ec2',
      mintTxHash: '0xb59db29d2c7d3310f818dc2d210abb661e91a94a8f1920c161ec9abcf581b0e3',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 10000000000000000001n,
      elapsedMs: 9000,
    })
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

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
    const mockBridge = vi.fn().mockImplementation(() =>
      broadcastThenThrow('Circle attestation timeout')
    )
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

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
      burnTxHash: '0x0bcf0cd90bcd3694b04c4e810e626777e17b49dca45660a84e0b6619ae8ac1a9',
      mintTxHash: '0xb2f5e43fac373c03f76f7ec086f320bc572965866e7083e5bf1877c225635529',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 100000000n,
      elapsedMs: 12000,
    })
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

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
      burnTxHash: '0x0bcf0cd90bcd3694b04c4e810e626777e17b49dca45660a84e0b6619ae8ac1a9',
      mintTxHash: '0xb2f5e43fac373c03f76f7ec086f320bc572965866e7083e5bf1877c225635529',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 100000000n,
      elapsedMs: 12000,
    })
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

    const first = await handleBridgeUsdc(baseToPolygon)
    const retry = await handleBridgeUsdc(baseToPolygon)

    expect(first.isError).toBeUndefined()
    expect(retry.isError).toBeUndefined()
    const firstData = JSON.parse(first.content[0].text)
    const retryData = JSON.parse(retry.content[0].text)
    expect(firstData.burnTxHash).toBe('0x0bcf0cd90bcd3694b04c4e810e626777e17b49dca45660a84e0b6619ae8ac1a9')
    expect(firstData.idempotentRetry).toBeUndefined()
    expect(retryData.burnTxHash).toBe('0x0bcf0cd90bcd3694b04c4e810e626777e17b49dca45660a84e0b6619ae8ac1a9')
    expect(retryData.idempotentRetry).toBe(true)
    expect(mockBridge).toHaveBeenCalledTimes(1)
    expect(mockCreateBridge).toHaveBeenCalledTimes(1)
  })

  it('executes a second bridge when the destination or amount differs', async () => {
    const mockBridge = vi
      .fn()
      .mockResolvedValueOnce({
        burnTxHash: '0x82b5b141919ad95b1caaeebd1cb2f8d10f2845ee7cb0107bcf2a463edf850985',
        mintTxHash: '0x234c5d96b607e867e5282232c222ed197f815b19bce4cc831dab8cedc5f9fc1d',
        fromChain: 'base',
        toChain: 'polygon',
        recipient: '0xagent',
        amount: 100000000n,
        elapsedMs: 1000,
      })
      .mockResolvedValueOnce({
        burnTxHash: '0xa5b9e522c0a2efe12b74a7b789774ab62df07cb8ac9a2bc9b59ca4d69ff27071',
        mintTxHash: '0xbb69ba149e4209f560f283dd21c11606c8e878e6acb4af975129cb200d4db215',
        fromChain: 'base',
        toChain: 'arbitrum',
        recipient: '0xagent',
        amount: 100000000n,
        elapsedMs: 1000,
      })
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

    const first = await handleBridgeUsdc(baseToPolygon)
    const second = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'arbitrum',
      amount: '100',
    })

    expect(JSON.parse(first.content[0].text).burnTxHash).toBe('0x82b5b141919ad95b1caaeebd1cb2f8d10f2845ee7cb0107bcf2a463edf850985')
    expect(JSON.parse(second.content[0].text).burnTxHash).toBe('0xa5b9e522c0a2efe12b74a7b789774ab62df07cb8ac9a2bc9b59ca4d69ff27071')
    expect(JSON.parse(second.content[0].text).idempotentRetry).toBeUndefined()
    expect(mockBridge).toHaveBeenCalledTimes(2)
  })

  it('fail-closes a malformed burnTxHash instead of caching a bridge success', async () => {
    const mockBridge = vi.fn().mockResolvedValue({
      burnTxHash: 'pending',
      mintTxHash: '0xb2f5e43fac373c03f76f7ec086f320bc572965866e7083e5bf1877c225635529',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 100000000n,
      elapsedMs: 12000,
    })
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

    const failed = await handleBridgeUsdc(baseToPolygon)
    const retry = await handleBridgeUsdc(baseToPolygon)

    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('malformed transaction hash')
    expect(retry.isError).toBe(true)
    expect(retry.content[0].text).toContain('did not return a transaction hash')
    expect(mockBridge).toHaveBeenCalledTimes(1)
  })

  it('fail-closes a mint-hashless bridge success instead of caching it', async () => {
    const mockBridge = vi.fn().mockResolvedValue({
      burnTxHash: '0x0bcf0cd90bcd3694b04c4e810e626777e17b49dca45660a84e0b6619ae8ac1a9',
      mintTxHash: '',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 100000000n,
      elapsedMs: 12000,
    })
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

    const failed = await handleBridgeUsdc(baseToPolygon)
    const retry = await handleBridgeUsdc(baseToPolygon)

    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('returned without a transaction hash')
    expect(retry.isError).toBe(true)
    expect(retry.content[0].text).toContain('did not return a transaction hash')
    expect(mockBridge).toHaveBeenCalledTimes(1)
  })

  it('fail-closes an identical retry after an unresolved bridge broadcast', async () => {
    const mockBridge = vi.fn().mockImplementationOnce(() => broadcastThenThrow('rpc timeout'))
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

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
      const mockBridge = vi.fn().mockImplementation(() =>
        broadcastThenThrow('Circle attestation timeout')
      )
      mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

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
      burnTxHash: '0x0bcf0cd90bcd3694b04c4e810e626777e17b49dca45660a84e0b6619ae8ac1a9',
      mintTxHash: '0xb2f5e43fac373c03f76f7ec086f320bc572965866e7083e5bf1877c225635529',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 100000000n,
      elapsedMs: 12000,
    })
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge) as any)

    const first = await handleBridgeUsdc({
      ...baseToPolygon,
      idempotencyKey: 'invoice-1',
    })
    const conflict = await handleBridgeUsdc({
      ...baseToPolygon,
      amount: '50',
      idempotencyKey: 'invoice-1',
    })

    expect(JSON.parse(first.content[0].text).burnTxHash).toBe('0x0bcf0cd90bcd3694b04c4e810e626777e17b49dca45660a84e0b6619ae8ac1a9')
    expect(conflict.isError).toBe(true)
    expect(conflict.content[0].text).toContain('different spend payload')
    expect(mockBridge).toHaveBeenCalledTimes(1)
  })

  it('retries after an allowance read failure instead of locking the intent', async () => {
    const getUsdcAllowance = vi
      .fn()
      .mockRejectedValueOnce(new Error('allowance rpc timeout'))
      .mockResolvedValueOnce(0n)
    const mockBridge = vi.fn().mockResolvedValue({
      burnTxHash: '0x9bea025fd37c325f56bf24b39e8a1d1def2faa0d1f9b468a350376bbd1d6a48b',
      mintTxHash: '0xb3f19930f6f5077981d255a842ccb7f07e447a6136fa3f3b17e182e9e2ab6d87',
      fromChain: 'base',
      toChain: 'polygon',
      recipient: '0xagent',
      amount: 100000000n,
      elapsedMs: 12000,
    })
    mockCreateBridge.mockReturnValue(withAllowance(mockBridge, getUsdcAllowance) as any)

    const failed = await handleBridgeUsdc(baseToPolygon)
    const retried = await handleBridgeUsdc(baseToPolygon)

    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('allowance rpc timeout')
    expect(retried.isError).toBeUndefined()
    expect(JSON.parse(retried.content[0].text).burnTxHash).toBe('0x9bea025fd37c325f56bf24b39e8a1d1def2faa0d1f9b468a350376bbd1d6a48b')
    expect(mockBridge).toHaveBeenCalledTimes(1)
    expect(getUsdcAllowance).toHaveBeenCalledTimes(2)
  })
})
