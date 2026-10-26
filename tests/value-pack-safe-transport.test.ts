/**
 * Codex review of PR #90 (pass 4, P1): the value-pack examples must use the
 * same outbound transport as the MCP x402 path — private/metadata
 * destinations refused before any request, DNS pinned, no automatic
 * redirects, bounded bodies — for the probe, the paid retry, and free fetches.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ settleCalls: 0 }))

vi.mock('agentwallet-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('agentwallet-sdk')>()
  return {
    ...actual,
    // Authorizes through the real approval guard, settles, then performs the
    // paid retry with the transport it is handed (never global fetch).
    createX402Client: (_wallet: unknown, config: {
      onBeforePayment: (_req: unknown, _url: string) => boolean
      onPaymentComplete: (_log: unknown) => void
    }) => ({
      settle402AndRetry: async (_probe: Response, url: string, init: RequestInit, fetchImpl: typeof fetch) => {
        sdk.settleCalls++
        const offer = {
          scheme: 'exact',
          network: 'base-sepolia:84532',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amount: '10000',
          payTo: '0x1111111111111111111111111111111111111111',
        }
        if (!config.onBeforePayment(offer, url)) throw new Error('refused')
        config.onPaymentComplete({ amount: 10_000n, recipient: offer.payTo, token: offer.asset, txHash: '0x' + 'ab'.repeat(32) })
        return fetchImpl(url, { ...init, headers: { ...(init.headers as Record<string, string>), 'X-PAYMENT': 'proof' } })
      },
    }),
  }
})

import { _setSafeTransportTestOverrides, MAX_DISPLAY_BODY_BYTES } from '../src/utils/safe-fetch.js'
import { installDefaultTransportOverrides } from './setup/test-env.js'
import { createPaymentApproval } from '../examples/value-packs/shared/usdc-approval.js'
import { fetchFree, fetchWithPayment, probeEndpoint } from '../examples/value-packs/shared/x402-client.js'
import { VALUE_PACK_NETWORKS } from '../examples/value-packs/shared/usdc-approval.js'

const SEPOLIA = VALUE_PACK_NETWORKS['base-sepolia:84532']
const PUBLIC = [{ address: '93.184.215.14', family: 4 }]

afterEach(() => {
  vi.unstubAllGlobals()
  installDefaultTransportOverrides()
})

describe('value-pack outbound requests use the safe transport', () => {
  it.each([
    'https://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/admin',
    'http://paid.example/api/market-data',
  ])('probe and free fetch refuse %s before any request', async (url) => {
    const connector = vi.fn()
    _setSafeTransportTestOverrides({ resolver: async () => PUBLIC, connector })
    const info = await probeEndpoint(url, 1000, { network: SEPOLIA })
    expect(info).toMatchObject({ payable: false })
    expect((info as { reason: string }).reason).toMatch(/refused/i)
    expect(await fetchFree(url)).toBeNull()
    expect(connector).not.toHaveBeenCalled()
  })

  it('refuses a public-looking name that resolves into private space', async () => {
    const connector = vi.fn()
    _setSafeTransportTestOverrides({ resolver: async () => [{ address: '10.0.0.8', family: 4 }], connector })
    const info = await probeEndpoint('https://internal-alias.example.com/api', 1000, { network: SEPOLIA })
    expect(info).toMatchObject({ payable: false })
    expect(connector).not.toHaveBeenCalled()
  })

  it('pays through the safe transport, never global fetch, and caps the paid body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('global fetch must not be used')
    }))
    const seen: string[] = []
    _setSafeTransportTestOverrides({
      resolver: async () => PUBLIC,
      connector: async (url, init) => {
        const paid = new Headers(init.headers).has('X-PAYMENT')
        seen.push(paid ? 'paid' : 'probe')
        return paid
          ? new Response('x'.repeat(MAX_DISPLAY_BODY_BYTES + 4096), { status: 200 })
          : new Response('payment required', { status: 402 })
      },
    })
    const approval = createPaymentApproval({
      endpoint: 'https://paid.example/api/market-data',
      method: 'GET',
      network: 'base-sepolia:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: '0x1111111111111111111111111111111111111111',
      amount: 10_000n,
      capUsd: '0.010077',
    })
    const wallet = { chain: { id: 84532 } } as unknown as Parameters<typeof fetchWithPayment>[0]
    const result = await fetchWithPayment(wallet, 'https://paid.example/api/market-data', { approval })
    expect(seen).toEqual(['probe', 'paid'])
    expect(sdk.settleCalls).toBe(1)
    expect(result.paymentMade).toBe(true)
    expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(MAX_DISPLAY_BODY_BYTES)
  })
})
