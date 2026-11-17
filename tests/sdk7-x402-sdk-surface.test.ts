/**
 * B3 — SDK x402 / policy import surface (#2, #27, #28) and client wiring guards.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as agentwalletSdk from 'agentwallet-sdk'
import { createX402Client, SpendingPolicy, wrapWithX402, type PaymentIntent } from 'agentwallet-sdk'
import { assertX402BindingPayTo } from '../src/utils/x402-binding-checks.js'
import {
  assertParsableX402Amount,
  assertPaymentCap,
  effectiveCapBaseUnits,
  x402Debit,
} from '../src/utils/payment-cap.js'
import { createAgentPayX402Client } from '../src/utils/x402-client.js'
import { createWallet } from 'agentwallet-sdk'
import { createWalletClient, custom } from 'viem'
import { base } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

const x402ClientSource = readFileSync(new URL('../src/utils/x402-client.ts', import.meta.url), 'utf8')
const examplesSource = readFileSync(
  new URL('../examples/value-packs/shared/x402-client.ts', import.meta.url),
  'utf8'
)

describe('x402 #2 payTo binding', () => {
  it('#2 refuses padded payTo bytes', () => {
    expect(() => assertX402BindingPayTo(` ${'0x' + '11'.repeat(20)} `)).toThrow(/not a valid EVM address/)
  })
})

describe('x402 #27 fee-inclusive cap and #28 integer amounts', () => {
  it('#27 enforces fee-inclusive max_payment_eth cap', () => {
    const cap = assertPaymentCap('0.01')
    const max = effectiveCapBaseUnits(cap, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 8453)
    expect(x402Debit(10_000n)).toBeGreaterThan(max)
  })

  it('#28 refuses non-integer x402 amount strings', () => {
    expect(() => assertParsableX402Amount('1.25')).toThrow(/not a non-negative integer/)
  })
})

describe('PaymentIntent and SpendingPolicy SDK surface', () => {
  it('accepts plain PaymentIntent objects for SpendingPolicy.reserve', async () => {
    const intent: PaymentIntent = {
      merchant: '0x1111111111111111111111111111111111111111',
      amount: 1_000_000n,
    }
    const policy = new SpendingPolicy({ merchantAllowlist: [intent.merchant] })
    const out = await policy.reserve(intent)
    expect(['approved', 'rejected', 'draft']).toContain(out.status)
  })
})

describe('x402 #28 wrapWithX402 import surface', () => {
  function walkTsFiles(dir: string): string[] {
    const out: string[] = []
    for (const ent of readdirSync(dir)) {
      const p = join(dir, ent)
      if (statSync(p).isDirectory()) out.push(...walkTsFiles(p))
      else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
    }
    return out
  }

  it('#28 fails when any file under src imports wrapWithX402', () => {
    const root = new URL('../src', import.meta.url).pathname
    const offenders = walkTsFiles(root).filter((file) => {
      const text = readFileSync(file, 'utf8')
      return /\bimport\b[^;]*wrapWithX402/.test(text) || /\bfrom\s+['"][^'"]+['"][^;]*wrapWithX402/.test(text)
    })
    expect(offenders).toEqual([])
  })
  it('wrapWithX402 is exported and callable without autoPay', () => {
    expect(typeof wrapWithX402).toBe('function')
    const wallet = createWallet({
      accountAddress: '0x9999999999999999999999999999999999999999',
      chain: 'base',
      walletClient: createWalletClient({
        account: privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`),
        chain: base,
        transport: custom({ request: async () => null }),
      }),
    })
    const wrapped = wrapWithX402(
      async () => new Response('ok', { status: 200 }),
      wallet,
      { autoPay: false }
    )
    expect(typeof wrapped).toBe('function')
  })
})

describe('x402 #23 handler follow-up URL binding', () => {
  it('refuses when payment-required resource.url does not match the probe request', async () => {
    const wallet = createWallet({
      accountAddress: '0x9999999999999999999999999999999999999999',
      chain: 'base',
      walletClient: createWalletClient({
        account: privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`),
        chain: base,
        transport: custom({ request: async () => null }),
      }),
    })
    const paymentRequired = {
      x402Version: 1,
      resource: { url: 'https://shop.example.com/other?item=b' },
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
    const { client } = createAgentPayX402Client(wallet, {
      chainId: 8453,
      maxPaymentEth: '1',
      approved: { payTo: '0x1111111111111111111111111111111111111111' },
      transport,
    })
    await expect(client.fetch('https://shop.example.com/buy?item=a')).rejects.toThrow(/path|query/)
  })

  it('refuses when probe URL is /resource/b but request was /buy?item=a', async () => {
    const wallet = createWallet({
      accountAddress: '0x9999999999999999999999999999999999999999',
      chain: 'base',
      walletClient: createWalletClient({
        account: privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`),
        chain: base,
        transport: custom({ request: async () => null }),
      }),
    })
    const paymentRequired = {
      x402Version: 1,
      resource: { url: 'https://shop.example.com/resource/b' },
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
    const transport = async () => {
      const probe = new Response(JSON.stringify(paymentRequired), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      })
      Object.defineProperty(probe, 'url', {
        value: 'https://shop.example.com/resource/b',
        configurable: true,
      })
      return probe
    }
    const { client } = createAgentPayX402Client(wallet, {
      chainId: 8453,
      maxPaymentEth: '1',
      approved: { payTo: '0x1111111111111111111111111111111111111111' },
      transport,
    })
    await expect(client.fetch('https://shop.example.com/buy?item=a')).rejects.toThrow(/path|query/)
  })
})

describe('createX402Client construction guard', () => {
  it('createAgentPayX402Client calls createX402Client exactly once per factory call', () => {
    const spy = vi.spyOn(agentwalletSdk, 'createX402Client')
    const wallet = createWallet({
      accountAddress: '0x9999999999999999999999999999999999999999',
      chain: 'base',
      walletClient: createWalletClient({
        account: privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`),
        chain: base,
        transport: custom({ request: async () => null }),
      }),
    })
    createAgentPayX402Client(wallet, {
      chainId: 8453,
      maxPaymentEth: '1',
      approved: { payTo: '0x1111111111111111111111111111111111111111' },
      transport: async () => new Response('ok', { status: 200 }),
    })
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('MCP handlers use the shared factory, not direct createX402Client', () => {
    expect(x402ClientSource).toContain('createX402Client(wallet')
    expect(x402ClientSource).not.toContain('wrapWithX402')
    expect(examplesSource).toContain('createX402Client(wallet')
    expect(typeof wrapWithX402).toBe('function')
  })
})
