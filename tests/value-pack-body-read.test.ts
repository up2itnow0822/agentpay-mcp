/**
 * Codex review of PR #90 (P1): in the value-pack client, a paid response
 * whose body stream fails AFTER settlement must surface as a PaymentAwareError
 * carrying the settled amount — never a raw transport error that withRetry
 * would retry (re-entering a consumed approval) or that a caller's daily
 * budget would not count.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TX = '0x' + 'ef'.repeat(32)

vi.mock('agentwallet-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('agentwallet-sdk')>()
  return {
    ...actual,
    // A client that authorizes through the real approval guard, settles, and
    // then delivers a body that dies mid-stream.
    createX402Client: (_wallet: unknown, config: {
      onBeforePayment: (_req: unknown, _url: string) => boolean
      onPaymentComplete: (_log: unknown) => void
    }) => ({
      // Production probes through the safe transport and hands the 402 here.
      settle402AndRetry: async (_probe: Response, url: string) => {
        const offer = {
          scheme: 'exact',
          network: 'base-sepolia:84532',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          amount: '10000',
          payTo: '0x1111111111111111111111111111111111111111',
        }
        if (!config.onBeforePayment(offer, url)) throw new Error('refused')
        config.onPaymentComplete({
          amount: 10_000n,
          recipient: offer.payTo,
          token: offer.asset,
          txHash: TX,
        })
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('connection reset mid-body'))
            },
          }),
          { status: 200 }
        )
      },
    }),
  }
})

import { _setSafeTransportTestOverrides } from '../src/utils/safe-fetch.js'
import { installDefaultTransportOverrides } from './setup/test-env.js'
import { createPaymentApproval } from '../examples/value-packs/shared/usdc-approval.js'
import { fetchWithPayment } from '../examples/value-packs/shared/x402-client.js'
import { PaymentAwareError, settledPaymentAmount, withRetry } from '../examples/value-packs/shared/payment-retry.js'

const ENDPOINT = 'https://paid.example/api/market-data'

function approval() {
  return createPaymentApproval({
    endpoint: ENDPOINT,
    method: 'GET',
    network: 'base-sepolia:84532',
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    payTo: '0x1111111111111111111111111111111111111111',
    amount: 10_000n,
    capUsd: '0.010077',
  })
}

const wallet = { chain: { id: 84532 } } as unknown as Parameters<typeof fetchWithPayment>[0]

beforeEach(() => {
  // The unpaid probe answers 402 through the safe transport.
  _setSafeTransportTestOverrides({
    resolver: async () => [{ address: '93.184.215.14', family: 4 }],
    connector: async () => new Response('payment required', { status: 402 }),
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  installDefaultTransportOverrides()
})

describe('value-pack paid body read after settlement', () => {
  it('surfaces a PaymentAwareError with the settled amount, and withRetry does not re-enter', async () => {
    let attempts = 0
    const error = await withRetry(
      async () => {
        attempts++
        return fetchWithPayment(wallet, ENDPOINT, { approval: approval() })
      },
      { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 }
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(PaymentAwareError)
    expect((error as PaymentAwareError).paymentMade).toBe(true)
    expect((error as PaymentAwareError).txHash).toBe(TX)
    expect(settledPaymentAmount(error)).toBeCloseTo(0.01)
    expect(attempts).toBe(1)
  })
})
