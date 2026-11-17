/**
 * CTO tests for SDK 7 wrapper findings #3, #13, #14.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWalletClient,
  custom,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  keccak256,
  pad,
  toEventHash,
  type Address,
  type Hex,
} from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import * as agentwalletSdk from 'agentwallet-sdk'
import { AgentAccountV2Abi, createWallet } from 'agentwallet-sdk'
import { _resetSingletons, loadConfig } from '../src/utils/client.js'
import { ensureWalletStartupVerified, requireDeploymentIdentityEnv, _resetWalletStartupGate } from '../src/utils/wallet-preflight.js'
import {
  UnverifiedSpendError,
  agentTransferTokenWithOutcome,
  waitForSuccessReceipt,
} from '../src/utils/agent-transfer-outcome.js'
import { agentExecuteWithOutcome } from '../src/utils/agent-execute-outcome.js'
import {
  assertAttestedMessageMatchesBurn,
  decodeCctpBurnMessage,
  extractMessageSentFromTransmitter,
} from '../src/utils/cctp-message-guard.js'
import { DefiniteSpendFailure } from '../src/utils/spend-intent.js'

const FACTORY = '0x7777777777777777777777777777777777777777' as Address
const NFT = '0x8888888888888888888888888888888888888888' as Address
const ACCOUNT = '0x9999999999999999999999999999999999999999' as Address
const AGENT_KEY = ('0x' + '11'.repeat(32)) as `0x${string}`
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address
const TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64' as Address

function queuedWalletLog(wallet: ReturnType<typeof makeWallet>, to: Address, txId: bigint) {
  const walletAddr = getAddress(wallet.address)
  return {
    address: walletAddr,
    topics: [
      toEventHash({
        type: 'event',
        name: 'TransactionQueued',
        inputs: [
          { name: 'txId', type: 'uint256', indexed: true },
          { name: 'to', type: 'address', indexed: true },
          { name: 'value', type: 'uint256', indexed: false },
          { name: 'token', type: 'address', indexed: false },
          { name: 'amount', type: 'uint256', indexed: false },
        ],
      }),
      pad(`0x${txId.toString(16)}`, { size: 32 }),
      pad(to, { size: 32 }),
    ] as [Hex, Hex, Hex],
    data: encodeAbiParameters(
      [
        { name: 'value', type: 'uint256' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      [0n, '0x0000000000000000000000000000000000000000', 0n]
    ),
  }
}

function erc20TransferLog(token: Address, from: Address, to: Address, amount: bigint) {
  return {
    address: getAddress(token),
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3efa' as Hex,
      pad(from, { size: 32 }),
      pad(to, { size: 32 }),
    ] as [Hex, Hex, Hex],
    data: pad(`0x${amount.toString(16)}`, { size: 32 }),
  }
}

function executedWalletLog(wallet: ReturnType<typeof makeWallet>, to: Address, value: bigint) {
  const walletAddr = getAddress(wallet.address)
  return {
    address: walletAddr,
    topics: [
      toEventHash({
        type: 'event',
        name: 'TransactionExecuted',
        inputs: [
          { name: 'target', type: 'address', indexed: true },
          { name: 'value', type: 'uint256', indexed: false },
          { name: 'data', type: 'bytes', indexed: false },
          { name: 'executor', type: 'address', indexed: true },
        ],
      }),
      pad(to, { size: 32 }),
      pad(walletAddr, { size: 32 }),
    ] as [Hex, Hex, Hex],
    data: encodeAbiParameters(
      [
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
      ],
      [value, '0x']
    ),
  }
}

function makeWallet(overrides: Record<string, unknown> = {}) {
  return createWallet({
    accountAddress: ACCOUNT,
    chain: 'base',
    walletClient: createWalletClient({
      account: privateKeyToAccount(AGENT_KEY),
      chain: base,
      transport: custom({ request: async () => null }),
    }),
    ...overrides,
  })
}

const ENV_KEYS = [
  'AGENT_PRIVATE_KEY',
  'AGENT_WALLET_ADDRESS',
  'AGENT_WALLET_FACTORY',
  'AGENT_WALLET_TOKEN_CONTRACT',
  'AGENT_WALLET_TOKEN_ID',
  'AGENT_WALLET_CODE_HASH',
  'CHAIN_ID',
  'AGENTPAY_RECEIPT_TIMEOUT_MS',
] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  _resetSingletons()
  _resetWalletStartupGate()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetSingletons()
  _resetWalletStartupGate()
  vi.restoreAllMocks()
})

function mockStartupEnv(codeHash?: string) {
  Object.assign(process.env, {
    AGENT_PRIVATE_KEY: AGENT_KEY,
    AGENT_WALLET_ADDRESS: ACCOUNT,
    AGENT_WALLET_FACTORY: FACTORY,
    AGENT_WALLET_TOKEN_CONTRACT: NFT,
    AGENT_WALLET_TOKEN_ID: '1',
    CHAIN_ID: '8453',
    ...(codeHash ? { AGENT_WALLET_CODE_HASH: codeHash } : {}),
  })
}

describe('#3 startup gate (a)-(f)', () => {
  it('(a) refuses when deployment identity env is missing', () => {
    Object.assign(process.env, { AGENT_PRIVATE_KEY: AGENT_KEY, AGENT_WALLET_ADDRESS: ACCOUNT })
    expect(() => requireDeploymentIdentityEnv()).toThrow(/Deployment identity required/)
  })

  it('(b) refuses chain id mismatch across RPC, config, and wallet client', async () => {
    mockStartupEnv()
    const wallet = makeWallet()
    vi.spyOn(wallet.publicClient, 'getChainId').mockResolvedValue(1)
    vi.spyOn(wallet.publicClient, 'getCode').mockResolvedValue('0x60006000' as Hex)
    wallet.contract.read = {
      ...wallet.contract.read,
      isOperatorActive: vi.fn().mockResolvedValue(true),
    }
    wallet.contract.read.tokenContract = vi.fn().mockResolvedValue(NFT)
    wallet.contract.read.tokenId = vi.fn().mockResolvedValue(1n)
    vi.spyOn(agentwalletSdk, 'getWalletAddress').mockResolvedValue(ACCOUNT)
    const config = loadConfig()
    await expect(ensureWalletStartupVerified(wallet, config)).rejects.toThrow(/Chain ID mismatch/)
  })

  it('(c) refuses empty code and 0xef0100 delegation prefix', async () => {
    mockStartupEnv()
    const wallet = makeWallet()
    vi.spyOn(wallet.publicClient, 'getChainId').mockResolvedValue(8453)
    vi.spyOn(wallet.publicClient, 'getCode').mockResolvedValueOnce('0x')
    wallet.contract.read = {
      ...wallet.contract.read,
      isOperatorActive: vi.fn().mockResolvedValue(true),
    }
    vi.spyOn(agentwalletSdk, 'getWalletAddress').mockResolvedValue(ACCOUNT)
    const config = loadConfig()
    await expect(ensureWalletStartupVerified(wallet, config)).rejects.toThrow(/no contract code/)

    vi.spyOn(wallet.publicClient, 'getCode').mockResolvedValue(
      ('0xef0100' + 'ab'.repeat(20)) as Hex
    )
    await expect(ensureWalletStartupVerified(wallet, config)).rejects.toThrow(/EIP-7702/)
  })

  it('(d) accepts keccak256(code) matching AGENT_WALLET_CODE_HASH', async () => {
    const code = ('0x' + '60'.repeat(20)) as Hex
    const hash = keccak256(code)
    Object.assign(process.env, {
      AGENT_PRIVATE_KEY: AGENT_KEY,
      AGENT_WALLET_ADDRESS: ACCOUNT,
      AGENT_WALLET_CODE_HASH: hash,
      CHAIN_ID: '8453',
    })
    delete process.env.AGENT_WALLET_FACTORY
    delete process.env.AGENT_WALLET_TOKEN_CONTRACT
    delete process.env.AGENT_WALLET_TOKEN_ID
    const wallet = makeWallet()
    vi.spyOn(wallet.publicClient, 'getChainId').mockResolvedValue(8453)
    vi.spyOn(wallet.publicClient, 'getCode').mockResolvedValue(code)
    Object.defineProperty(wallet.contract, 'read', {
      value: { isOperatorActive: vi.fn().mockResolvedValue(true) },
      configurable: true,
    })
    _resetWalletStartupGate()
    const config = loadConfig()
    await ensureWalletStartupVerified(wallet, config)
    await ensureWalletStartupVerified(wallet, config)
  })

  it('(e) refuses inactive operator EOA', async () => {
    mockStartupEnv()
    _resetWalletStartupGate()
    const wallet = makeWallet()
    vi.spyOn(wallet.publicClient, 'getChainId').mockResolvedValue(8453)
    vi.spyOn(wallet.publicClient, 'getCode').mockResolvedValue(('0x' + '60'.repeat(8)) as Hex)
    wallet.contract.read = {
      ...wallet.contract.read,
      isOperatorActive: vi.fn().mockResolvedValue(false),
      tokenContract: vi.fn().mockResolvedValue(NFT),
      tokenId: vi.fn().mockResolvedValue(1n),
    }
    vi.spyOn(agentwalletSdk, 'getWalletAddress').mockResolvedValue(ACCOUNT)
    await expect(ensureWalletStartupVerified(wallet, loadConfig())).rejects.toThrow(/not an active operator/)
  })

  it('(f) native execute requires TransactionExecuted or TransactionQueued', async () => {
    const txHash = ('0x' + 'bb'.repeat(32)) as Hex
    const wallet = makeWallet()
    wallet.contract.write = {
      ...wallet.contract.write,
      agentExecute: vi.fn().mockResolvedValue(txHash),
    }
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockResolvedValue({
      status: 'success',
      logs: [],
    } as never)
    await expect(
      agentExecuteWithOutcome(wallet, { to: '0x1111111111111111111111111111111111111111', value: 1n })
    ).rejects.toBeInstanceOf(UnverifiedSpendError)
  })
})

describe('#13 transfer receipt classification (a)-(e)', () => {
  const to = '0x1111111111111111111111111111111111111111' as Address
  const txHash = ('0x' + 'cc'.repeat(32)) as Hex

  it('(a) uses explicit receipt timeout', async () => {
    process.env.AGENTPAY_RECEIPT_TIMEOUT_MS = '5000'
    const wallet = makeWallet()
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockRejectedValue(new Error('timeout'))
    await expect(waitForSuccessReceipt(wallet, txHash, 'send_token')).rejects.toThrow(/sent, unverified/)
  })

  it('(b) queued stays queued and never reports executed without Transfer', async () => {
    const wallet = makeWallet()
    vi.spyOn(agentwalletSdk, 'agentTransferToken').mockResolvedValue(txHash)
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockResolvedValue({
      status: 'success',
      logs: [queuedWalletLog(wallet, to, 7n)],
    } as never)
    const out = await agentTransferTokenWithOutcome(wallet, { token: USDC_BASE, to, amount: 5n })
    expect(out.status).toBe('queued')
  })

  it('(c) executed requires matching ERC-20 Transfer', async () => {
    const wallet = makeWallet()
    vi.spyOn(agentwalletSdk, 'agentTransferToken').mockResolvedValue(txHash)
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockResolvedValue({
      status: 'success',
      logs: [
        executedWalletLog(wallet, to, 5n),
        erc20TransferLog(USDC_BASE, getAddress(wallet.address), to, 5n),
      ],
    } as never)
    const out = await agentTransferTokenWithOutcome(wallet, { token: USDC_BASE, to, amount: 5n })
    expect(out.status).toBe('executed')
  })

  it('(d) missing Transfer after TransactionExecuted is sent, unverified', async () => {
    const wallet = makeWallet()
    vi.spyOn(agentwalletSdk, 'agentTransferToken').mockResolvedValue(txHash)
    const executed = encodeEventTopics({
      abi: AgentAccountV2Abi,
      eventName: 'TransactionExecuted',
      args: { target: to, value: 5n, data: '0x', executor: getAddress(wallet.address) },
    })
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockResolvedValue({
      status: 'success',
      logs: [{ address: ACCOUNT, topics: executed, data: '0x' }],
    } as never)
    await expect(agentTransferTokenWithOutcome(wallet, { token: USDC_BASE, to, amount: 5n })).rejects.toThrow(
      /sent, unverified/
    )
  })

  it('(e) receipt timeout locks as unverified', async () => {
    process.env.AGENTPAY_RECEIPT_TIMEOUT_MS = '1'
    const wallet = makeWallet()
    vi.spyOn(agentwalletSdk, 'agentTransferToken').mockResolvedValue(txHash)
    vi.spyOn(wallet.publicClient, 'waitForTransactionReceipt').mockImplementation(
      () => new Promise((_r, reject) => setTimeout(() => reject(new Error('t')), 50))
    )
    await expect(agentTransferTokenWithOutcome(wallet, { token: USDC_BASE, to, amount: 1n })).rejects.toBeInstanceOf(
      UnverifiedSpendError
    )
  })
})

describe('#14 CCTP message guard (a)-(c)', () => {
  it('(a) messageBytes only from MESSAGE_TRANSMITTER_V2 MessageSent', () => {
    const msg = ('0x' + '11'.repeat(80)) as Hex
    const len = (msg.length - 2) / 2
    const data =
      pad('0x20', { size: 32 }).slice(2) +
      pad(`0x${len.toString(16)}`, { size: 32 }).slice(2) +
      msg.slice(2)
    const wrongEmitter = '0x1111111111111111111111111111111111111111' as Address
    expect(() =>
      extractMessageSentFromTransmitter(
        {
          logs: [
            {
              address: wrongEmitter,
              topics: ['0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036'],
              data: ('0x' + data) as Hex,
            },
          ],
        },
        TRANSMITTER
      )
    ).toThrow(/no MessageSent/)
    const extracted = extractMessageSentFromTransmitter(
      {
        logs: [
          {
            address: TRANSMITTER,
            topics: ['0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036'],
            data: ('0x' + data) as Hex,
          },
        ],
      },
      TRANSMITTER
    )
    expect(extracted.messageBytes.toLowerCase()).toBe(msg.toLowerCase())
  })

  it('(b) decode burn message fields', () => {
    const bodyOffset = 148
    const header = (
      '00000000' +
      '00000006' +
      '00000007'
    ).padEnd(bodyOffset * 2, '0')
    const padWord = (v: string) => v.padStart(64, '0')
    const body =
      padWord('1') +
      padWord(USDC_BASE.slice(2).toLowerCase()) +
      padWord(ACCOUNT.slice(2).toLowerCase()) +
      padWord('2a')
    const message = ('0x' + (header + body).padEnd(376 * 2, '0')) as Hex
    const decoded = decodeCctpBurnMessage(message)
    expect(decoded?.sourceDomain).toBe(6)
    expect(decoded?.destinationDomain).toBe(7)
    expect(getAddress(decoded!.burnToken)).toBe(getAddress(USDC_BASE))
    expect(decoded?.amount).toBe(42n)
  })

  it('(c) attested message must match burn domains, token, recipient, amount', () => {
    const message =
      ('0x0000000000000000000000000000000000000000000000000000000000000000' +
        '0000000000000000000000000000000000000000000000000000000000000006' +
        '0000000000000000000000000000000000000000000000000000000000000007' +
        '0'.repeat(1200)) as Hex
    expect(() =>
      assertAttestedMessageMatchesBurn(message, {
        sourceDomain: 99,
        destinationDomain: 7,
        amount: 1n,
        mintRecipient: ACCOUNT,
        fromChain: 'base',
        toChain: 'ethereum',
      })
    ).toThrow(DefiniteSpendFailure)
  })
})