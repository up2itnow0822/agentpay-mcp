/**
 * send_payment / send_token only report Sent when receipts include a matching Transfer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getAddress, type Address } from 'viem'
import * as agentwalletSdk from 'agentwallet-sdk'
import { erc20TransferLog, executedWalletLog } from './helpers/erc20-logs.js'
import { agentTransferTokenWithOutcome } from '../src/utils/agent-transfer-outcome.js'
import { createWallet } from 'agentwallet-sdk'
import { createWalletClient, custom } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

const ACCOUNT = '0x9999999999999999999999999999999999999999' as Address
const AGENT_KEY = ('0x' + '11'.repeat(32)) as `0x${string}`
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const TO = '0x1111111111111111111111111111111111111111' as Address
const TX = ('0x' + 'ee'.repeat(32)) as `0x${string}`

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

describe('Sent classification with real Transfer logs', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('send_token path classifies executed when Transfer matches amount', async () => {
    const wallet = makeWallet()
    const walletAddr = getAddress(wallet.address)
    vi.spyOn(agentwalletSdk, 'agentTransferToken').mockResolvedValue(TX)
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockResolvedValue({
      status: 'success',
      logs: [
        executedWalletLog(walletAddr, TO, 5n),
        erc20TransferLog(USDC, walletAddr, TO, 5n),
      ],
    } as never)
    const out = await agentTransferTokenWithOutcome(wallet, { token: USDC, to: TO, amount: 5n }, 'send_token')
    expect(out.status).toBe('executed')
    expect(out.txHash).toBe(TX)
  })

  it('send_payment path classifies executed when Transfer matches amount', async () => {
    const wallet = makeWallet()
    const walletAddr = getAddress(wallet.address)
    vi.spyOn(agentwalletSdk, 'agentTransferToken').mockResolvedValue(TX)
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockResolvedValue({
      status: 'success',
      logs: [
        executedWalletLog(walletAddr, TO, 10_000_000n),
        erc20TransferLog(USDC, walletAddr, TO, 10_000_000n),
      ],
    } as never)
    const out = await agentTransferTokenWithOutcome(
      wallet,
      { token: USDC, to: TO, amount: 10_000_000n },
      'send_payment'
    )
    expect(out.status).toBe('executed')
  })
})
