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

const mockGetGlobalRegistry = vi.mocked(getGlobalRegistry)
const mockAgentTransferToken = vi.mocked(agentTransferToken)
const mockGetBalances = vi.mocked(getBalances)

describe('send_token', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('refuses send_token when chainId is not the wallet chain', async () => {
    const getToken = vi.fn().mockReturnValue({
      symbol: 'WETH',
      // Optimism and Base share this WETH address — the pre-fix bug would
      // transfer Base WETH while reporting chainId 10.
      address: '0x4200000000000000000000000000000000000006',
      decimals: 18,
      chainId: 10,
    })
    mockGetGlobalRegistry.mockReturnValue({ getToken } as any)

    const result = await handleSendToken({
      tokenSymbol: 'WETH',
      chainId: 10,
      recipientAddress: '0xrecipient00000000000000000000000000000001',
      amount: '1',
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('does not match the configured wallet chain')
    expect(getToken).not.toHaveBeenCalled()
    expect(mockAgentTransferToken).not.toHaveBeenCalled()
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
    expect(data.balances[0].rawBalance).toBe('1000000')
    expect(data.balances[1].rawBalance).toBe('500000000000000000')
  })

  it('uses the configured wallet chain when chainId matches', async () => {
    mockGetBalances.mockResolvedValue([] as any)

    await handleGetBalances({ chainId: 8453 })

    expect(mockGetBalances).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 8453 })
    )
  })

  it('refuses a chainId that does not match the configured wallet chain', async () => {
    const result = await handleGetBalances({ chainId: 10 })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('does not match the configured wallet chain')
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
