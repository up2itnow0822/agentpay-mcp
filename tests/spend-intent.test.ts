/**
 * Tests for the in-process send_token spend-intent cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SEND_TOKEN_INTENT_TTL_MS,
  _resetSpendIntentStore,
  sendTokenIntentKey,
  withSpendIntent,
} from '../src/utils/spend-intent.js'

describe('sendTokenIntentKey', () => {
  it('normalises address case so checksum retries collide', () => {
    const lower = sendTokenIntentKey({
      chainId: 8453,
      tokenAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      recipientAddress: '0xrecipient00000000000000000000000000000001',
      rawAmount: 10_000_000n,
    })
    const mixed = sendTokenIntentKey({
      chainId: 8453,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipientAddress: '0xRecipient00000000000000000000000000000001',
      rawAmount: 10_000_000n,
    })
    expect(lower).toBe(mixed)
  })

  it('changes when recipient, amount, or chain changes', () => {
    const base = {
      chainId: 8453,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipientAddress: '0xrecipient00000000000000000000000000000001',
      rawAmount: 10_000_000n,
    }
    expect(sendTokenIntentKey({ ...base, chainId: 84532 })).not.toBe(sendTokenIntentKey(base))
    expect(sendTokenIntentKey({ ...base, rawAmount: 10_000_001n })).not.toBe(sendTokenIntentKey(base))
    expect(
      sendTokenIntentKey({
        ...base,
        recipientAddress: '0xrecipient00000000000000000000000000000002',
      })
    ).not.toBe(sendTokenIntentKey(base))
  })
})

describe('withSpendIntent', () => {
  beforeEach(() => {
    _resetSpendIntentStore()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T22:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetSpendIntentStore()
  })

  it('runs once and replays the settled value', async () => {
    const run = vi.fn().mockResolvedValue('0xtxhash')
    const first = await withSpendIntent('k1', run)
    const second = await withSpendIntent('k1', run)
    expect(first).toEqual({ value: '0xtxhash', replayed: false })
    expect(second).toEqual({ value: '0xtxhash', replayed: true })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed attempt', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('rpc timeout'))
      .mockResolvedValueOnce('0xtxhash')
    await expect(withSpendIntent('k1', run)).rejects.toThrow('rpc timeout')
    const retry = await withSpendIntent('k1', run)
    expect(retry).toEqual({ value: '0xtxhash', replayed: false })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('shares an in-flight attempt instead of broadcasting twice', async () => {
    let resolveRun!: (_value: string) => void
    const run = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRun = resolve
        })
    )
    const first = withSpendIntent('k1', run)
    const second = withSpendIntent('k1', run)
    resolveRun('0xtxhash')
    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: '0xtxhash', replayed: false },
      { value: '0xtxhash', replayed: true },
    ])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('allows a new send after the TTL expires', async () => {
    const run = vi.fn().mockResolvedValueOnce('0xfirst').mockResolvedValueOnce('0xsecond')
    await withSpendIntent('k1', run)
    vi.advanceTimersByTime(SEND_TOKEN_INTENT_TTL_MS + 1)
    const retry = await withSpendIntent('k1', run)
    expect(retry).toEqual({ value: '0xsecond', replayed: false })
    expect(run).toHaveBeenCalledTimes(2)
  })
})
