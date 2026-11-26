/**
 * SO round-4 repro cases for x402 #23 / #25 (committed before guard fixes).
 * Round B1/B2: decoy PAYMENT-REQUIRED header bypass and O(n^2) URL normalize.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as agentwalletSdk from 'agentwallet-sdk'
import { createWallet, encodeX402PaymentHeader } from 'agentwallet-sdk'
import { createWalletClient, custom } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { createAgentPayX402Client } from '../src/utils/x402-client.js'
import {
  assertBoundedX402PaymentRequired,
  guardX402ProbeResponse,
  normalizeX402ComparableUrl,
  X402_MAX_402_BODY_BYTES,
  X402_MAX_402_JSON_DEPTH,
  X402MalformedPaymentRequiredError,
} from '../src/utils/x402-402-guard.js'

const PAYEE = '0x1111111111111111111111111111111111111111'

function walletFixture() {
  return createWallet({
    accountAddress: '0x9999999999999999999999999999999999999999',
    chain: 'base',
    walletClient: createWalletClient({
      account: privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`),
      chain: base,
      transport: custom({ request: async () => null }),
    }),
  })
}

const baseReq = {
  x402Version: 1,
  resource: { url: 'https://shop.example.com/buy?item=a' },
  accepts: [
    {
      scheme: 'exact',
      network: 'base:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1000',
      payTo: PAYEE,
      maxTimeoutSeconds: 60,
    },
  ],
}

describe('x402 #27 payment proof replay', () => {
  it('#27 refuses replaying a captured payment proof on a second request URL', async () => {
    const settle = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.spyOn(agentwalletSdk, 'createX402Client').mockReturnValue({
      settle402AndRetry: settle,
    } as never)
    const PAYEE = '0x1111111111111111111111111111111111111111'
    const payReq = {
      x402Version: 1,
      resource: { url: 'https://shop.example.com/first' },
      accepts: [
        {
          scheme: 'exact',
          network: 'base:8453',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount: '1000',
          payTo: PAYEE,
          maxTimeoutSeconds: 60,
        },
      ],
    }
    const transport = async (url: string) => {
      return new Response(JSON.stringify({ ...payReq, resource: { url } }), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const { client } = createAgentPayX402Client(walletFixture(), {
      chainId: 8453,
      maxPaymentEth: '1',
      approved: { payTo: PAYEE },
      transport,
    })
    await client.fetch('https://shop.example.com/first')
    await client.fetch('https://shop.example.com/second')
    expect(settle).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
  })
})

describe('x402 SO #23 resource.url binding via client.fetch', () => {
  it('SO #23 refuses when resource.url ?item=b but request was ?item=a (no payment)', async () => {
    const settle = vi.fn().mockRejectedValue(new Error('payment should not run'))
    vi.spyOn(agentwalletSdk, 'createX402Client').mockReturnValue({
      settle402AndRetry: settle,
    } as never)
    const paymentRequired = {
      ...baseReq,
      resource: { url: 'https://shop.example.com/buy?item=b' },
    }
    const transport = async () => {
      const probe = new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      })
      Object.defineProperty(probe, 'url', {
        value: 'https://shop.example.com/buy?item=a',
        configurable: true,
      })
      return probe
    }
    const { client } = createAgentPayX402Client(walletFixture(), {
      chainId: 8453,
      maxPaymentEth: '1',
      approved: { payTo: PAYEE },
      transport,
    })
    await expect(client.fetch('https://shop.example.com/buy?item=a')).rejects.toThrow(/query/)
    expect(settle).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe('x402 SO #25 bounded 402 body', () => {
  it('SO #25 size cap is checked before JSON parse (200 KiB invalid JSON)', async () => {
    const junk = 'not-json'.padEnd(200 * 1024, 'x')
    const probe = new Response(junk, { status: 402 })
    const spy = vi.spyOn(JSON, 'parse')
    await expect(guardX402ProbeResponse('https://api.example.com/pay', probe)).rejects.toThrow(
      /exceeds/
    )
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('SO #25 fails closed on invalid JSON under the byte cap', async () => {
    const probe = new Response('not-json-at-all', { status: 402 })
    await expect(guardX402ProbeResponse('https://api.example.com/pay', probe)).rejects.toThrow(
      /not valid JSON/
    )
  })

  it('SO #25 fails closed on invalid UTF-8', async () => {
    const probe = new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { status: 402 })
    await expect(guardX402ProbeResponse('https://api.example.com/pay', probe)).rejects.toThrow()
  })

  it('SO #25 depth-10000 nested chain fails within 10s', () => {
    let nested: Record<string, unknown> = {}
    let cursor = nested
    for (let i = 0; i < 10_000; i++) {
      const next: Record<string, unknown> = {}
      cursor.n = next
      cursor = next
    }
    const payload = { ...baseReq, nested }
    const start = Date.now()
    expect(() => assertBoundedX402PaymentRequired(payload)).toThrow(/depth/)
    expect(Date.now() - start).toBeLessThan(10_000)
  })
})

const REQUEST_URL = 'https://shop.example.com/buy?item=a'
const ITEM_B_BODY = {
  ...baseReq,
  resource: { url: 'https://shop.example.com/buy?item=b' },
}

const WELL_FORMED_ACCEPT = baseReq.accepts[0]

const DECOY_EMPTY_ACCEPTS = { accepts: [] as unknown[] }
const DECOY_VERSION_2 = { x402Version: 2, accepts: [] as unknown[] }
const DECOY_NO_RESOURCE = { x402Version: 1, accepts: [WELL_FORMED_ACCEPT] }

function itemBProbe(headers?: HeadersInit, body: BodyInit | null = JSON.stringify(ITEM_B_BODY)): Response {
  const probe = new Response(body, {
    status: 402,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
  Object.defineProperty(probe, 'url', {
    value: REQUEST_URL,
    configurable: true,
  })
  return probe
}

function neverClosingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {
        /* never enqueues, never closes */
      })
    },
  })
}

