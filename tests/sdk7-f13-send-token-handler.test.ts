/**
 * CTO #13 — send_token handler-level receipt classification.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import { createWalletClient, custom, getAddress, type Address, type Hex } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import * as agentwalletSdk from 'agentwallet-sdk'
import { createWallet, getGlobalRegistry } from 'agentwallet-sdk'
import { erc20TransferLog, executedWalletLog } from './helpers/erc20-logs.js'
import { handleSendToken } from '../src/tools/transfers.js'
import { getWallet } from '../src/utils/client.js'
import { _resetSpendIntentStore } from '../src/utils/spend-intent.js'

const ACCOUNT = '0x9999999999999999999999999999999999999999' as Address
const AGENT_KEY = ('0x' + '11'.repeat(32)) as `0x${string}`
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const TO = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address
const TX = ('0x' + 'aa'.repeat(32)) as Hex

function makeWallet() {
  return createWallet({
    accountAddress: ACCOUNT,
    chain: 'base',
    walletClient: createWalletClient({
      account: privateKeyToAccount(AGENT_KEY),
      chain: base,
      transport: custom({ request: async () => null }),
    }),
  })
}

let wallet = makeWallet()

vi.mock('../src/utils/wallet-binding.js', () => ({
  assertExpectedSmartWallet: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/utils/client.js', () => ({
  getConfig: vi.fn(() => ({
    chainId: 8453,
    walletAddress: ACCOUNT,
  })),
  getWallet: vi.fn(() => wallet),
}))

vi.mock('agentwallet-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('agentwallet-sdk')>()
  return {
    ...actual,
    getGlobalRegistry: vi.fn(),
  }
})

const usdcSend = {
  tokenSymbol: 'USDC',
  chainId: 8453,
  recipientAddress: TO,
  amount: '0.000005',
}

function mockUsdcRegistry() {
  vi.mocked(getGlobalRegistry).mockReturnValue({
    getToken: vi.fn().mockReturnValue({
      symbol: 'USDC',
      address: USDC,
      decimals: 6,
      chainId: 8453,
    }),
  } as never)
}

function receiptWithTransfer(to: Address, amount: bigint) {
  const walletAddr = getAddress(wallet.address)
  return {
    status: 'success' as const,
    logs: [executedWalletLog(walletAddr, to, amount), erc20TransferLog(USDC, walletAddr, to, amount)],
  }
}

describe('#13 send_token handler receipt guards', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    wallet = makeWallet()
    vi.mocked(getWallet).mockReturnValue(wallet)
    vi.mocked(getGlobalRegistry).mockReset()
    _resetSpendIntentStore()
    mockUsdcRegistry()
    vi.spyOn(agentwalletSdk, 'agentTransferToken').mockResolvedValue(TX)
  })

  it('#13 handler refuses wrong Transfer recipient in receipt', async () => {
    const walletAddr = getAddress(wallet.address)
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockResolvedValue({
      status: 'success',
      logs: [
        executedWalletLog(walletAddr, TO, 5n),
        erc20TransferLog(USDC, walletAddr, OTHER, 5n),
      ],
    } as never)
    const result = await handleSendToken(usdcSend)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/matching ERC-20 Transfer/)
    expect(agentwalletSdk.agentTransferToken).toHaveBeenCalledTimes(1)
  })

  it('#13 handler refuses wrong Transfer amount in receipt', async () => {
    const walletAddr = getAddress(wallet.address)
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockResolvedValue({
      status: 'success',
      logs: [
        executedWalletLog(walletAddr, TO, 5n),
        erc20TransferLog(USDC, walletAddr, TO, 4n),
      ],
    } as never)
    const result = await handleSendToken(usdcSend)
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/matching ERC-20 Transfer/)
  })

  it('#13 same-key retry does not re-sign or broadcast twice', async () => {
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockResolvedValue(
      receiptWithTransfer(TO, 5n) as never
    )
    const first = await handleSendToken({ ...usdcSend, idempotencyKey: 'inv-13' })
    const retry = await handleSendToken({ ...usdcSend, idempotencyKey: 'inv-13' })
    expect(JSON.parse(first.content[0].text).idempotentRetry).toBeUndefined()
    expect(JSON.parse(retry.content[0].text).idempotentRetry).toBe(true)
    expect(agentwalletSdk.agentTransferToken).toHaveBeenCalledTimes(1)
  })

  it('#13 handler reports success when receipt includes matching Transfer log', async () => {
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockResolvedValue(
      receiptWithTransfer(TO, 5n) as never
    )
    const result = await handleSendToken(usdcSend)
    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.success).toBe(true)
    expect(data.txHash).toBe(TX)
    expect(data.to).toBe(TO)
  })
})