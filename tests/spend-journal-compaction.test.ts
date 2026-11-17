/**
 * Codex review of PR #90 (pass 4, P2): the append-only spend journal must not
 * grow without bound. Compaction keeps exactly the live state — open locks
 * (with their x402 scope), in-flight begin records, durable tombstones — and
 * is crash-safe (temp file, fsync, rename).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DefiniteSpendFailure,
  STATE_DIR_ENV,
  SettledIntentTombstoneError,
  UnresolvedSpendIntentError,
  _resetSpendIntentStore,
  _setJournalCompactionThresholdForTests,
  listUnresolvedSpendIntents,
  spendJournalPath,
  withSpendIntent,
  x402LockScope,
} from '../src/utils/spend-intent.js'

const THRESHOLD = 8 * 1024
const SCOPE = x402LockScope({ host: 'merchant.example.com', payee: '0xfeedfacefeedfacefeedfacefeedfacefeedface' })

beforeEach(() => {
  process.env[STATE_DIR_ENV] = mkdtempSync(join(tmpdir(), 'agentpay-compact-'))
  _resetSpendIntentStore()
  _setJournalCompactionThresholdForTests(THRESHOLD)
})
afterEach(() => {
  _setJournalCompactionThresholdForTests(undefined)
  delete process.env[STATE_DIR_ENV]
  _resetSpendIntentStore()
})

async function churn(n: number) {
  for (let i = 0; i < n; i++) {
    await withSpendIntent(`churn#${i}`, async () => {
      throw new DefiniteSpendFailure('policy denied')
    }).catch(() => undefined)
  }
}

describe('spend journal compaction', () => {
  it('keeps the journal bounded under a stream of definite failures', async () => {
    await churn(2000)
    const size = statSync(spendJournalPath()!).size
    expect(size).toBeLessThan(3 * THRESHOLD)
    expect(existsSync(spendJournalPath()! + '.tmp')).toBe(false)
  })

  it('preserves locks (with scope), tombstones and in-flight begins across compaction and restart', async () => {
    // A keyed settlement (becomes a tombstone after restart).
    await withSpendIntent('send_payment#invoice-1', async () => '0xsettled', { durable: true, fingerprint: 'fp-1' })
    // An ambiguous x402 payment: locked, and its host/payee blocked.
    await expect(
      withSpendIntent('x402_pay:abc', async () => {
        throw new Error('connection reset after broadcast')
      }, { lockScope: SCOPE })
    ).rejects.toThrow()
    // A payment still in flight while compaction runs.
    let finish!: () => void
    const pending = withSpendIntent('send_token:inflight', () => new Promise<string>((r) => { finish = () => r('0xlate') }))

    await churn(2000) // forces several compactions
    const lines = readFileSync(spendJournalPath()!, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBeLessThan(400)

    _resetSpendIntentStore() // crash + restart: replay the compacted journal
    _setJournalCompactionThresholdForTests(THRESHOLD)
    const locked = listUnresolvedSpendIntents()
    expect(locked.map((e) => e.key)).toEqual(expect.arrayContaining(['x402_pay:abc', 'send_token:inflight']))
    expect(locked.find((e) => e.key === 'x402_pay:abc')!.blocks).toEqual(['merchant.example.com', 'payee 0xfeedfacefeedfacefeedfacefeedfacefeedface'])
    await expect(
      withSpendIntent('send_payment#invoice-1', async () => '0xagain', { durable: true, fingerprint: 'fp-1' })
    ).rejects.toBeInstanceOf(SettledIntentTombstoneError)
    await expect(
      withSpendIntent('x402_pay:other-path', async () => '0xpaid', { lockScope: SCOPE })
    ).rejects.toBeInstanceOf(UnresolvedSpendIntentError)
    finish()
    await pending.catch(() => undefined)
  })
})
