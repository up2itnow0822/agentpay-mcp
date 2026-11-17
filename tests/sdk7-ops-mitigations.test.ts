/**
 * Ops/SO mitigation map — one named test per finding id (SDK 7.0.0, offline).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeEventTopics, parseAbiItem, type Address, type Hex } from 'viem'
import * as agentwalletSdk from 'agentwallet-sdk'
import { attachSwap, createBridge, ERC8004Client } from 'agentwallet-sdk'
import { handleSwapTokens } from '../src/tools/swap.js'
import { handleVerifyAgentUAID } from '../src/tools/identity.js'
import { handleBridgeUsdc, handleBridgeUsdcExecution } from '../src/tools/bridge.js'
import {
  assertBoundedX402PaymentRequired,
  assertX402FollowUpUrlMatches,
  guardX402ProbeResponse,
  readBounded402JsonBody,
  X402_MAX_402_ACCEPTS,
  X402_MAX_402_BODY_BYTES,
  X402_MAX_402_JSON_DEPTH,
  X402MalformedPaymentRequiredError,
} from '../src/utils/x402-402-guard.js'
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
import {
  BrokerResponseReadTimeoutError,
  readBrokerResponseWithCap,
} from '../src/utils/identity-broker-fetch.js'
import { MESSAGE_TRANSMITTER_V2 } from 'agentwallet-sdk'
import { _resetSpendIntentStore } from '../src/utils/spend-intent.js'
import { _resetPolicyStore, handleSetSpendPolicy } from '../src/tools/budget.js'
import { ERC20_TRANSFER_TOPIC } from './helpers/erc20-logs.js'
import { receiptTimeoutMs } from '../src/utils/agent-transfer-outcome.js'

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

  it('B4 accepts swap_tokens without minAmountOut while route A is disabled', async () => {
    const result = await handleSwapTokens({
      fromSymbol: 'USDC',
      toSymbol: 'WETH',
      amount: '1',
      chainId: 8453,
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/disabled in AgentPay MCP 5\.0\.0 \(route A\)/)
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

describe('F4 #6 brokerAttested only (5.0.x — no on-chain verified)', () => {
  const UAID =
    'uaid:aid:eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;uid=42;proto=erc8004'

  it('F4 #6 never sets verified true and does not call ERC-8004 lookup', async () => {
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
    const lookup = vi.spyOn(ERC8004Client.prototype, 'lookupAgentIdentity').mockClear()
    lookup.mockReset()

    const trusted = JSON.parse((await handleVerifyAgentUAID({ uaid: UAID })).content[0].text)
    expect(trusted.brokerAttested).toBe(true)
    expect(trusted.verified).toBe(false)
    expect(trusted.identity).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('F4 #18 identity broker transport cap', () => {
  it('F4 #18 refuses broker responses above 256 KiB', async () => {
    const body = 'y'.repeat(256 * 1024 + 4)
    await expect(readBrokerResponseWithCap(new Response(body))).rejects.toThrow(/limit/)
  })

  it('#18 refuses a broker body that slow-drips past the read deadline', async () => {
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 80))
        controller.enqueue(new Uint8Array([0x7b]))
      },
    })
    const response = new Response(stream)
    await expect(readBrokerResponseWithCap(response, 256 * 1024, 120)).rejects.toBeInstanceOf(
      BrokerResponseReadTimeoutError
    )
  })
})

describe('F4 #29 identity cache TTL ceiling', () => {
  it('F4 #29 clamps AGENTPAY_IDENTITY_CACHE_TTL_MS to the configured maximum', () => {
    process.env.AGENTPAY_IDENTITY_CACHE_TTL_MS = '99999999'
    expect(identityIo.identityIoLimitsFromEnv().cacheTtlMs).toBe(MAX_IDENTITY_CACHE_TTL_MS)
    process.env.AGENTPAY_IDENTITY_TIMEOUT_MS = '99999999'
    expect(identityIo.identityIoLimitsFromEnv().timeoutMs).toBe(MAX_IDENTITY_TIMEOUT_MS)
  })

  it('#29 builds a fresh UAID resolver on each verify_agent_uaid call', async () => {
    const UAID =
      'uaid:aid:eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;uid=42;proto=erc8004'
    const factory = vi.spyOn(identityIo, 'createBoundedUaidResolver')
    factory.mockClear()
    const resolve = vi.fn().mockResolvedValue({
      resolved: true,
      uaid: UAID,
      protocol: 'erc8004',
      chain: 'eip155:8453',
      registryVerified: false,
      identity: null,
    })
    factory.mockImplementation(() => ({ resolve }) as never)
    await handleVerifyAgentUAID({ uaid: UAID })
    await handleVerifyAgentUAID({ uaid: UAID })
    expect(factory).toHaveBeenCalledTimes(2)
    expect(resolve).toHaveBeenCalledTimes(2)
    factory.mockRestore()
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

  it('#23 accepts normalized-equal resource URLs (case, port, slash, query order)', () => {
    expect(() =>
      assertX402FollowUpUrlMatches(
        'https://API.EXAMPLE.com:443/pay/?b=2&a=1',
        'https://api.example.com/pay?a=1&b=2'
      )
    ).not.toThrow()
  })

  it('#23 refuses when normalized URLs differ only by query value', () => {
    expect(() =>
      assertX402FollowUpUrlMatches(
        'https://api.example.com/buy?item=a',
        'https://api.example.com/buy?item=b'
      )
    ).toThrow(/query/)
  })

  it('#23 resolves a relative resource.url against the probe request', () => {
    expect(() =>
      assertX402FollowUpUrlMatches(
        'https://api.example.com/v1/resource?x=1',
        '/v1/resource?x=1'
      )
    ).not.toThrow()
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

  it('x402 #25 depth-10000 nested chain fails closed without stack overflow', () => {
    let nested: Record<string, unknown> = {}
    let cursor = nested
    for (let i = 0; i < 10_000; i++) {
      const next: Record<string, unknown> = {}
      cursor.n = next
      cursor = next
    }
    const payload = { ...baseReq, nested }
    expect(() => assertBoundedX402PaymentRequired(payload)).toThrow(/depth/)
  })

  it('x402 #25 refuses more than 16 accepts options', () => {
    const accepts = Array.from({ length: X402_MAX_402_ACCEPTS + 1 }, () => baseReq.accepts[0])
    expect(() =>
      assertBoundedX402PaymentRequired({ ...baseReq, accepts })
    ).toThrow(/accepts/)
  })

  it('x402 #25 accepts an empty 402 body without JSON (probe guard)', async () => {
    const probe = new Response('', { status: 402 })
    await expect(guardX402ProbeResponse('https://api.example.com/pay', probe)).resolves.toBeUndefined()
  })

  it('x402 #25 slow body still fails closed when it exceeds the byte cap', async () => {
    const big = JSON.stringify({ ...baseReq, pad: 'z'.repeat(X402_MAX_402_BODY_BYTES + 10) })
    const response = new Response(big)
    await expect(readBounded402JsonBody(response)).rejects.toThrow(/exceeds/)
  })

  it('x402 #25 guard refuses 200 KiB invalid JSON without swallowing the error', async () => {
    const junk = 'not-json'.padEnd(200 * 1024, 'x')
    const probe = new Response(junk, { status: 402 })
    await expect(guardX402ProbeResponse('https://api.example.com/pay', probe)).rejects.toThrow(
      /exceeds|not valid JSON/
    )
  })

  it('x402 #25 guard refuses invalid UTF-8 bodies', async () => {
    const bad = new Uint8Array([0xff, 0xfe, 0xfd])
    const probe = new Response(bad, { status: 402 })
    await expect(guardX402ProbeResponse('https://api.example.com/pay', probe)).rejects.toThrow()
  })

  it('x402 #25 guard refuses oversize valid JSON before structural checks', async () => {
    const big = JSON.stringify({ ...baseReq, pad: 'z'.repeat(X402_MAX_402_BODY_BYTES + 16) })
    const probe = new Response(big, { status: 402 })
    await expect(guardX402ProbeResponse('https://api.example.com/pay', probe)).rejects.toThrow(/exceeds/)
  })

  it('#25 AbortSignal caps a slow-dripping 402 body read at 10 seconds', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.timeout(80))
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        controller.enqueue(new Uint8Array([0x7b]))
      },
    })
    const probe = new Response(stream, { status: 402 })
    await expect(guardX402ProbeResponse('https://api.example.com/pay', probe)).rejects.toThrow(
      /timed out/
    )
    timeoutSpy.mockRestore()
  })
})

describe('F4 #11 bridge_usdc disabled (route A)', () => {
  it('F4 bridge_usdc MCP handler returns disabled without createBridge', async () => {
    const bridgeSpy = vi.spyOn(agentwalletSdk, 'createBridge')
    const result = await handleBridgeUsdc({ fromChain: 'base', toChain: 'polygon', amount: '1' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/disabled in AgentPay MCP 5\.0\.0 \(route A\)/)
    expect(bridgeSpy).not.toHaveBeenCalled()
  })
})

describe('SEC-20261116-05 bridge execution spend policy', () => {
  it('SEC-20261116-05 refuses over-limit bridge on execution path', async () => {
    _resetSpendIntentStore()
    _resetPolicyStore()
    await handleSetSpendPolicy({ dailyLimitEth: '0.001' })
    const result = await handleBridgeUsdcExecution({
      fromChain: 'base',
      toChain: 'polygon',
      amount: '100',
    })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/cap|policy|limit/i)
  })
})

describe('F4 identity #6 verified never true in 5.0.x', () => {
  const UAID =
    'uaid:aid:eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;uid=42;proto=erc8004'
  const OTHER_OWNER = '0x2222222222222222222222222222222222222222' as Address

  it('#6(a) verified stays false when broker owner mismatches UAID claims', async () => {
    const resolver = identityIo.createBoundedUaidResolver()
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      resolved: true,
      uaid: UAID,
      protocol: 'erc8004',
      chain: 'eip155:8453',
      registryVerified: true,
      identity: {
        agentId: '42',
        owner: OTHER_OWNER,
        agentURI: 'ipfs://broker',
        paymentAddress: OTHER_OWNER,
        registrationFile: null,
        protocol: 'erc8004',
        chain: 'eip155:8453',
        uaid: UAID,
      },
    })
    vi.spyOn(identityIo, 'createBoundedUaidResolver').mockReturnValue(resolver as never)
    const lookup = vi.spyOn(ERC8004Client.prototype, 'lookupAgentIdentity').mockClear()
    const trusted = JSON.parse((await handleVerifyAgentUAID({ uaid: UAID })).content[0].text)
    expect(trusted.brokerAttested).toBe(true)
    expect(trusted.verified).toBe(false)
    expect(trusted.identity).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('#6(b) verified false without on-chain lookup even when broker attests', async () => {
    const resolver = identityIo.createBoundedUaidResolver()
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      resolved: true,
      uaid: UAID,
      protocol: 'erc8004',
      chain: 'eip155:8453',
      registryVerified: true,
      identity: { agentId: '99', owner: AGENT, chain: 'eip155:8453', protocol: 'erc8004' },
    })
    vi.spyOn(identityIo, 'createBoundedUaidResolver').mockReturnValue(resolver as never)
    const lookup = vi.spyOn(ERC8004Client.prototype, 'lookupAgentIdentity').mockClear()
    const trusted = JSON.parse((await handleVerifyAgentUAID({ uaid: UAID })).content[0].text)
    expect(trusted.verified).toBe(false)
    expect(trusted.brokerAttested).toBe(true)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('#6(d) verified false when broker agentId disagrees with UAID uid', async () => {
    const resolver = identityIo.createBoundedUaidResolver()
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      resolved: true,
      uaid: UAID,
      protocol: 'erc8004',
      chain: 'eip155:8453',
      registryVerified: true,
      identity: {
        agentId: '99',
        owner: AGENT,
        chain: 'eip155:8453',
        protocol: 'erc8004',
      },
    })
    vi.spyOn(identityIo, 'createBoundedUaidResolver').mockReturnValue(resolver as never)
    const lookup = vi.spyOn(ERC8004Client.prototype, 'lookupAgentIdentity').mockClear()
    lookup.mockReset()
    const trusted = JSON.parse((await handleVerifyAgentUAID({ uaid: UAID })).content[0].text)
    expect(trusted.verified).toBe(false)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('#6(e) verified false when broker chain disagrees with UAID chain', async () => {
    const resolver = identityIo.createBoundedUaidResolver()
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      resolved: true,
      uaid: UAID,
      protocol: 'erc8004',
      chain: 'eip155:84532',
      registryVerified: true,
      identity: {
        agentId: '42',
        owner: AGENT,
        chain: 'eip155:84532',
        protocol: 'erc8004',
      },
    })
    vi.spyOn(identityIo, 'createBoundedUaidResolver').mockReturnValue(resolver as never)
    const lookup = vi.spyOn(ERC8004Client.prototype, 'lookupAgentIdentity')
    const trusted = JSON.parse((await handleVerifyAgentUAID({ uaid: UAID })).content[0].text)
    expect(trusted.verified).toBe(false)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('#6(c) non-EVM UAID never sets verified via ERC-8004', async () => {
    const solUaid = 'uaid:aid:solana:mainnet:So11111111111111111111111111111111111111112;uid=1;proto=solana'
    const resolver = identityIo.createBoundedUaidResolver()
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      resolved: true,
      uaid: solUaid,
      protocol: 'solana',
      chain: 'solana:mainnet',
      registryVerified: true,
      identity: {
        agentId: '1',
        owner: 'So11111111111111111111111111111111111111112',
        chain: 'solana:mainnet',
        protocol: 'solana',
      },
    })
    vi.spyOn(identityIo, 'createBoundedUaidResolver').mockReturnValue(resolver as never)
    const lookup = vi.spyOn(ERC8004Client.prototype, 'lookupAgentIdentity').mockClear()
    const trusted = JSON.parse((await handleVerifyAgentUAID({ uaid: solUaid })).content[0].text)
    expect(trusted.verified).toBe(false)
    expect(trusted.brokerAttested).toBe(true)
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('B1 Transfer topic and receipt timeout env', () => {
  const savedTimeout = process.env.AGENTPAY_RECEIPT_TIMEOUT_MS

  afterEach(() => {
    if (savedTimeout === undefined) delete process.env.AGENTPAY_RECEIPT_TIMEOUT_MS
    else process.env.AGENTPAY_RECEIPT_TIMEOUT_MS = savedTimeout
  })

  it('B1 ERC-20 Transfer topic matches encodeEventTopics(erc20Abi)', () => {
    const topics = encodeEventTopics({
      abi: [parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')],
      eventName: 'Transfer',
    })
    expect(topics[0]).toBe(ERC20_TRANSFER_TOPIC)
  })

  it('B1 pins canonical Transfer topic literal 0xddf252ad…', () => {
    expect(ERC20_TRANSFER_TOPIC).toBe(
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
    )
  })

  it('B1 rejects non-integer and sub-1000 AGENTPAY_RECEIPT_TIMEOUT_MS values', () => {
    process.env.AGENTPAY_RECEIPT_TIMEOUT_MS = 'not-a-number'
    expect(receiptTimeoutMs()).toBe(120_000)
    process.env.AGENTPAY_RECEIPT_TIMEOUT_MS = '500'
    expect(receiptTimeoutMs()).toBe(120_000)
    process.env.AGENTPAY_RECEIPT_TIMEOUT_MS = '0'
    expect(receiptTimeoutMs()).toBe(120_000)
  })
})