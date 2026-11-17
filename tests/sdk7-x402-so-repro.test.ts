/**
 * SO round-4 repro cases for x402 #23 / #25 (committed before guard fixes).
 */
import { describe, expect, it, vi } from 'vitest'
import * as agentwalletSdk from 'agentwallet-sdk'
import { createWallet } from 'agentwallet-sdk'
import { createWalletClient, custom } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { createAgentPayX402Client } from '../src/utils/x402-client.js'
import {
  assertBoundedX402PaymentRequired,
  guardX402ProbeResponse,
  X402_MAX_402_BODY_BYTES,
  X402_MAX_402_JSON_DEPTH,
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