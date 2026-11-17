/**
 * Ops/SO mitigation map — one named test per finding id (SDK 7.0.0, offline).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWalletClient,
  custom,
  encodeEventTopics,
  encodeAbiParameters,
  getAddress,
  pad,
  toEventHash,
  type Address,
  type Hex,
} from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import * as agentwalletSdk from 'agentwallet-sdk'
import { attachSwap, createBridge, ERC8004Client } from 'agentwallet-sdk'
import { handleSwapTokens } from '../src/tools/swap.js'
import { handleVerifyAgentUAID } from '../src/tools/identity.js'
import { handleBridgeUsdc } from '../src/tools/bridge.js'
import {
  assertBoundedX402PaymentRequired,
  assertX402FollowUpUrlMatches,
  readBounded402JsonBody,
  X402_MAX_402_ACCEPTS,
  X402_MAX_402_BODY_BYTES,
  X402_MAX_402_JSON_DEPTH,
  X402MalformedPaymentRequiredError,
} from '../src/utils/x402-402-guard.js'
import {
  assertParsableX402Amount,
  assertPaymentCap,
  effectiveCapBaseUnits,
  x402Debit,
} from '../src/utils/payment-cap.js'
import {
  bridgeUsdcResumeAfterBurn,
  bridgeUsdcWithAttestationGuard,
  BridgeAttestationTimeoutError,
} from '../src/utils/bridge-attestation-guard.js'
import * as identityIo from '../src/utils/identity-io-guard.js'
import {
  MAX_IDENTITY_CACHE_TTL_MS,
  MAX_IDENTITY_TIMEOUT_MS,
} from '../src/utils/identity-io-guard.js'
import { readBrokerResponseWithCap } from '../src/utils/identity-broker-fetch.js'
import { MESSAGE_TRANSMITTER_V2 } from 'agentwallet-sdk'
import { _resetSpendIntentStore } from '../src/utils/spend-intent.js'
import { _resetPolicyStore, handleSetSpendPolicy } from '../src/tools/budget.js'

vi.mock('../src/utils/wallet-binding.js', () => ({
  assertExpectedSmartWallet: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/utils/identity-io-guard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/identity-io-guard.js')>()
  return actual
})

vi.mock('../src/utils/client.js', () => {
  const walletClient = {
    account: { address: '0x1234567890123456789012345678901234567890' },
    sendTransaction: vi.fn(),
    writeContract: vi.fn(),
  }
  return {
    getConfig: vi.fn(() => ({
      chainId: 8453,
      walletAddress: '0x1234567890123456789012345678901234567890',
    })),
    getWallet: vi.fn(() => ({
      address: '0x1234567890123456789012345678901234567890',
      walletClient,
      publicClient: {},
      chain: { id: 8453 },
    })),
    _resetSingletons: vi.fn(),
  }
})

const AGENT = '0x1234567890123456789012345678901234567890' as Address
const BURN_HASH = '0x' + 'ab'.repeat(32) as Hex
const MSG_BYTES = ('0x' + 'cd'.repeat(376)) as Hex
const MESSAGE_SENT_TOPIC =
  '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036' as Hex
const ATTEST = ('0x' + 'ee'.repeat(32)) as Hex

function messageSentLog(): { logs: Array<{ address: Address; topics: Hex[]; data: Hex }> } {
  const messageLength = (MSG_BYTES.length - 2) / 2
  const dataHex =
    '0'.repeat(64) +
    messageLength.toString(16).padStart(64, '0') +
    MSG_BYTES.slice(2)
  return {
    logs: [
      {
        address: MESSAGE_TRANSMITTER_V2.base,
        topics: [MESSAGE_SENT_TOPIC],
        data: (`0x${dataHex}`) as Hex,
      },
    ],
  }
}

describe('F4 #11 swap_tokens disabled (route A)', () => {
  it('F4 #11 returns a disabled error and never calls attachSwap', async () => {
    const swapSpy = vi.spyOn(agentwalletSdk, 'attachSwap')
    const result = await handleSwapTokens({
      fromSymbol: 'USDC',
      toSymbol: 'WETH',
      amount: '1',
      chainId: 8453,
      minAmountOut: '0.0001',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/disabled in AgentPay MCP 5\.0\.0 \(route A\)/)
    expect(swapSpy).not.toHaveBeenCalled()
  })
})

describe('F4 #12 bounded CCTP attestation poll', () => {
  const savedPolls = process.env.AGENTPAY_BRIDGE_ATTESTATION_MAX_POLLS

  beforeEach(() => {
    process.env.AGENTPAY_BRIDGE_ATTESTATION_MAX_POLLS = '1'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ messages: [] }), { status: 200 }))
    )
  })

  afterEach(() => {
    if (savedPolls === undefined) delete process.env.AGENTPAY_BRIDGE_ATTESTATION_MAX_POLLS
    else process.env.AGENTPAY_BRIDGE_ATTESTATION_MAX_POLLS = savedPolls
    vi.unstubAllGlobals()
  })

  it('F4 #12 attestation timeout returns burn tx hash and does not mint on retry burn', async () => {
    vi.useFakeTimers()
    const burn = vi.fn().mockResolvedValue({
      burnTxHash: BURN_HASH,
      messageBytes: MSG_BYTES,
      sourceDomain: 6,
      destinationDomain: 7,
      nonce: 1n,
    })
    const mint = vi.fn()
    const bridge = {
      burn,
      mint,
      publicClient: { getTransactionReceipt: vi.fn().mockResolvedValue(messageSentLog()) },
      walletClient: { account: { address: AGENT } },
      fromChain: 'base',
    }
    const guard = bridgeUsdcWithAttestationGuard(
      bridge as never,
      1_000_000n,
      'polygon',
      { attestationApiUrl: 'https://iris.test' },
      'base',
      'bridge-intent-1'
    )
    const assertTimeout = expect(guard).rejects.toBeInstanceOf(BridgeAttestationTimeoutError)
    await vi.advanceTimersByTimeAsync(15_000)
    await assertTimeout
    vi.useRealTimers()
    expect(burn).toHaveBeenCalledTimes(1)
    expect(mint).not.toHaveBeenCalled()
    const pending = {
      burnTxHash: BURN_HASH,
      messageBytes: MSG_BYTES,
      amount: 1_000_000n,
      toChain: 'polygon' as const,
      fromChain: 'base' as const,
      options: { attestationApiUrl: 'https://iris.test' },
      mintRecipient: AGENT,
      sourceDomain: 6,
      destinationDomain: 7,
      apiUrl: 'https://iris.test',
      nonce: 1n,
    }
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          messages: [{ status: 'complete', message: MSG_BYTES, attestation: ATTEST }],
        }),
        { status: 200 }
      )
    )
    mint.mockResolvedValue('0x' + '11'.repeat(32))
    const cctpGuard = await import('../src/utils/cctp-message-guard.js')
    vi.spyOn(cctpGuard, 'assertAttestedMessageMatchesBurn').mockImplementation(() => undefined)
    await bridgeUsdcResumeAfterBurn(bridge as never, pending)
    expect(burn).toHaveBeenCalledTimes(1)
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('F4 #12 refuses an oversized Circle attestation response', async () => {
    const { readAttestationResponseCapped } = await import('../src/utils/bridge-attestation-guard.js')
    const huge = 'x'.repeat(256 * 1024 + 1)
    await expect(readAttestationResponseCapped(new Response(huge))).rejects.toThrow(/limit/)
  })
})

describe('F4 #6 brokerAttested vs on-chain verified', () => {
  const UAID =
    'uaid:aid:eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;uid=42;proto=erc8004'

  it('F4 #6 reports brokerAttested from the broker and verified only after ERC-8004 read', async () => {
    const resolver = identityIo.createBoundedUaidResolver()
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      resolved: true,
      uaid: UAID,
      protocol: 'erc8004',
      chain: 'eip155:8453',
      registryVerified: true,
      identity: {
        agentId: '42',
        owner: AGENT,
        agentURI: 'https://evil.example/metadata',
        paymentAddress: AGENT,
        registrationFile: null,
        protocol: 'erc8004',
        chain: 'eip155:8453',
        uaid: UAID,
      },
    })
    vi.spyOn(identityIo, 'createBoundedUaidResolver').mockReturnValue(resolver as never)
    const lookup = vi
      .spyOn(ERC8004Client.prototype, 'lookupAgentIdentity')
      .mockResolvedValue({
        agentId: 42n,
        owner: AGENT,
        agentURI: 'ipfs://safe',
        agentWallet: AGENT,
        registrationFile: null,
      } as never)

    const trusted = JSON.parse((await handleVerifyAgentUAID({ uaid: UAID })).content[0].text)
    expect(trusted.brokerAttested).toBe(true)
    expect(lookup).toHaveBeenCalled()
    expect(trusted.verified).toBe(true)

    lookup.mockRejectedValueOnce(new Error('reverted'))
    const failTrusted = JSON.parse((await handleVerifyAgentUAID({ uaid: UAID })).content[0].text)
    expect(failTrusted.brokerAttested).toBe(true)
    expect(failTrusted.verified).toBe(false)
  })
})

describe('F4 #18 identity broker transport cap', () => {
  it('F4 #18 refuses broker responses above 256 KiB', async () => {
    const body = 'y'.repeat(256 * 1024 + 4)
    await expect(readBrokerResponseWithCap(new Response(body))).rejects.toThrow(/limit/)
  })
})

describe('F4 #29 identity cache TTL ceiling', () => {
  it('F4 #29 clamps AGENTPAY_IDENTITY_CACHE_TTL_MS to the configured maximum', () => {
    process.env.AGENTPAY_IDENTITY_CACHE_TTL_MS = '99999999'
    expect(identityIo.identityIoLimitsFromEnv().cacheTtlMs).toBe(MAX_IDENTITY_CACHE_TTL_MS)
    process.env.AGENTPAY_IDENTITY_TIMEOUT_MS = '99999999'
    expect(identityIo.identityIoLimitsFromEnv().timeoutMs).toBe(MAX_IDENTITY_TIMEOUT_MS)
  })
})

describe('x402 #23 follow-up URL binding', () => {
  it('x402 #23 refuses origin mismatch', () => {
    expect(() =>
      assertX402FollowUpUrlMatches(
        'https://api.example.com/a?x=1',
        'https://other.example.com/a?x=1'
      )
    ).toThrow(/origin/)
  })
  it('x402 #23 refuses path mismatch', () => {
    expect(() =>
      assertX402FollowUpUrlMatches(
        'https://api.example.com/a?x=1',
        'https://api.example.com/b?x=1'
      )
    ).toThrow(/path/)
  })
  it('x402 #23 refuses query mismatch', () => {
    expect(() =>
      assertX402FollowUpUrlMatches(
        'https://api.example.com/a?x=1',
        'https://api.example.com/a?x=2'
      )
    ).toThrow(/query/)
  })
})

describe('x402 #25 bounded 402 payload', () => {
  const baseReq = {
    x402Version: 1,
    resource: { url: 'https://api.example.com/pay' },
    accepts: [
      {
        scheme: 'exact',
        network: 'base:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: '1000',
        payTo: '0x1111111111111111111111111111111111111111',
        maxTimeoutSeconds: 60,
      },
    ],
  }

  it('x402 #25 refuses a JSON body above 64 KiB', async () => {
    const big = { ...baseReq, pad: 'z'.repeat(X402_MAX_402_BODY_BYTES) }
    const response = new Response(JSON.stringify(big))
    await expect(readBounded402JsonBody(response)).rejects.toThrow(/exceeds/)
  })

  it('x402 #25 refuses JSON deeper than 32 levels', () => {
    let deep: Record<string, unknown> = {}
    let cursor = deep
    for (let i = 0; i < X402_MAX_402_JSON_DEPTH + 2; i++) {
      const next: Record<string, unknown> = {}
      cursor.n = next
      cursor = next
    }
    const payload = { ...baseReq, deep }
    expect(() => assertBoundedX402PaymentRequired(payload)).toThrow(/depth/)
  })

  it('x402 #25 refuses more than 16 accepts options', () => {
    const accepts = Array.from({ length: X402_MAX_402_ACCEPTS + 1 }, () => baseReq.accepts[0])
    expect(() =>
      assertBoundedX402PaymentRequired({ ...baseReq, accepts })
    ).toThrow(/accepts/)
  })
})

describe('x402 #27 fee-inclusive cap and x402 #28 integer amounts', () => {
  it('x402 #27 enforces fee-inclusive max_payment_eth cap', () => {
    const cap = assertPaymentCap('0.01')
    const max = effectiveCapBaseUnits(cap, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 8453)
    expect(x402Debit(10_000n)).toBeGreaterThan(max)
  })

  it('x402 #28 refuses non-integer x402 amount strings', () => {
    expect(() => assertParsableX402Amount('1.25')).toThrow(/not a non-negative integer/)
  })
})

describe('SEC-20261116-05 bridge gating with spend policy', () => {
  it('SEC-20261116-05 refuses over-limit bridge when AGENTPAY_ENABLE_EOA_BRIDGE=1', async () => {
    process.env.AGENTPAY_ENABLE_EOA_BRIDGE = '1'
    _resetSpendIntentStore()
    _resetPolicyStore()
    await handleSetSpendPolicy({ dailyLimitEth: '0.001' })
    const result = await handleBridgeUsdc({
      fromChain: 'base',
      toChain: 'polygon',
      amount: '100',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/cap|policy|limit/i)
    delete process.env.AGENTPAY_ENABLE_EOA_BRIDGE
  })
})