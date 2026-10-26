/**
 * F1 — x402_session_start must never pay twice for one intended session,
 * F15 — paid entry points refuse unsafe destinations before any request,
 * and x402_quote reads terms without paying.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const MOCK_TX_HASH = '0x' + 'ab'.repeat(32)
const PAYEE = '0xfeedfacefeedfacefeedfacefeedfacefeedface'
const mockSignMessage = vi.fn()

vi.mock('agentwallet-sdk', () => ({
  isEvmTxHash: (value: unknown) => typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value),
  classifySpendError: (error: unknown) => ({
    status: 'released' as const,
    retrySafe: true,
    txHashes: [] as string[],
    reason: error instanceof Error ? error.message : String(error ?? ''),
  }),
  createX402Client: vi.fn(),
  SpendingPolicy: vi.fn(),
  checkBudget: vi.fn(),
  resolveAssetAddress: () => null,
  getGlobalRegistry: vi.fn(() => ({
    getTokenByAddress: () => ({ symbol: 'USDC', decimals: 6 }),
    getToken: () => ({ symbol: 'USDC', decimals: 6, address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }),
  })),
}))

vi.mock('../src/utils/client.js', () => ({
  getConfig: vi.fn(() => ({
    walletAddress: '0x1234567890123456789012345678901234567890',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
  })),
  getWallet: vi.fn(() => ({
    address: '0x1234567890123456789012345678901234567890',
    walletClient: { signMessage: mockSignMessage },
    chain: { id: 8453 },
  })),
  _resetSingletons: vi.fn(),
}))

import { createX402Client } from 'agentwallet-sdk'
import { handleX402SessionStart } from '../src/tools/session.js'
import { handleX402Pay, handleX402Quote } from '../src/tools/x402.js'
import { _clearAllSessions } from '../src/session/manager.js'
import { _resetSpendIntentStore, _spendIntentStoreSizes } from '../src/utils/spend-intent.js'
import { _setSafeTransportTestOverrides } from '../src/utils/safe-fetch.js'
import { install402ProbeConnector } from './helpers/x402-harness.js'

const mockCreate = vi.mocked(createX402Client)
const ENDPOINT = 'https://api.example.com/v1'
const START = { endpoint: ENDPOINT, max_payment_eth: '5', pay_to: PAYEE } as const

type Config = { onPaymentComplete?: (log: Record<string, unknown>) => void }

/** An SDK double whose paid fetch settles, then behaves as `after` says. */
function payingClient(after: (cfg: Config) => Promise<Response>, payments: { count: number }) {
  mockCreate.mockImplementation(((_wallet: unknown, cfg: Config) => ({
    settle402AndRetry: async () => {
      payments.count++
      cfg.onPaymentComplete?.({
        timestamp: Math.floor(Date.now() / 1000),
        amount: 1_000_000n,
        token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        recipient: PAYEE,
        txHash: MOCK_TX_HASH,
      })
      return after(cfg)
    },
  })) as never)
}

beforeEach(() => {
  vi.clearAllMocks()
  install402ProbeConnector()
  _clearAllSessions()
  _resetSpendIntentStore()
  mockSignMessage.mockResolvedValue('0x' + '11'.repeat(65))
})

describe('x402_session_start idempotency (F1)', () => {
  it('two concurrent starts for the same endpoint settle once', async () => {
    const payments = { count: 0 }
    payingClient(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return new Response('ok', { status: 200 })
    }, payments)

    const [a, b] = await Promise.all([handleX402SessionStart(START), handleX402SessionStart(START)])
    expect(payments.count).toBe(1)
    expect(a.isError).toBeUndefined()
    expect(b.isError).toBeUndefined()
    expect(b.content[0]!.text).toContain('Active Session Already Covers This Endpoint')
  })

  it('overlapping starts on the same origin (different paths) are serialised', async () => {
    const payments = { count: 0 }
    payingClient(async () => new Response('ok', { status: 200 }), payments)
    await Promise.all([
      handleX402SessionStart(START),
      handleX402SessionStart({ ...START, endpoint: `${ENDPOINT}/sub` }),
    ])
    // The /v1 prefix session covers /v1/sub, so the second never pays.
    expect(payments.count).toBe(1)
  })

  it.each([
    ['the paid response body cannot be read', 'body'],
    ['local signing fails', 'sign'],
  ])('locks after settlement when %s — a retry never pays again', async (_label, mode) => {
    const payments = { count: 0 }
    payingClient(async () => {
      if (mode === 'body') {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error('connection reset mid-body'))
            },
          }),
          { status: 200 }
        )
      }
      return new Response('ok', { status: 200 })
    }, payments)
    if (mode === 'sign') mockSignMessage.mockRejectedValueOnce(new Error('signer unavailable'))

    const first = await handleX402SessionStart(START)
    expect(first.isError).toBe(true)
    expect(first.content[0]!.text).toContain('failed after settlement')
    expect(first.content[0]!.text).toContain(MOCK_TX_HASH)

    // Every variant the review used to step around an endpoint-scoped lock,
    // plus a one-off x402_pay to the same origin: all refused, none pays.
    const variants = [
      handleX402SessionStart({ ...START, method: 'POST', body: '{"x":1}' }),
      handleX402SessionStart({ ...START, scope: 'exact' }),
      handleX402SessionStart({ ...START, endpoint: `${ENDPOINT}/` }),
      handleX402SessionStart({ ...START, endpoint: `${ENDPOINT}?` }),
      handleX402SessionStart({ ...START, endpoint: `${ENDPOINT}?retry=1` }),
      handleX402SessionStart({ ...START, endpoint: 'https://api.example.com/other' }),
      handleX402Pay({
        url: 'https://api.example.com/one-off',
        method: 'GET',
        timeout_ms: 5000,
        skip_session_check: true,
        max_payment_eth: '5',
        pay_to: PAYEE,
      }),
    ]
    for (const retry of await Promise.all(variants)) {
      expect(retry.isError).toBe(true)
      expect(retry.content[0]!.text).toContain('New x402 payments to api.example.com are locked')
    }
    expect(payments.count).toBe(1)

    // The same payee behind another host is the same payee: refused.
    const samePayee = await handleX402SessionStart({ ...START, endpoint: 'https://other.example.net/v1' })
    expect(samePayee.content[0]!.text).toContain(`New x402 payments to payee ${PAYEE} are locked`)
    expect(payments.count).toBe(1)

    // A different host AND a different payee is not blocked (it reaches payment).
    const elsewhere = await handleX402SessionStart({
      ...START,
      endpoint: 'https://other.example.net/v1',
      pay_to: '0x1111111111111111111111111111111111111111',
    })
    expect(elsewhere.content[0]!.text).not.toContain('New x402 payments to')
    expect(payments.count).toBe(2)
  })

  it('a failure before payment stays retryable', async () => {
    let calls = 0
    mockCreate.mockImplementation(((_w: unknown, cfg: Config) => ({
      settle402AndRetry: async () => {
        calls++
        if (calls === 1) throw new Error('facilitator unreachable')
        cfg.onPaymentComplete?.({
          timestamp: 1,
          amount: 1n,
          token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          recipient: PAYEE,
          txHash: MOCK_TX_HASH,
        })
        return new Response('ok', { status: 200 })
      },
    })) as never)
    expect((await handleX402SessionStart(START)).isError).toBe(true)
    expect((await handleX402SessionStart(START)).isError).toBeUndefined()
    expect(calls).toBe(2)
  })
})

