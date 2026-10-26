/**
 * F1 (round-2 review) — after an x402 payment settles without its response
 * being delivered, NO new x402 payment may reach the same service:
 *
 *   - aliases of the host (case, trailing root dot in any spelling, another
 *     port) are the same host;
 *   - the same payee behind any other host is the same payee;
 *   - a paid request answered with a non-2xx status was not delivered;
 *   - the lock survives a restart and a torn final journal record, because
 *     the host and payee ride on the intent's `begin` record, written before
 *     any wallet call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress } from 'viem'

const MOCK_TX_HASH = '0x' + 'cd'.repeat(32)
const PAYEE = '0xfeedfacefeedfacefeedfacefeedfacefeedface'
const OTHER_PAYEE = '0x1111111111111111111111111111111111111111'
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
import { handleX402Pay } from '../src/tools/x402.js'
import { _clearAllSessions, listAllSessions } from '../src/session/manager.js'
import {
  STATE_DIR_ENV,
  _resetSpendIntentStore,
  listUnresolvedSpendIntents,
  resolveSpendIntent,
  spendJournalPath,
} from '../src/utils/spend-intent.js'
import { runSpendIntentsCli } from '../src/cli/spend-intents.js'
import { install402ProbeConnector } from './helpers/x402-harness.js'

const mockCreate = vi.mocked(createX402Client)
type Config = { onPaymentComplete?: (_log: Record<string, unknown>) => void }

/** SDK double: every paid fetch settles, then answers with `after()`. */
function payingClient(after: () => Response, payments: { count: number }) {
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
      return after()
    },
  })) as never)
}

const brokenBody = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('connection reset mid-body'))
      },
    }),
    { status: 200 }
  )

const pay = (url: string, payTo = PAYEE, extra: Record<string, unknown> = {}) =>
  handleX402Pay({
    url,
    method: 'GET',
    timeout_ms: 5000,
    skip_session_check: true,
    max_payment_eth: '5',
    pay_to: payTo,
    ...extra,
  })

const start = (endpoint: string, payTo = PAYEE) =>
  handleX402SessionStart({ endpoint, max_payment_eth: '5', pay_to: payTo })

beforeEach(() => {
  vi.clearAllMocks()
  install402ProbeConnector()
  _clearAllSessions()
  _resetSpendIntentStore()
  mockSignMessage.mockResolvedValue('0x' + '11'.repeat(65))
})

afterEach(() => {
  delete process.env[STATE_DIR_ENV]
  _resetSpendIntentStore()
})

describe('host and payee locks after a settled-but-undelivered payment', () => {
  it('refuses every alias of the locked host', async () => {
    const payments = { count: 0 }
    payingClient(brokenBody, payments)
    const first = await start('https://merchant.example.com/paid')
    expect(first.content[0]!.text).toContain('failed after settlement')
    expect(payments.count).toBe(1)

    for (const alias of [
      'https://merchant.example.com./other',
      'https://merchant.example.com%2e/other',
      'https://merchant.example.com。/other',
      'https://merchant.example.com:8443/other',
      'https://MERCHANT.Example.COM/other',
    ]) {
      // A different payee too: the host alone must hold the lock.
      const result = await pay(alias, OTHER_PAYEE)
      expect(result.isError, alias).toBe(true)
      expect(result.content[0]!.text, alias).toContain('New x402 payments to merchant.example.com are locked')
    }
    expect(payments.count).toBe(1)
  })

  it('refuses the same payee behind any other host', async () => {
    const payments = { count: 0 }
    payingClient(brokenBody, payments)
    await pay('https://merchant.example.com/paid')
    expect(payments.count).toBe(1)

    // Same payee, spelled with its EIP-55 checksum casing.
    const elsewhere = await pay('https://unrelated.example.org/x', getAddress(PAYEE))
    expect(elsewhere.isError).toBe(true)
    expect(elsewhere.content[0]!.text).toContain(`New x402 payments to payee ${PAYEE} are locked`)
    expect(payments.count).toBe(1)

    // A different host AND a different payee is an unrelated service.
    payingClient(() => new Response('ok', { status: 200 }), payments)
    const unrelated = await pay('https://unrelated.example.org/x', OTHER_PAYEE)
    expect(unrelated.isError).toBeUndefined()
    expect(payments.count).toBe(2)
  })

  it.each([402, 500, 302])('x402_pay: a paid request answered %i locks host and payee', async (status) => {
    const payments = { count: 0 }
    payingClient(() => new Response('nope', { status, headers: status === 302 ? { location: '/x' } : {} }), payments)

    const first = await pay('https://merchant.example.com/paid')
    expect(first.isError).toBe(true)
    expect(first.content[0]!.text).toContain('failed after settlement')
    expect(first.content[0]!.text).toContain(MOCK_TX_HASH)

    const retries = await Promise.all([
      pay('https://merchant.example.com/paid', PAYEE, { idempotencyKey: 'fresh-key' }),
      pay('https://merchant.example.com/another-path'),
    ])
    for (const retry of retries) {
      expect(retry.isError).toBe(true)
      expect(retry.content[0]!.text).toContain('New x402 payments to merchant.example.com are locked')
    }
    expect(payments.count).toBe(1)
  })

  it.each([402, 500])('x402_session_start: a paid request answered %i creates no session and locks', async (status) => {
    const payments = { count: 0 }
    payingClient(() => new Response('nope', { status }), payments)

    const first = await start('https://merchant.example.com/v1')
    expect(first.isError).toBe(true)
    expect(first.content[0]!.text).toContain('failed after settlement')
    expect(listAllSessions()).toHaveLength(0)

    const retry = await start('https://merchant.example.com/v1')
    expect(retry.isError).toBe(true)
    expect(retry.content[0]!.text).toContain('New x402 payments to merchant.example.com are locked')
    expect(payments.count).toBe(1)
  })

  it('serialises session starts across host aliases (one payment)', async () => {
    const payments = { count: 0 }
    payingClient(() => new Response('ok', { status: 200 }), payments)
    mockCreate.mockClear()
    const settle = vi.fn()
    mockCreate.mockImplementation(((_wallet: unknown, cfg: Config) => ({
      settle402AndRetry: async () => {
        settle()
        payments.count++
        await new Promise((r) => setTimeout(r, 20))
        cfg.onPaymentComplete?.({
          timestamp: 1,
          amount: 1n,
          token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          recipient: PAYEE,
          txHash: MOCK_TX_HASH,
        })
        return brokenBody()
      },
    })) as never)
    const [a, b] = await Promise.all([
      start('https://merchant.example.com/v1'),
      start('https://merchant.example.com./v1'),
    ])
    expect(payments.count).toBe(1)
    const texts = [a.content[0]!.text, b.content[0]!.text]
    expect(texts.some((t) => t.includes('failed after settlement'))).toBe(true)
    expect(texts.some((t) => t.includes('New x402 payments to merchant.example.com are locked'))).toBe(true)
  })
})

