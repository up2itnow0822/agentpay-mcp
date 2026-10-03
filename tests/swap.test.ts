/**
 * Tests for swap_tokens tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

vi.mock('agentwallet-sdk', () => ({
  getGlobalRegistry: vi.fn(),
  attachSwap: vi.fn(),
  parseAmount: vi.fn((amount: string, decimals: number) =>
    BigInt(Math.round(parseFloat(amount) * 10 ** decimals))
  ),
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

import { handleSwapTokens } from '../src/tools/swap.js'
import { handleSetSpendPolicy, _resetPolicyStore } from '../src/tools/budget.js'
import { _resetSpendIntentStore } from '../src/utils/spend-intent.js'
import { getGlobalRegistry, attachSwap, SpendingPolicy } from 'agentwallet-sdk'

const mockGetGlobalRegistry = vi.mocked(getGlobalRegistry)
const mockAttachSwap = vi.mocked(attachSwap)
const MockSpendingPolicy = vi.mocked(SpendingPolicy)

const USDC = {
  symbol: 'USDC',
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  decimals: 6,
  chainId: 8453,
}

const WETH = {
  symbol: 'WETH',
  address: '0x4200000000000000000000000000000000000006',
  decimals: 18,
  chainId: 8453,
}

const usdcWethSwap = {
  fromSymbol: 'USDC',
  toSymbol: 'WETH',
  amount: '100',
  chainId: 8453,
}

function mockUsdcWethRegistry() {
  mockGetGlobalRegistry.mockReturnValue({
    getToken: vi.fn((symbol: string) => {
      if (symbol === 'USDC') return USDC
      if (symbol === 'WETH') return WETH
      return undefined
    }),
  } as any)
}

describe('swap_tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
    _resetSpendIntentStore()
  })

  it('swaps USDC to WETH successfully', async () => {
    const mockSwap = vi.fn().mockResolvedValue({
      txHash: '0xswaptx123',
      feeTxHash: null,
      approvalRequired: true,
      approvalTxHash: '0xapprovaltx',
      quote: {
        amountInNet: 100000000n,
        amountOutMinimum: 50000000000000000n,
        poolFeeTier: 500,
        feeAmount: 0n,
        gasEstimate: 150000n,
      },
    })
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn()
        .mockReturnValueOnce(USDC)
        .mockReturnValueOnce(WETH),
    } as any)
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    const result = await handleSwapTokens({
      fromSymbol: 'USDC',
      toSymbol: 'WETH',
      amount: '100',
      chainId: 8453,
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.success).toBe(true)
    expect(data.txHash).toBe('0xswaptx123')
    expect(data.fromToken).toBe('USDC')
    expect(data.toToken).toBe('WETH')
    expect(data.chainId).toBe(8453)
    expect(mockSwap).toHaveBeenCalledWith(
      USDC.address,
      WETH.address,
      expect.any(BigInt),
      { slippageBps: 50 }
    )
  })

  it('applies custom slippageBps', async () => {
    const mockSwap = vi.fn().mockResolvedValue({
      txHash: '0xswaptx456',
      quote: { amountInNet: 1n, amountOutMinimum: 1n, poolFeeTier: 500, feeAmount: 0n, gasEstimate: 100000n },
    })
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValueOnce(USDC).mockReturnValueOnce(WETH),
    } as any)
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    await handleSwapTokens({
      fromSymbol: 'USDC',
      toSymbol: 'WETH',
      amount: '50',
      chainId: 8453,
      slippageBps: 100,
    })

    expect(mockSwap).toHaveBeenCalledWith(
      USDC.address,
      WETH.address,
      expect.any(BigInt),
      { slippageBps: 100 }
    )
  })

  it('returns error when fromToken not found', async () => {
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValueOnce(undefined),
    } as any)
    mockAttachSwap.mockReturnValue({ swap: vi.fn() } as any)

    const result = await handleSwapTokens({
      fromSymbol: 'NOTFOUND',
      toSymbol: 'WETH',
      amount: '10',
      chainId: 8453,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('swap_tokens failed')
    expect(result.content[0].text).toContain('NOTFOUND')
  })

  it('returns error when toToken not found', async () => {
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValueOnce(USDC).mockReturnValueOnce(undefined),
    } as any)
    mockAttachSwap.mockReturnValue({ swap: vi.fn() } as any)

    const result = await handleSwapTokens({
      fromSymbol: 'USDC',
      toSymbol: 'NOTFOUND',
      amount: '10',
      chainId: 8453,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('swap_tokens failed')
  })

  it('returns error when swap fails', async () => {
    const mockSwap = vi.fn().mockRejectedValue(new Error('Insufficient liquidity'))
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValueOnce(USDC).mockReturnValueOnce(WETH),
    } as any)
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    const result = await handleSwapTokens({
      fromSymbol: 'USDC',
      toSymbol: 'WETH',
      amount: '10000',
      chainId: 8453,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('swap_tokens failed')
    expect(result.content[0].text).toContain('Insufficient liquidity')
  })

  // ─── Spend policy enforcement ────────────────────────────────────────────

  it('blocks swaps when the spend policy allowlist rejects the wallet', async () => {
    const check = vi.fn().mockResolvedValue({
      status: 'rejected',
      reason:
        'Merchant "0x1234567890123456789012345678901234567890" is not on the allowlist.',
    })
    MockSpendingPolicy.mockImplementation(function () { return { check } } as any)

    const mockSwap = vi.fn()
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValueOnce(USDC).mockReturnValueOnce(WETH),
    } as any)
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    await handleSetSpendPolicy({
      allowedRecipients: ['0x0000000000000000000000000000000000000001'],
    })

    const result = await handleSwapTokens({
      fromSymbol: 'USDC',
      toSymbol: 'WETH',
      amount: '100',
      chainId: 8453,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('allowlist')
    expect(mockSwap).not.toHaveBeenCalled()
    // Merchant is the agent smart-account address (wallet.address — the SDK
    // SwapModule custodies tokens and receives swap proceeds there), and
    // 100 USDC sold (6 decimals) is normalised to 1e20 ETH-equivalent wei.
    expect(check).toHaveBeenCalledWith({
      merchant: '0x1234567890123456789012345678901234567890',
      amount: 1e20,
    })
  })

  it('blocks swaps when the spend policy cap is exceeded', async () => {
    const check = vi.fn().mockResolvedValue({
      status: 'rejected',
      reason: 'Rolling spend cap exceeded: spent 0, cap 5e19, attempted 1e20.',
    })
    MockSpendingPolicy.mockImplementation(function () { return { check } } as any)

    const mockSwap = vi.fn()
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValueOnce(USDC).mockReturnValueOnce(WETH),
    } as any)
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '50' })

    const result = await handleSwapTokens({
      fromSymbol: 'USDC',
      toSymbol: 'WETH',
      amount: '100',
      chainId: 8453,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Rolling spend cap exceeded')
    expect(mockSwap).not.toHaveBeenCalled()
  })

  it('swaps normally when the spend policy approves', async () => {
    const check = vi.fn().mockResolvedValue({ status: 'approved' })
    MockSpendingPolicy.mockImplementation(function () { return { check } } as any)

    const mockSwap = vi.fn().mockResolvedValue({
      txHash: '0xswaptx999',
      quote: { amountInNet: 1n, amountOutMinimum: 1n, poolFeeTier: 500, feeAmount: 0n, gasEstimate: 100000n },
    })
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValueOnce(USDC).mockReturnValueOnce(WETH),
    } as any)
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '1000' })

    const result = await handleSwapTokens({
      fromSymbol: 'USDC',
      toSymbol: 'WETH',
      amount: '100',
      chainId: 8453,
    })

    expect(result.isError).toBeUndefined()
    expect(check).toHaveBeenCalledOnce()
    expect(mockSwap).toHaveBeenCalledOnce()
  })

  it('refuses a chainId the wallet cannot sign before looking up tokens', async () => {
    const getToken = vi.fn().mockReturnValue(WETH)
    mockGetGlobalRegistry.mockReturnValue({ getToken } as any)
    const mockSwap = vi.fn()
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    const result = await handleSwapTokens({
      fromSymbol: 'WETH',
      toSymbol: 'USDC',
      amount: '1',
      chainId: 10,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('swap_tokens failed')
    expect(result.content[0].text).toContain('refusing chainId 10')
    expect(getToken).not.toHaveBeenCalled()
    expect(mockSwap).not.toHaveBeenCalled()
  })

  it('replays an identical swap_tokens retry without a second swap', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockResolvedValue({
      txHash: '0xswaptx123',
      feeTxHash: null,
      approvalRequired: true,
      approvalTxHash: '0xapprovaltx',
      quote: {
        amountInNet: 100000000n,
        amountOutMinimum: 50000000000000000n,
        poolFeeTier: 500,
        feeAmount: 0n,
        gasEstimate: 150000n,
      },
    })
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    const first = await handleSwapTokens(usdcWethSwap)
    const retry = await handleSwapTokens(usdcWethSwap)

    expect(first.isError).toBeUndefined()
    expect(retry.isError).toBeUndefined()
    const firstData = JSON.parse(first.content[0].text)
    const retryData = JSON.parse(retry.content[0].text)
    expect(firstData.txHash).toBe('0xswaptx123')
    expect(firstData.idempotentRetry).toBeUndefined()
    expect(retryData.txHash).toBe('0xswaptx123')
    expect(retryData.idempotentRetry).toBe(true)
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('executes a second swap when the pair or amount differs', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi
      .fn()
      .mockResolvedValueOnce({ txHash: '0xswap1', quote: null })
      .mockResolvedValueOnce({ txHash: '0xswap2', quote: null })
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    const first = await handleSwapTokens(usdcWethSwap)
    const second = await handleSwapTokens({ ...usdcWethSwap, amount: '50' })

    expect(JSON.parse(first.content[0].text).txHash).toBe('0xswap1')
    expect(JSON.parse(second.content[0].text).txHash).toBe('0xswap2')
    expect(JSON.parse(second.content[0].text).idempotentRetry).toBeUndefined()
    expect(mockSwap).toHaveBeenCalledTimes(2)
  })

  it('fail-closes an identical retry after an unresolved swap broadcast', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockRejectedValueOnce(new Error('rpc timeout'))
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    const failed = await handleSwapTokens(usdcWethSwap)
    const retry = await handleSwapTokens(usdcWethSwap)

    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('rpc timeout')
    expect(retry.isError).toBe(true)
    expect(retry.content[0].text).toContain('did not return a transaction hash')
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('retries a spend-policy rejection instead of locking the swap intent', async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'rejected',
        reason: 'Rolling spend cap exceeded: spent 0, cap 5e19, attempted 1e20.',
      })
      .mockResolvedValueOnce({ status: 'approved' })
    MockSpendingPolicy.mockImplementation(function () { return { check } } as any)

    const mockSwap = vi.fn().mockResolvedValue({ txHash: '0xswapafterpolicy', quote: null })
    mockUsdcWethRegistry()
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    await handleSetSpendPolicy({ dailyLimitEth: '50' })

    const blocked = await handleSwapTokens(usdcWethSwap)
    const retried = await handleSwapTokens(usdcWethSwap)

    expect(blocked.isError).toBe(true)
    expect(blocked.content[0].text).toContain('Rolling spend cap exceeded')
    expect(retried.isError).toBeUndefined()
    expect(JSON.parse(retried.content[0].text).txHash).toBe('0xswapafterpolicy')
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('replays when the caller retries the same idempotency key', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockResolvedValue({ txHash: '0xswapkey', quote: null })
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    const first = await handleSwapTokens({ ...usdcWethSwap, idempotencyKey: 'invoice-1' })
    const retry = await handleSwapTokens({ ...usdcWethSwap, idempotencyKey: 'invoice-1' })

    expect(JSON.parse(first.content[0].text).idempotentRetry).toBeUndefined()
    expect(JSON.parse(retry.content[0].text).txHash).toBe('0xswapkey')
    expect(JSON.parse(retry.content[0].text).idempotentRetry).toBe(true)
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('replays when a retry only fills in the default slippageBps', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockResolvedValue({ txHash: '0xswapdefault', quote: null })
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    const first = await handleSwapTokens(usdcWethSwap)
    const retry = await handleSwapTokens({ ...usdcWethSwap, slippageBps: 50 })

    expect(JSON.parse(first.content[0].text).txHash).toBe('0xswapdefault')
    expect(JSON.parse(retry.content[0].text).idempotentRetry).toBe(true)
    expect(mockSwap).toHaveBeenCalledTimes(1)
    expect(mockSwap).toHaveBeenCalledWith(
      USDC.address,
      WETH.address,
      expect.any(BigInt),
      { slippageBps: 50 }
    )
  })

  it('replays a keyed swap after the keyless TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T22:00:00Z'))
    try {
      mockUsdcWethRegistry()
      const mockSwap = vi.fn().mockResolvedValue({ txHash: '0xswapdurable', quote: null })
      mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

      const first = await handleSwapTokens({
        ...usdcWethSwap,
        idempotencyKey: 'invoice-1',
      })
      vi.advanceTimersByTime(5 * 60 * 1000 + 1)
      const retry = await handleSwapTokens({
        ...usdcWethSwap,
        idempotencyKey: 'invoice-1',
      })

      expect(JSON.parse(first.content[0].text).txHash).toBe('0xswapdurable')
      expect(JSON.parse(retry.content[0].text).idempotentRetry).toBe(true)
      expect(mockSwap).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a keyed retry that changes the amount', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockResolvedValue({ txHash: '0xswapkey', quote: null })
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    const first = await handleSwapTokens({
      ...usdcWethSwap,
      idempotencyKey: 'invoice-1',
    })
    const conflict = await handleSwapTokens({
      ...usdcWethSwap,
      amount: '50',
      idempotencyKey: 'invoice-1',
    })

    expect(JSON.parse(first.content[0].text).txHash).toBe('0xswapkey')
    expect(conflict.isError).toBe(true)
    expect(conflict.content[0].text).toContain('different spend payload')
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('replays a keyed retry that only fills in the default slippageBps', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockResolvedValue({ txHash: '0xswapkeyslip', quote: null })
    mockAttachSwap.mockReturnValue({ swap: mockSwap } as any)

    const first = await handleSwapTokens({
      ...usdcWethSwap,
      idempotencyKey: 'invoice-1',
    })
    const retry = await handleSwapTokens({
      ...usdcWethSwap,
      slippageBps: 50,
      idempotencyKey: 'invoice-1',
    })

    expect(JSON.parse(retry.content[0].text).txHash).toBe('0xswapkeyslip')
    expect(JSON.parse(retry.content[0].text).idempotentRetry).toBe(true)
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })
})