describe('outbound destination control (F15)', () => {
  it.each([
    'https://169.254.169.254/latest/meta-data/',
    'https://127.0.0.1/admin',
    'https://[::1]/admin',
    'http://api.example.com/plaintext',
    'https://user:pw@api.example.com/',
    'https://metadata.google.internal/computeMetadata/v1/',
  ])('x402_pay and x402_session_start refuse %s before any request', async (url) => {
    const connector = vi.fn()
    _setSafeTransportTestOverrides({ connector, resolver: async () => [{ address: '93.184.215.14', family: 4 }] })
    const pay = await handleX402Pay({
      url,
      method: 'GET',
      timeout_ms: 5000,
      skip_session_check: true,
      max_payment_eth: '1',
      pay_to: PAYEE,
    })
    const start = await handleX402SessionStart({ ...START, endpoint: url })
    expect(pay.isError).toBe(true)
    expect(start.isError).toBe(true)
    expect(pay.content[0]!.text).toContain('Refused outbound request')
    expect(connector).not.toHaveBeenCalled()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('refuses a public-looking name that resolves into private space', async () => {
    const connector = vi.fn()
    _setSafeTransportTestOverrides({
      connector,
      resolver: async () => [{ address: '10.0.0.8', family: 4 }],
    })
    const pay = await handleX402Pay({
      url: 'https://internal-alias.example.com/',
      method: 'GET',
      timeout_ms: 5000,
      skip_session_check: true,
      max_payment_eth: '1',
      pay_to: PAYEE,
    })
    expect(pay.isError).toBe(true)
    expect(connector).not.toHaveBeenCalled()
  })
})

describe('x402_quote', () => {
  it('returns validated terms from a 402 without paying', async () => {
    const challenge = {
      x402Version: 1,
      resource: { url: 'https://api.example.com/premium' },
      accepts: [
        { scheme: 'exact', network: 'base:8453', asset: 'USDC', amount: '10000', payTo: PAYEE, maxTimeoutSeconds: 60 },
        { scheme: 'exact', network: 'base:8453', asset: 'USDC', amount: '1', payTo: '0x0000000000000000000000000000000000000000', maxTimeoutSeconds: 60 },
        { scheme: 'exact', network: 'solana:mainnet', asset: 'USDC', amount: '1', payTo: 'So1ana', maxTimeoutSeconds: 60 },
      ],
    }
    _setSafeTransportTestOverrides({
      resolver: async () => [{ address: '93.184.215.14', family: 4 }],
      connector: async () =>
        new Response(JSON.stringify(challenge), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
    })
    const result = await handleX402Quote({ url: 'https://api.example.com/premium', method: 'GET', timeout_ms: 5000 })
    const text = result.content[0]!.text
    expect(result.isError).toBeUndefined()
    expect(text).toContain('no payment made')
    const trustedBlock = text.split('📄')[0]!
    expect(trustedBlock).toContain(PAYEE)
    expect(trustedBlock).toContain('"amount_base_units": "10000"')
    // zero-address and off-network offers are not presented as payable
    expect(trustedBlock).not.toContain('0x0000000000000000000000000000000000000000')
    expect(trustedBlock).not.toContain('solana')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('refuses unsafe destinations like the paid tools', async () => {
    const result = await handleX402Quote({ url: 'https://169.254.169.254/', method: 'GET', timeout_ms: 5000 })
    expect(result.isError).toBe(true)
  })
})
