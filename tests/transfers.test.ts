/**
 * Tests for send_token and get_balances tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

vi.mock('agentwallet-sdk', () => ({
  getGlobalRegistry: vi.fn(),
  agentTransferToken: vi.fn(),
  getBalances: vi.fn(),
  parseAmount: vi.fn((amount: string, decimals: number) =>
    BigInt(Math.round(parseFloat(amount) * 10 ** decimals))
  ),
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
    walletClient: { account: { address: '0xdeadbeef00000000000000000000000000000001' } },
    contract: { write: { agentTransferToken: vi.fn() } },
    chain: { id: 8453 },
  })),
}))

import { handleSendToken, handleGetBalances } from '../src/tools/transfers.js'
import { getGlobalRegistry, agentTransferToken, getBalances } from 'agentwallet-sdk'
import { _resetSpendIntentStore } from '../src/utils/spend-intent.js'

const mockGetGlobalRegistry = vi.mocked(getGlobalRegistry)
const mockAgentTransferToken = vi.mocked(agentTransferToken)
const mockGetBalances = vi.mocked(getBalances)

function mockUsdcRegistry() {
  mockGetGlobalRegistry.mockReturnValue({
    getToken: vi.fn().mockReturnValue({
      symbol: 'USDC',
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 6,
      chainId: 8453,
    }),
  } as any)
}

const usdcSend = {
  tokenSymbol: 'USDC',
  chainId: 8453,
  recipientAddress: '0xrecipient00000000000000000000000000000001',
  amount: '10',
}

describe('send_token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentTransferToken.mockReset()
    _resetSpendIntentStore()
  })

  it('sends token successfully', async () => {
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValue({
        symbol: 'USDC',
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6,
        chainId: 8453,
      }),
    } as any)
    mockAgentTransferToken.mockResolvedValue('0xtxhash123' as any)

    const result = await handleSendToken({
      tokenSymbol: 'USDC',
      chainId: 8453,
      recipientAddress: '0xrecipient00000000000000000000000000000001',
      amount: '10',
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.success).toBe(true)
    expect(data.txHash).toBe('0xtxhash123')
    expect(data.token).toBe('USDC')
    expect(data.amount).toBe('10')
    expect(mockAgentTransferToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        to: '0xrecipient00000000000000000000000000000001',
      })
    )
  })

  it('returns error when token not found in registry', async () => {
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValue(undefined),
    } as any)

    const result = await handleSendToken({
      tokenSymbol: 'UNKNOWN',
      chainId: 8453,
      recipientAddress: '0xrecipient00000000000000000000000000000001',
      amount: '10',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('send_token failed')
    expect(result.content[0].text).toContain('UNKNOWN')
  })

  it('returns error when transfer fails', async () => {
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValue({
        symbol: 'USDC',
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6,
        chainId: 8453,
      }),
    } as any)
    mockAgentTransferToken.mockRejectedValue(new Error('Spend limit exceeded'))

    const result = await handleSendToken({
      tokenSymbol: 'USDC',
      chainId: 8453,
      recipientAddress: '0xrecipient00000000000000000000000000000001',
      amount: '10',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('send_token failed')
    expect(result.content[0].text).toContain('Spend limit exceeded')
  })

  it('refuses a chainId the wallet cannot sign before looking up the token', async () => {
    mockGetGlobalRegistry.mockReturnValue({
      getToken: vi.fn().mockReturnValue({
        symbol: 'WETH',
        address: '0x4200000000000000000000000000000000000006',
        decimals: 18,
        chainId: 10,
      }),
    } as any)

    const result = await handleSendToken({
      tokenSymbol: 'WETH',
      chainId: 10,
      recipientAddress: '0xrecipient00000000000000000000000000000001',
      amount: '1',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('send_token failed')
    expect(result.content[0].text).toContain('refusing chainId 10')
    expect(mockGetGlobalRegistry().getToken).not.toHaveBeenCalled()
    expect(mockAgentTransferToken).not.toHaveBeenCalled()
  })

  it('replays an identical send_token retry without a second transfer', async () => {
    mockUsdcRegistry()
    mockAgentTransferToken.mockResolvedValue('0xtxhash123' as any)

    const first = await handleSendToken(usdcSend)
    const retry = await handleSendToken(usdcSend)

    expect(first.isError).toBeUndefined()
    expect(retry.isError).toBeUndefined()
    const firstData = JSON.parse(first.content[0].text)
    const retryData = JSON.parse(retry.content[0].text)
    expect(firstData.txHash).toBe('0xtxhash123')
    expect(firstData.idempotentRetry).toBeUndefined()
    expect(retryData.txHash).toBe('0xtxhash123')
    expect(retryData.idempotentRetry).toBe(true)
    expect(mockAgentTransferToken).toHaveBeenCalledTimes(1)
  })

  it('broadcasts a second transfer when the recipient differs', async () => {
    mockUsdcRegistry()
    mockAgentTransferToken
      .mockResolvedValueOnce('0xtxhash1' as any)
      .mockResolvedValueOnce('0xtxhash2' as any)

    const first = await handleSendToken(usdcSend)
    const second = await handleSendToken({
      ...usdcSend,
      recipientAddress: '0xrecipient00000000000000000000000000000002',
    })

    expect(JSON.parse(first.content[0].text).txHash).toBe('0xtxhash1')
    expect(JSON.parse(second.content[0].text).txHash).toBe('0xtxhash2')
    expect(JSON.parse(second.content[0].text).idempotentRetry).toBeUndefined()
    expect(mockAgentTransferToken).toHaveBeenCalledTimes(2)
  })

  it('fail-closes an identical retry after an unresolved broadcast', async () => {
    mockUsdcRegistry()
    mockAgentTransferToken.mockRejectedValueOnce(new Error('rpc timeout'))

    const failed = await handleSendToken(usdcSend)
    const retry = await handleSendToken(usdcSend)

    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('rpc timeout')
    expect(retry.isError).toBe(true)
    expect(retry.content[0].text).toContain('did not return a transaction hash')
    expect(mockAgentTransferToken).toHaveBeenCalledTimes(1)
  })

  it('broadcasts two equal payments when idempotency keys differ', async () => {
    mockUsdcRegistry()
    mockAgentTransferToken
      .mockResolvedValueOnce('0xtxhash1' as any)
      .mockResolvedValueOnce('0xtxhash2' as any)

    const first = await handleSendToken({ ...usdcSend, idempotencyKey: 'invoice-1' })
    const second = await handleSendToken({ ...usdcSend, idempotencyKey: 'invoice-2' })

    expect(JSON.parse(first.content[0].text).txHash).toBe('0xtxhash1')
    expect(JSON.parse(second.content[0].text).txHash).toBe('0xtxhash2')
    expect(JSON.parse(second.content[0].text).idempotentRetry).toBeUndefined()
    expect(mockAgentTransferToken).toHaveBeenCalledTimes(2)
  })

  it('replays when the caller retries the same idempotency key', async () => {
    mockUsdcRegistry()
    mockAgentTransferToken.mockResolvedValue('0xtxhash123' as any)

    const first = await handleSendToken({ ...usdcSend, idempotencyKey: 'invoice-1' })
    const retry = await handleSendToken({ ...usdcSend, idempotencyKey: 'invoice-1' })

    expect(JSON.parse(first.content[0].text).idempotentRetry).toBeUndefined()
    expect(JSON.parse(retry.content[0].text).txHash).toBe('0xtxhash123')
    expect(JSON.parse(retry.content[0].text).idempotentRetry).toBe(true)
    expect(mockAgentTransferToken).toHaveBeenCalledTimes(1)
  })
})

describe('get_balances', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns balances for the configured chain', async () => {
    const balances = [
      { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6, rawBalance: 1000000n, humanBalance: '1.0' },
      { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18, rawBalance: 500000000000000000n, humanBalance: '0.5' },
    ]
    mockGetBalances.mockResolvedValue(balances as any)

    const result = await handleGetBalances({})

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.chainId).toBe(8453)
    expect(data.count).toBe(2)
    expect(data.walletAddress).toBe('0x1234567890123456789012345678901234567890')
    expect(data.balances[0].rawBalance).toBe('1000000')
    expect(data.balances[1].rawBalance).toBe('500000000000000000')
    expect(mockGetBalances).toHaveBeenCalledWith(
      expect.objectContaining({
        account: '0x1234567890123456789012345678901234567890',
      })
    )
    expect(mockGetBalances).not.toHaveBeenCalledWith(
      expect.objectContaining({
        account: '0xdeadbeef00000000000000000000000000000001',
      })
    )
  })

  it('allows a matching chainId and queries the configured wallet chain', async () => {
    mockGetBalances.mockResolvedValue([] as any)

    const result = await handleGetBalances({ chainId: 8453 })

    expect(result.isError).toBeUndefined()
    expect(mockGetBalances).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 8453 })
    )
  })

  it('refuses a chainId the wallet public client cannot query', async () => {
    mockGetBalances.mockResolvedValue([] as any)

    const result = await handleGetBalances({ chainId: 42161 })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('get_balances failed')
    expect(result.content[0].text).toContain('refusing chainId 42161')
    expect(mockGetBalances).not.toHaveBeenCalled()
  })

  it('returns error when SDK call fails', async () => {
    mockGetBalances.mockRejectedValue(new Error('RPC connection failed'))

    const result = await handleGetBalances({})

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('get_balances failed')
    expect(result.content[0].text).toContain('RPC connection failed')
  })
})
