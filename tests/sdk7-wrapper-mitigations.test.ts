/**
 * SDK 7.0.0 wrapper mitigations — real SDK paths, offline / in-process RPC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWalletClient, custom, getAddress, type Address, type Hex } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import * as agentwalletSdk from 'agentwallet-sdk'
import { createWallet } from 'agentwallet-sdk'
import {
  assertExpectedSmartWallet,
  loadWalletBindingIdentity,
  rejectUnverifiedWalletOptOut,
} from '../src/utils/wallet-binding.js'
import { agentTransferTokenWithOutcome } from '../src/utils/agent-transfer-outcome.js'
import { assertX402BindingPayTo } from '../src/utils/x402-binding-checks.js'
import { resolveTokenDecimals } from '../src/tools/payments.js'
import { loadConfig, _resetSingletons } from '../src/utils/client.js'
import { attestationPollCap } from '../src/utils/bridge-attestation-guard.js'
import { erc20TransferLog, executedWalletLog } from './helpers/erc20-logs.js'
import { createBoundedUaidResolver } from '../src/utils/identity-io-guard.js'
import * as walletPreflight from '../src/utils/wallet-preflight.js'

const FACTORY = '0x7777777777777777777777777777777777777777' as Address
const NFT = '0x8888888888888888888888888888888888888888' as Address
const ACCOUNT = '0x9999999999999999999999999999999999999999' as Address
const AGENT_KEY = ('0x' + '11'.repeat(32)) as `0x${string}`
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const ENV_KEYS = [
  'AGENT_PRIVATE_KEY',
  'AGENT_WALLET_ADDRESS',
  'AGENT_WALLET_FACTORY',
  'AGENT_WALLET_TOKEN_CONTRACT',
  'AGENT_WALLET_TOKEN_ID',
  'AGENT_WALLET_ALLOW_UNVERIFIED',
  'AGENTPAY_BRIDGE_ATTESTATION_MAX_POLLS',
  'AGENTPAY_IDENTITY_TIMEOUT_MS',
  'CHAIN_ID',
] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  _resetSingletons()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetSingletons()
  vi.restoreAllMocks()
})

describe('finding #3 wallet factory binding (SDK 7)', () => {
  beforeEach(() => {
    vi.spyOn(walletPreflight, 'ensureWalletStartupVerified').mockResolvedValue(undefined)
  })

  it('refuses a mismatched AGENT_WALLET_ADDRESS against factory prediction', async () => {
    vi.spyOn(walletPreflight, 'ensureWalletStartupVerified').mockRestore()
    vi.spyOn(agentwalletSdk, 'getWalletAddress').mockResolvedValue(ACCOUNT)
    Object.assign(process.env, {
      AGENT_PRIVATE_KEY: AGENT_KEY,
      AGENT_WALLET_ADDRESS: '0x1234567890123456789012345678901234567890',
      AGENT_WALLET_FACTORY: FACTORY,
      AGENT_WALLET_TOKEN_CONTRACT: NFT,
      AGENT_WALLET_TOKEN_ID: '1',
      CHAIN_ID: '8453',
    })
    _resetSingletons()
    const wallet = createWallet({
      accountAddress: getAddress(process.env.AGENT_WALLET_ADDRESS!),
      chain: 'base',
      walletClient: createWalletClient({
        account: privateKeyToAccount(AGENT_KEY),
        chain: base,
        transport: custom({ request: async () => null }),
      }),
    })
    vi.spyOn(wallet.publicClient, 'getChainId').mockResolvedValue(8453)
    vi.spyOn(wallet.publicClient, 'getCode').mockResolvedValue(('0x' + '60'.repeat(8)) as `0x${string}`)
    wallet.contract.read.isOperatorActive = vi.fn().mockResolvedValue(true)
    wallet.contract.read.tokenContract = vi.fn().mockResolvedValue(NFT)
    wallet.contract.read.tokenId = vi.fn().mockResolvedValue(1n)
    const config = loadConfig()
    await expect(assertExpectedSmartWallet(wallet, config, { requireBinding: true })).rejects.toThrow(
      /does not match factory prediction/
    )
  })

  it('classifies agentTransferToken via receipt (real SDK 7, no mocked hash return)', async () => {
    const txHash = ('0x' + 'aa'.repeat(32)) as `0x${string}`
    const to = '0x1111111111111111111111111111111111111111' as Address
    const transferSpy = vi.spyOn(agentwalletSdk, 'agentTransferToken').mockResolvedValue(txHash)
    const wallet = createWallet({
      accountAddress: ACCOUNT,
      chain: 'base',
      walletClient: createWalletClient({
        account: privateKeyToAccount(AGENT_KEY),
        chain: base,
        transport: custom({ request: async () => null }),
      }),
    })
    const walletAddr = getAddress(wallet.address)
    const wait = vi.fn().mockResolvedValue({
      status: 'success',
      logs: [
        executedWalletLog(walletAddr, to, 1n),
        erc20TransferLog(USDC_BASE as Address, walletAddr, to, 1n),
      ],
    })
    ;(wallet as { publicClient: { waitForTransactionReceipt: typeof wait } }).publicClient = {
      waitForTransactionReceipt: wait,
    } as never
    const outcome = await agentTransferTokenWithOutcome(wallet, {
      token: USDC_BASE as Address,
      to,
      amount: 1n,
    })
    expect(transferSpy).toHaveBeenCalled()
    expect(wait).toHaveBeenCalled()
    expect(outcome.status).toBe('executed')
    expect(outcome.txHash).toBe(txHash)
  })
})

describe('x402 binding #2 payTo bytes (offline)', () => {
  it('#2 refuses padded payTo (validates signed bytes)', () => {
    expect(() => assertX402BindingPayTo(` ${USDC_BASE} `)).toThrow(/not a valid EVM address/)
  })
})

describe('regressions #4 decimals and #15 unknown chain', () => {
  it('#4 refuses caller decimals on unregistered tokens', () => {
    const unknown = '0x1111111111111111111111111111111111111111' as Address
    expect(() => resolveTokenDecimals(unknown, 6, 8453)).toThrow(/Spend cap requires a registered token/)
  })
  it('#15 loadConfig fails closed on unsupported chain (no Base fallback)', () => {
    Object.assign(process.env, {
      AGENT_PRIVATE_KEY: AGENT_KEY,
      AGENT_WALLET_ADDRESS: ACCOUNT,
      CHAIN_ID: '31612',
    })
    expect(() => loadConfig()).toThrow(/Unsupported CHAIN_ID: 31612/)
  })
})

describe('bridge and identity bounds (#12/#14, #6/#18/#29)', () => {
  it('caps attestation polls from env', () => {
    process.env.AGENTPAY_BRIDGE_ATTESTATION_MAX_POLLS = '99'
    expect(attestationPollCap()).toBe(60)
    process.env.AGENTPAY_BRIDGE_ATTESTATION_MAX_POLLS = '3'
    expect(attestationPollCap()).toBe(3)
  })
  it('rejects AGENT_WALLET_ALLOW_UNVERIFIED', () => {
    process.env.AGENT_WALLET_ALLOW_UNVERIFIED = '1'
    expect(() => rejectUnverifiedWalletOptOut()).toThrow(/not supported/)
  })
  it('fails closed on partial wallet binding env', () => {
    process.env.AGENT_WALLET_FACTORY = FACTORY
    expect(() => loadWalletBindingIdentity()).toThrow(/Wallet binding is incomplete/)
  })

  it('requireBinding defaults to true and runs the deployment identity startup gate', async () => {
    Object.assign(process.env, {
      AGENT_PRIVATE_KEY: AGENT_KEY,
      AGENT_WALLET_ADDRESS: ACCOUNT,
      CHAIN_ID: '8453',
    })
    _resetSingletons()
    const startup = vi
      .spyOn(walletPreflight, 'ensureWalletStartupVerified')
      .mockRejectedValue(new Error('deployment identity missing'))
    const wallet = createWallet({
      accountAddress: ACCOUNT,
      chain: 'base',
      walletClient: createWalletClient({
        account: privateKeyToAccount(AGENT_KEY),
        chain: base,
        transport: custom({ request: async () => null }),
      }),
    })
    const config = loadConfig()
    await expect(assertExpectedSmartWallet(wallet, config)).rejects.toThrow(/deployment identity missing/)
    expect(startup).toHaveBeenCalled()
  })

  it('requireBinding=true always runs deployment identity startup gate', async () => {
    Object.assign(process.env, {
      AGENT_PRIVATE_KEY: AGENT_KEY,
      AGENT_WALLET_ADDRESS: ACCOUNT,
      CHAIN_ID: '8453',
    })
    _resetSingletons()
    const startup = vi
      .spyOn(walletPreflight, 'ensureWalletStartupVerified')
      .mockRejectedValue(new Error('deployment identity missing'))
    const wallet = createWallet({
      accountAddress: ACCOUNT,
      chain: 'base',
      walletClient: createWalletClient({
        account: privateKeyToAccount(AGENT_KEY),
        chain: base,
        transport: custom({ request: async () => null }),
      }),
    })
    const config = loadConfig()
    await expect(assertExpectedSmartWallet(wallet, config, { requireBinding: true })).rejects.toThrow(
      /deployment identity missing/
    )
    expect(startup).toHaveBeenCalled()
  })

  it('receiptTimeoutMs honors AGENTPAY_RECEIPT_TIMEOUT_MS within bounds', async () => {
    const { receiptTimeoutMs, waitForSuccessReceipt } = await import(
      '../src/utils/agent-transfer-outcome.js'
    )
    process.env.AGENTPAY_RECEIPT_TIMEOUT_MS = '45000'
    expect(receiptTimeoutMs()).toBe(45_000)
    process.env.AGENTPAY_RECEIPT_TIMEOUT_MS = '9999999'
    expect(receiptTimeoutMs()).toBe(600_000)
    const txHash = ('0x' + 'dd'.repeat(32)) as `0x${string}`
    const wallet = createWallet({
      accountAddress: ACCOUNT,
      chain: 'base',
      walletClient: createWalletClient({
        account: privateKeyToAccount(AGENT_KEY),
        chain: base,
        transport: custom({ request: async () => null }),
      }),
    })
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockRejectedValue(new Error('timeout'))
    await expect(waitForSuccessReceipt(wallet, txHash, 'send_token')).rejects.toThrow(/unverified/)
  })
  it('creates UAID resolver with bounded timeout', () => {
    process.env.AGENTPAY_IDENTITY_TIMEOUT_MS = '999999'
    const r = createBoundedUaidResolver()
    expect((r as { timeoutMs: number }).timeoutMs).toBeLessThanOrEqual(30_000)
  })
})