describe('in-flight payments reserve their host and payee (Codex pass 4, P1)', () => {
  // The first payment settles, then its body dies a little later: until then
  // nothing is locked yet, so a concurrent payment must wait, not pay.
  const slowBrokenBody = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          setTimeout(() => controller.error(new Error('connection reset mid-body')), 40)
        },
      }),
      { status: 200 }
    )
  const later = <T,>(ms: number, f: () => Promise<T>) => new Promise<T>((r) => setTimeout(() => r(f()), ms))

  it.each([
    ['the same host on another path', 'https://merchant.example.com/other', PAYEE, 'merchant.example.com'],
    ['the same payee on another host', 'https://unrelated.example.org/x', PAYEE, `payee ${PAYEE}`],
  ])('a concurrent payment to %s waits and is then refused', async (_label, url, payTo, locked) => {
    const payments = { count: 0 }
    payingClient(slowBrokenBody, payments)
    const [first, second] = await Promise.all([
      pay('https://merchant.example.com/paid'),
      later(5, () => pay(url, payTo)),
    ])
    expect(first.content[0]!.text).toContain('failed after settlement')
    expect(second.isError).toBe(true)
    expect(second.content[0]!.text).toContain(`New x402 payments to ${locked} are locked`)
    expect(payments.count).toBe(1)
  })

  it('unrelated payments are not serialised behind each other', async () => {
    const payments = { count: 0 }
    payingClient(() => new Response('ok', { status: 200 }), payments)
    const [a, b] = await Promise.all([
      pay('https://merchant.example.com/a', PAYEE),
      pay('https://unrelated.example.org/b', OTHER_PAYEE),
    ])
    expect(a.isError).toBeUndefined()
    expect(b.isError).toBeUndefined()
    expect(payments.count).toBe(2)
  })
})

describe('durability of host and payee locks', () => {
  it('survives a restart, and a torn final record cannot drop it', async () => {
    process.env[STATE_DIR_ENV] = mkdtempSync(join(tmpdir(), 'agentpay-locks-'))
    _resetSpendIntentStore()
    const payments = { count: 0 }
    payingClient(brokenBody, payments)
    await start('https://merchant.example.com/v1')
    expect(payments.count).toBe(1)

    // Crash simulation: keep everything up to the intent's begin record and
    // tear the record after it mid-write (no trailing newline).
    const path = spendJournalPath()!
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    const beginIndex = lines.findIndex((l) => JSON.parse(l).op === 'begin')
    expect(beginIndex).toBeGreaterThanOrEqual(0)
    const torn = lines[beginIndex + 1]!.slice(0, 12)
    writeFileSync(path, lines.slice(0, beginIndex + 1).join('\n') + '\n' + torn)

    _resetSpendIntentStore() // restart: replay the journal
    const alias = await pay('https://merchant.example.com.:443/x', OTHER_PAYEE)
    expect(alias.isError).toBe(true)
    expect(alias.content[0]!.text).toContain('New x402 payments to merchant.example.com are locked')
    const samePayee = await pay('https://unrelated.example.org/x')
    expect(samePayee.content[0]!.text).toContain(`New x402 payments to payee ${PAYEE} are locked`)
    expect(payments.count).toBe(1)

    // The operator sees what the lock covers and clears it with ONE resolve.
    const out: string[] = []
    expect(runSpendIntentsCli(['list'], (l) => out.push(l), () => {})).toBe(0)
    expect(out.join('\n')).toContain('merchant.example.com')
    expect(out.join('\n')).toContain(PAYEE)
    const [locked] = listUnresolvedSpendIntents()
    expect(resolveSpendIntent(locked!.key, 'unsettled')).toMatchObject({ outcome: 'unsettled' })
    payingClient(() => new Response('ok', { status: 200 }), payments)
    expect((await pay('https://merchant.example.com/x')).isError).toBeUndefined()
    expect(payments.count).toBe(2)
  })
})