function watchPaymentCallbacks() {
  const onBeforePayment = vi.fn()
  const signing = vi.spyOn(agentwalletSdk, 'agentTransferToken').mockImplementation(() => {
    throw new Error('x402 signing must not run')
  })
  const originalCreate = agentwalletSdk.createX402Client
  const createSpy = vi.spyOn(agentwalletSdk, 'createX402Client').mockImplementation((wallet, config) => {
    const inner = config.onBeforePayment
    return originalCreate(wallet, {
      ...config,
      onBeforePayment: async (req, url) => {
        onBeforePayment(req, url)
        if (!inner) return true
        return inner(req, url)
      },
    })
  })
  return {
    onBeforePayment,
    signing,
    restore() {
      createSpy.mockRestore()
      signing.mockRestore()
    },
  }
}

function paidClientFor(transport: (url: string) => Promise<Response>) {
  return createAgentPayX402Client(walletFixture(), {
    chainId: 8453,
    maxPaymentEth: '1',
    approved: { payTo: PAYEE },
    transport,
  }).client
}

async function expectRefusedBeforePayment(
  transport: (url: string) => Promise<Response>,
  spies: ReturnType<typeof watchPaymentCallbacks>
): Promise<unknown> {
  const { client } = createAgentPayX402Client(walletFixture(), {
    chainId: 8453,
    maxPaymentEth: '1',
    approved: { payTo: PAYEE },
    transport,
  })
  const error = await client.fetch(REQUEST_URL).then(
    () => {
      throw new Error('expected 402 guard to refuse before payment')
    },
    (err: unknown) => err
  )
  expect(spies.onBeforePayment).not.toHaveBeenCalled()
  expect(spies.signing).not.toHaveBeenCalled()
  return error
}

