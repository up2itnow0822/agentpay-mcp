/**
 * Tests for swap_tokens tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

vi.mock('agentwallet-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('agentwallet-sdk')>()
  return {
    ...actual,
    getGlobalRegistry: vi.fn(),
    attachSwap: vi.fn(),
    parseAmount: vi.fn((amount: string, decimals: number) =>
      BigInt(Math.round(parseFloat(amount) * 10 ** decimals))
    ),
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

import { handleSwapTokens } from '../src/tools/swap.js'
import { handleSetSpendPolicy, _resetPolicyStore } from '../src/tools/budget.js'
import { _resetSpendIntentStore } from '../src/utils/spend-intent.js'
import { getWallet } from '../src/utils/client.js'
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

function withQuote(
  swapImpl: (..._args: unknown[]) => unknown,
  getQuote = vi.fn().mockResolvedValue({
    amountInNet: 1n,
    amountOutMinimum: 1n,
    poolFeeTier: 500,
    feeAmount: 0n,
    gasEstimate: 100000n,
  })
) {
  const swap = vi.fn(async (..._args: unknown[]) => {
    await getQuote(_args[0], _args[1], _args[2], _args[3])
    return swapImpl(..._args)
  })
  return { swap, getQuote, swapModule: { getQuote } }
}

async function broadcastThenThrow(message: string): Promise<never> {
  await (getWallet() as { walletClient: { sendTransaction: (_tx: unknown) => Promise<unknown> } })
    .walletClient.sendTransaction({ to: '0x1', data: '0x' })
  throw new Error(message)
}

describe('swap_tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetPolicyStore()
    _resetSpendIntentStore()
  })

  it('swaps USDC to WETH successfully', async () => {
    const mockSwap = vi.fn().mockResolvedValue({
      txHash: '0xa75b820028c10238305d038a08ffc1dbc6abea551cecee41b5652aa8d93d77f6',
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
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

    const result = await handleSwapTokens({
      fromSymbol: 'USDC',
      toSymbol: 'WETH',
      amount: '100',
      chainId: 8453,
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.success).toBe(true)
    expect(data.txHash).toBe('0xa75b820028c10238305d038a08ffc1dbc6abea551cecee41b5652aa8d93d77f6')
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
      txHash: '0xa4b1e72419aca2c4bf7b370753a3a5df2f855d6dfb46dbf2e1ca647b6c327187',
      quote: { amountInNet: 1n, amountOutMinimum: 1n, poolFeeTier: 500, feeAmount: 0n, gasEstimate: 100000n },
    })
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValueOnce(USDC).mockReturnValueOnce(WETH),
    } as any)
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

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
    mockAttachSwap.mockReturnValue(withQuote(vi.fn()) as any)

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
    mockAttachSwap.mockReturnValue(withQuote(vi.fn()) as any)

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
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

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
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

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
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

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
      txHash: '0x58b6062bc5903ddbde75a7f123ecc63aa020127ea617b13c3bc3e90a8b17cf50',
      quote: { amountInNet: 1n, amountOutMinimum: 1n, poolFeeTier: 500, feeAmount: 0n, gasEstimate: 100000n },
    })
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValueOnce(USDC).mockReturnValueOnce(WETH),
    } as any)
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

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
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

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
      txHash: '0xa75b820028c10238305d038a08ffc1dbc6abea551cecee41b5652aa8d93d77f6',
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
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

    const first = await handleSwapTokens(usdcWethSwap)
    const retry = await handleSwapTokens(usdcWethSwap)

    expect(first.isError).toBeUndefined()
    expect(retry.isError).toBeUndefined()
    const firstData = JSON.parse(first.content[0].text)
    const retryData = JSON.parse(retry.content[0].text)
    expect(firstData.txHash).toBe('0xa75b820028c10238305d038a08ffc1dbc6abea551cecee41b5652aa8d93d77f6')
    expect(firstData.idempotentRetry).toBeUndefined()
    expect(retryData.txHash).toBe('0xa75b820028c10238305d038a08ffc1dbc6abea551cecee41b5652aa8d93d77f6')
    expect(retryData.idempotentRetry).toBe(true)
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('executes a second swap when the pair or amount differs', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi
      .fn()
      .mockResolvedValueOnce({ txHash: '0x6dc1ec722cd64b3a1fde946e06c2a2e4a3a537aca2ab5eb7c5458e65550b0f38', quote: null })
      .mockResolvedValueOnce({ txHash: '0x1c269cc693bf2baaeac8812a815e4b527506d05ccf1b50d0c3453cf4cc011d2a', quote: null })
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

    const first = await handleSwapTokens(usdcWethSwap)
    const second = await handleSwapTokens({ ...usdcWethSwap, amount: '50' })

    expect(JSON.parse(first.content[0].text).txHash).toBe('0x6dc1ec722cd64b3a1fde946e06c2a2e4a3a537aca2ab5eb7c5458e65550b0f38')
    expect(JSON.parse(second.content[0].text).txHash).toBe('0x1c269cc693bf2baaeac8812a815e4b527506d05ccf1b50d0c3453cf4cc011d2a')
    expect(JSON.parse(second.content[0].text).idempotentRetry).toBeUndefined()
    expect(mockSwap).toHaveBeenCalledTimes(2)
  })

  it('fail-closes a hashless swap success instead of caching it', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockResolvedValue({ txHash: '   ', quote: null })
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

    const failed = await handleSwapTokens(usdcWethSwap)
    const retry = await handleSwapTokens(usdcWethSwap)

    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('returned without a transaction hash')
    expect(retry.isError).toBe(true)
    expect(retry.content[0].text).toContain('did not return a transaction hash')
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('fail-closes a malformed swap txHash instead of caching it', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockResolvedValue({ txHash: 'pending', quote: null })
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

    const failed = await handleSwapTokens(usdcWethSwap)
    const retry = await handleSwapTokens(usdcWethSwap)

    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('malformed transaction hash')
    expect(retry.isError).toBe(true)
    expect(retry.content[0].text).toContain('did not return a transaction hash')
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('fail-closes an identical retry after an unresolved swap broadcast', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockImplementationOnce(() => broadcastThenThrow('rpc timeout'))
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

    const failed = await handleSwapTokens(usdcWethSwap)
    const retry = await handleSwapTokens(usdcWethSwap)

    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('rpc timeout')
    expect(retry.isError).toBe(true)
    expect(retry.content[0].text).toContain('did not return a transaction hash')
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('keeps an ambiguous post-broadcast swap locked after the keyless TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T22:00:00Z'))
    try {
      mockUsdcWethRegistry()
      const mockSwap = vi.fn().mockImplementation(() => broadcastThenThrow('rpc timeout'))
      mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

      const failed = await handleSwapTokens(usdcWethSwap)
      vi.advanceTimersByTime(5 * 60 * 1000 + 1)
      const retry = await handleSwapTokens(usdcWethSwap)

      expect(failed.isError).toBe(true)
      expect(failed.content[0].text).toContain('rpc timeout')
      expect(retry.isError).toBe(true)
      expect(retry.content[0].text).toContain('did not return a transaction hash')
      expect(mockSwap).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
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

    const mockSwap = vi.fn().mockResolvedValue({ txHash: '0xc3746c982a2eeb7bc35e72d8a947e15e7e544950c861418fc0cab7c2d99b2fa9', quote: null })
    mockUsdcWethRegistry()
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

    await handleSetSpendPolicy({ dailyLimitEth: '50' })

    const blocked = await handleSwapTokens(usdcWethSwap)
    const retried = await handleSwapTokens(usdcWethSwap)

    expect(blocked.isError).toBe(true)
    expect(blocked.content[0].text).toContain('Rolling spend cap exceeded')
    expect(retried.isError).toBeUndefined()
    expect(JSON.parse(retried.content[0].text).txHash).toBe('0xc3746c982a2eeb7bc35e72d8a947e15e7e544950c861418fc0cab7c2d99b2fa9')
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('replays when the caller retries the same idempotency key', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockResolvedValue({ txHash: '0xe2ca719a6c68fddf6f0eba6672bf06c44d615d6cd6f88966d98a88354600d75e', quote: null })
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

    const first = await handleSwapTokens({ ...usdcWethSwap, idempotencyKey: 'invoice-1' })
    const retry = await handleSwapTokens({ ...usdcWethSwap, idempotencyKey: 'invoice-1' })

    expect(JSON.parse(first.content[0].text).idempotentRetry).toBeUndefined()
    expect(JSON.parse(retry.content[0].text).txHash).toBe('0xe2ca719a6c68fddf6f0eba6672bf06c44d615d6cd6f88966d98a88354600d75e')
    expect(JSON.parse(retry.content[0].text).idempotentRetry).toBe(true)
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('replays when a retry only fills in the default slippageBps', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockResolvedValue({ txHash: '0x81dfd97e2d5187c186e08a70a91d7ddab140f7869f39b4cef3ec2b7b0e122cee', quote: null })
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

    const first = await handleSwapTokens(usdcWethSwap)
    const retry = await handleSwapTokens({ ...usdcWethSwap, slippageBps: 50 })

    expect(JSON.parse(first.content[0].text).txHash).toBe('0x81dfd97e2d5187c186e08a70a91d7ddab140f7869f39b4cef3ec2b7b0e122cee')
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
      const mockSwap = vi.fn().mockResolvedValue({ txHash: '0xd2d28d84ab5a533299dc2dabb137843756f6c6eb8d1e8eb37d1a63f9133de737', quote: null })
      mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

      const first = await handleSwapTokens({
        ...usdcWethSwap,
        idempotencyKey: 'invoice-1',
      })
      vi.advanceTimersByTime(5 * 60 * 1000 + 1)
      const retry = await handleSwapTokens({
        ...usdcWethSwap,
        idempotencyKey: 'invoice-1',
      })

      expect(JSON.parse(first.content[0].text).txHash).toBe('0xd2d28d84ab5a533299dc2dabb137843756f6c6eb8d1e8eb37d1a63f9133de737')
      expect(JSON.parse(retry.content[0].text).idempotentRetry).toBe(true)
      expect(mockSwap).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a keyed retry that changes the amount', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockResolvedValue({ txHash: '0xe2ca719a6c68fddf6f0eba6672bf06c44d615d6cd6f88966d98a88354600d75e', quote: null })
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

    const first = await handleSwapTokens({
      ...usdcWethSwap,
      idempotencyKey: 'invoice-1',
    })
    const conflict = await handleSwapTokens({
      ...usdcWethSwap,
      amount: '50',
      idempotencyKey: 'invoice-1',
    })

    expect(JSON.parse(first.content[0].text).txHash).toBe('0xe2ca719a6c68fddf6f0eba6672bf06c44d615d6cd6f88966d98a88354600d75e')
    expect(conflict.isError).toBe(true)
    expect(conflict.content[0].text).toContain('different spend payload')
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('replays a keyed retry that only fills in the default slippageBps', async () => {
    mockUsdcWethRegistry()
    const mockSwap = vi.fn().mockResolvedValue({ txHash: '0x523be71122b194c4248560f162f00eabdb43f8e1a68fb84c87c04eea265da335', quote: null })
    mockAttachSwap.mockReturnValue(withQuote(mockSwap) as any)

    const first = await handleSwapTokens({
      ...usdcWethSwap,
      idempotencyKey: 'invoice-1',
    })
    const retry = await handleSwapTokens({
      ...usdcWethSwap,
      slippageBps: 50,
      idempotencyKey: 'invoice-1',
    })

    expect(JSON.parse(retry.content[0].text).txHash).toBe('0x523be71122b194c4248560f162f00eabdb43f8e1a68fb84c87c04eea265da335')
    expect(JSON.parse(retry.content[0].text).idempotentRetry).toBe(true)
    expect(mockSwap).toHaveBeenCalledTimes(1)
  })

  it('retries after a swap quote fetch failure instead of locking the intent', async () => {
    mockUsdcWethRegistry()
    const getQuote = vi
      .fn()
      .mockRejectedValueOnce(new Error('quote rpc timeout'))
      .mockResolvedValueOnce({
        amountInNet: 1n,
        amountOutMinimum: 1n,
        poolFeeTier: 500,
        feeAmount: 0n,
        gasEstimate: 100000n,
      })
    const mockSwap = vi.fn().mockResolvedValue({ txHash: '0xd8e4908941b66c7b471093f86142a2468739573208f613a7e3650d13c153d3af', quote: null })
    mockAttachSwap.mockReturnValue(withQuote(mockSwap, getQuote) as any)

    const failed = await handleSwapTokens(usdcWethSwap)
    const retried = await handleSwapTokens(usdcWethSwap)

    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('quote rpc timeout')
    expect(retried.isError).toBeUndefined()
    expect(JSON.parse(retried.content[0].text).txHash).toBe('0xd8e4908941b66c7b471093f86142a2468739573208f613a7e3650d13c153d3af')
    expect(mockSwap).toHaveBeenCalledTimes(1)
    expect(getQuote).toHaveBeenCalledTimes(2)
  })

  it('releases a 100-unit reservation under a 150 cap after a quote failure', async () => {
    const { SpendingPolicy: RealPolicy } = await vi.importActual<
      typeof import('agentwallet-sdk')
    >('agentwallet-sdk')
    MockSpendingPolicy.mockImplementation(function (this: unknown, config: unknown) {
      return new RealPolicy(config as ConstructorParameters<typeof RealPolicy>[0])
    } as any)

    mockUsdcWethRegistry()
    const getQuote = vi
      .fn()
      .mockRejectedValueOnce(new Error('quote rpc timeout'))
      .mockResolvedValueOnce({
        amountInNet: 1n,
        amountOutMinimum: 1n,
        poolFeeTier: 500,
        feeAmount: 0n,
        gasEstimate: 100000n,
      })
    const mockSwap = vi.fn().mockResolvedValue({
      txHash: '0x7c3a1d0e9b2f4a6c8e0d1f3b5a7c9e1d2f4b6a8c0e2d4f6b8a0c2e4d6f8b0a12',
      quote: null,
    })
    mockAttachSwap.mockReturnValue(withQuote(mockSwap, getQuote) as any)

    await handleSetSpendPolicy({ dailyLimitEth: '150' })

    const failed = await handleSwapTokens(usdcWethSwap)
    const retried = await handleSwapTokens(usdcWethSwap)

    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('quote rpc timeout')
    expect(retried.isError).toBeUndefined()
    expect(JSON.parse(retried.content[0].text).txHash).toBe(
      '0x7c3a1d0e9b2f4a6c8e0d1f3b5a7c9e1d2f4b6a8c0e2d4f6b8a0c2e4d6f8b0a12'
    )
    expect(mockSwap).toHaveBeenCalledTimes(1)
    expect(getQuote).toHaveBeenCalledTimes(2)
  })
})