describe('x402 B1 decoy PAYMENT-REQUIRED header must not skip body validation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['{accepts:[]}', DECOY_EMPTY_ACCEPTS],
    ['{x402Version:2,accepts:[]}', DECOY_VERSION_2],
    ['no resource.url', DECOY_NO_RESOURCE],
  ] as const)(
    'B1 decoy PAYMENT-REQUIRED %s with ?item=b body never calls onBeforePayment or signing',
    async (_label, decoy) => {
      const spies = watchPaymentCallbacks()
      const error = await expectRefusedBeforePayment(async () => {
        return itemBProbe({ 'PAYMENT-REQUIRED': encodeX402PaymentHeader(decoy) })
      }, spies)
      expect(error).toBeInstanceOf(X402MalformedPaymentRequiredError)
      spies.restore()
    }
  )

  it('B1 decoy PAYMENT-REQUIRED plus a 2 MiB body is refused before onBeforePayment', async () => {
    const spies = watchPaymentCallbacks()
    const huge = { ...ITEM_B_BODY, pad: 'z'.repeat(2 * 1024 * 1024) }
    const error = await expectRefusedBeforePayment(async () => {
      return itemBProbe(
        { 'PAYMENT-REQUIRED': encodeX402PaymentHeader(DECOY_EMPTY_ACCEPTS) },
        JSON.stringify(huge)
      )
    }, spies)
    expect(error).toBeInstanceOf(X402MalformedPaymentRequiredError)
    expect((error as Error).message).toMatch(/exceeds/)
    spies.restore()
  })

  it(
    'B1 decoy PAYMENT-REQUIRED plus a never-closing body is refused within 10s',
    async () => {
      const spies = watchPaymentCallbacks()
      const client = paidClientFor(async () => {
        return itemBProbe(
          { 'PAYMENT-REQUIRED': encodeX402PaymentHeader(DECOY_EMPTY_ACCEPTS) },
          neverClosingBody()
        )
      })
      const start = Date.now()
      const hung = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('never-closing 402 body hung past 10s')), 11_000)
      })
      const error = await Promise.race([client.fetch(REQUEST_URL), hung]).then(
        () => {
          throw new Error('expected 402 guard to refuse a never-closing body')
        },
        (err: unknown) => err
      )
      expect(error).toBeInstanceOf(X402MalformedPaymentRequiredError)
      expect((error as Error).message).toMatch(/timed out/)
      expect(Date.now() - start).toBeLessThan(11_000)
      expect(spies.onBeforePayment).not.toHaveBeenCalled()
      expect(spies.signing).not.toHaveBeenCalled()
      spies.restore()
    },
    15_000
  )

  it('B1 decoy header bypass regression: control (no header) throws follow-up query does not match; decoy is also refused before onBeforePayment', async () => {
    const spies = watchPaymentCallbacks()
    const control = await expectRefusedBeforePayment(async () => itemBProbe(), spies)
    expect(control).toBeInstanceOf(X402MalformedPaymentRequiredError)
    expect((control as Error).message).toMatch(/follow-up query does not match/)
    expect(spies.onBeforePayment).not.toHaveBeenCalled()

    spies.onBeforePayment.mockClear()
    spies.signing.mockClear()
    const decoy = await expectRefusedBeforePayment(async () => {
      return itemBProbe({ 'PAYMENT-REQUIRED': encodeX402PaymentHeader(DECOY_EMPTY_ACCEPTS) })
    }, spies)
    expect(decoy).toBeInstanceOf(X402MalformedPaymentRequiredError)
    expect(spies.onBeforePayment).not.toHaveBeenCalled()
    expect(spies.signing).not.toHaveBeenCalled()
    spies.restore()
  })
})

describe('x402 B2 linear-time URL normalize', () => {
  it('B2 32 KB resource URL with 8000 repeated keys is refused with X402MalformedPaymentRequiredError in under 100 ms', () => {
    const resourceUrl = `https://shop.example.com/buy?${Array.from({ length: 8000 }, () => 'k=1').join('&')}`.padEnd(
      32 * 1024,
      '0'
    )
    expect(resourceUrl.length).toBeGreaterThanOrEqual(32 * 1024)
    const start = performance.now()
    expect(() => normalizeX402ComparableUrl(resourceUrl)).toThrow(X402MalformedPaymentRequiredError)
    expect(performance.now() - start).toBeLessThan(100)
  }, 60_000)
})