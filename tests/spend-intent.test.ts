/**
 * Tests for the in-process send_token spend-intent cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  DefiniteSpendFailure,
  IDEMPOTENCY_KEY_JSON_SCHEMA,
  IdempotencyKeyZodSchema,
  SEND_TOKEN_INTENT_TTL_MS,
  SPEND_INTENT_MAX_DURABLE,
  SPEND_INTENT_MAX_UNRESOLVED,
  SpendIntentCapacityError,
  SpendIntentConflictError,
  SettledIntentTombstoneError,
  UnresolvedSpendIntentError,
  STATE_DIR_ENV,
  ensureJournalLoaded,
  forgetSettledIntent,
  listUnresolvedSpendIntents,
  originalWalletMethod,
  resolveSpendIntent,
  withKeyedLock,
  _resetSpendIntentStore,
  _spendIntentStoreSizes,
  _setDurableIdentityCeilingForTests,
  isConfirmedUnchargedRevert,
  requireSettlementHash,
  runClassifiedSpend,
  runDefinitePreBroadcast,
  sendTokenIntentIdentity,
  sendTokenIntentKey,
  swapTokensIntentKey,
  bridgeUsdcIntentKey,
  x402PayIntentIdentity,
  x402PayIntentKey,
  withSpendIntent,
} from '../src/utils/spend-intent.js'
import { SwapTokensSchema, swapTokensTool } from '../src/tools/swap.js'
import { BridgeUsdcSchema, bridgeUsdcTool } from '../src/tools/bridge.js'
import { SendTokenSchema, sendTokenTool } from '../src/tools/transfers.js'
import { X402PaySchema, x402PayTool } from '../src/tools/x402.js'
import { SendPaymentSchema, sendPaymentTool } from '../src/tools/payments.js'

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

  it('distinguishes equal payloads when idempotency keys differ', () => {
    const base = {
      chainId: 8453,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipientAddress: '0xrecipient00000000000000000000000000000001',
      rawAmount: 10_000_000n,
    }
    expect(sendTokenIntentKey({ ...base, idempotencyKey: 'invoice-1' })).not.toBe(
      sendTokenIntentKey({ ...base, idempotencyKey: 'invoice-2' })
    )
    expect(sendTokenIntentKey({ ...base, idempotencyKey: 'invoice-1' })).not.toBe(
      sendTokenIntentKey(base)
    )
  })

  it('uses the explicit key as lookup identity independent of payload', () => {
    const base = {
      chainId: 8453,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      recipientAddress: '0xrecipient00000000000000000000000000000001',
      rawAmount: 10_000_000n,
      idempotencyKey: 'invoice-1',
    }
    expect(sendTokenIntentKey({ ...base, rawAmount: 20_000_000n })).toBe(
      sendTokenIntentKey(base)
    )
    expect(sendTokenIntentIdentity({ ...base, rawAmount: 20_000_000n }).fingerprint).not.toBe(
      sendTokenIntentIdentity(base).fingerprint
    )
  })
})

describe('swapTokensIntentKey', () => {
  const base = {
    chainId: 8453,
    fromTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    toTokenAddress: '0x4200000000000000000000000000000000000006',
    rawAmountIn: 100_000_000n,
  }

  it('normalises token address case so checksum retries collide', () => {
    expect(
      swapTokensIntentKey({
        ...base,
        fromTokenAddress: base.fromTokenAddress.toLowerCase(),
        toTokenAddress: base.toTokenAddress.toLowerCase(),
      })
    ).toBe(swapTokensIntentKey(base))
  })

  it('changes when pair, amount, chain, or slippage changes', () => {
    expect(swapTokensIntentKey({ ...base, chainId: 10 })).not.toBe(swapTokensIntentKey(base))
    expect(swapTokensIntentKey({ ...base, rawAmountIn: 50_000_000n })).not.toBe(
      swapTokensIntentKey(base)
    )
    expect(
      swapTokensIntentKey({
        ...base,
        toTokenAddress: '0x0000000000000000000000000000000000000001',
      })
    ).not.toBe(swapTokensIntentKey(base))
    expect(swapTokensIntentKey({ ...base, slippageBps: 100 })).not.toBe(
      swapTokensIntentKey(base)
    )
  })

  it('collides omitted slippage with the documented 50 bps default', () => {
    expect(swapTokensIntentKey(base)).toBe(
      swapTokensIntentKey({ ...base, slippageBps: 50 })
    )
  })
})

describe('x402PayIntentKey', () => {
  const base = {
    url: 'https://api.example.com/premium',
    method: 'GET',
  }

  it('changes when url, method, or body changes', () => {
    expect(x402PayIntentKey({ ...base, url: 'https://api.example.com/other' })).not.toBe(
      x402PayIntentKey(base)
    )
    expect(x402PayIntentKey({ ...base, method: 'POST' })).not.toBe(x402PayIntentKey(base))
    expect(x402PayIntentKey({ ...base, body: '{"n":1}' })).not.toBe(x402PayIntentKey(base))
  })

  it('uses the explicit key as lookup identity independent of payload', () => {
    expect(
      x402PayIntentKey({ ...base, url: 'https://api.example.com/other', idempotencyKey: 'invoice-1' })
    ).toBe(x402PayIntentKey({ ...base, idempotencyKey: 'invoice-1' }))
  })

  it('does not collide when colon-joined url and body fields swap', () => {
    const left = x402PayIntentIdentity({
      url: 'https://example.com/a',
      method: 'GET',
      body: 'b:c',
    })
    const right = x402PayIntentIdentity({
      url: 'https://example.com/a:b',
      method: 'GET',
      body: 'c',
    })
    expect(left.fingerprint).not.toBe(right.fingerprint)
    expect(left.key).not.toBe(right.key)
  })

  it('includes headers in the fingerprint and normalises name case and order', () => {
    expect(
      x402PayIntentIdentity({
        ...base,
        headers: { Authorization: 'Bearer alice', 'X-Api-Key': 'one' },
      }).fingerprint
    ).not.toBe(x402PayIntentIdentity(base).fingerprint)
    expect(
      x402PayIntentIdentity({
        ...base,
        headers: { Authorization: 'Bearer alice' },
      }).fingerprint
    ).not.toBe(
      x402PayIntentIdentity({
        ...base,
        headers: { Authorization: 'Bearer bob' },
      }).fingerprint
    )
    expect(
      x402PayIntentIdentity({
        ...base,
        headers: { Authorization: 'Bearer alice', 'X-Api-Key': 'one' },
      }).fingerprint
    ).toBe(
      x402PayIntentIdentity({
        ...base,
        headers: { 'x-api-key': 'one', authorization: 'Bearer alice' },
      }).fingerprint
    )
  })

  it('treats a keyed header change as a payload conflict, not a replay', () => {
    const first = x402PayIntentIdentity({
      ...base,
      headers: { Authorization: 'Bearer alice' },
      idempotencyKey: 'invoice-1',
    })
    const changed = x402PayIntentIdentity({
      ...base,
      headers: { Authorization: 'Bearer bob' },
      idempotencyKey: 'invoice-1',
    })
    expect(first.key).toBe(changed.key)
    expect(first.fingerprint).not.toBe(changed.fingerprint)
  })
})

describe('bridgeUsdcIntentKey', () => {
  const base = {
    fromChain: 'base',
    toChain: 'polygon',
    rawAmount: 100_000_000n,
  }

  it('normalises chain names so case retries collide', () => {
    expect(
      bridgeUsdcIntentKey({ ...base, fromChain: 'BASE', toChain: 'POLYGON' })
    ).toBe(bridgeUsdcIntentKey(base))
  })

  it('changes when route or amount changes', () => {
    expect(bridgeUsdcIntentKey({ ...base, toChain: 'arbitrum' })).not.toBe(
      bridgeUsdcIntentKey(base)
    )
    expect(bridgeUsdcIntentKey({ ...base, rawAmount: 50_000_000n })).not.toBe(
      bridgeUsdcIntentKey(base)
    )
  })
})

const VALID_TX_HASH = `0x${'ab'.repeat(32)}`

describe('requireSettlementHash', () => {
  it('returns a 32-byte 0x-prefixed hash, trimming surrounding whitespace', () => {
    expect(requireSettlementHash(VALID_TX_HASH, 'swap_tokens')).toBe(VALID_TX_HASH)
    expect(requireSettlementHash(`  ${VALID_TX_HASH}  `, 'swap_tokens')).toBe(VALID_TX_HASH)
  })

  it('rejects missing, empty, or whitespace-only hashes', () => {
    for (const bad of [undefined, null, '', '   ', 0, {}]) {
      expect(() => requireSettlementHash(bad, 'swap_tokens')).toThrow(
        'swap_tokens returned without a transaction hash'
      )
    }
  })

  it('rejects malformed hashes instead of treating them as settled', () => {
    const tooShort = `0x${'ab'.repeat(31)}`
    const tooLong = `0x${'ab'.repeat(33)}`
    const uppercasePrefix = `0X${'ab'.repeat(32)}`
    for (const bad of ['pending', '0x123', tooShort, tooLong, uppercasePrefix, '0xzzzz']) {
      expect(() => requireSettlementHash(bad, 'swap_tokens')).toThrow(
        'swap_tokens returned a malformed transaction hash'
      )
    }
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

  it('releases an uncharged success instead of settling it', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ text: 'free-1', charged: false })
      .mockResolvedValueOnce({ text: 'free-2', charged: false })
    const first = await withSpendIntent('k1', run, {
      shouldSettle: (value) => value.charged,
    })
    const second = await withSpendIntent('k1', run, {
      shouldSettle: (value) => value.charged,
    })
    expect(first).toEqual({ value: { text: 'free-1', charged: false }, replayed: false })
    expect(second).toEqual({ value: { text: 'free-2', charged: false }, replayed: false })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('fail-closes after an unresolved broadcast instead of sending again', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('rpc timeout'))
      .mockResolvedValueOnce('0xtxhash')
    await expect(withSpendIntent('k1', run)).rejects.toThrow('rpc timeout')
    await expect(withSpendIntent('k1', run)).rejects.toBeInstanceOf(UnresolvedSpendIntentError)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('retries a definite pre-broadcast failure', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new DefiniteSpendFailure('spend policy rejected'))
      .mockResolvedValueOnce('0xtxhash')
    await expect(withSpendIntent('k1', run)).rejects.toThrow('spend policy rejected')
    const retry = await withSpendIntent('k1', run)
    expect(retry).toEqual({ value: '0xtxhash', replayed: false })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('retries SDK quote and allowance failures wrapped as definite', async () => {
    const run = vi
      .fn()
      .mockImplementationOnce(async () => {
        await runDefinitePreBroadcast(async () => {
          throw new Error('quote rpc timeout')
        })
        return '0xtxhash'
      })
      .mockImplementationOnce(async () => {
        await runDefinitePreBroadcast(async () => 0n)
        return '0xtxhash'
      })
    await expect(withSpendIntent('k1', run)).rejects.toBeInstanceOf(DefiniteSpendFailure)
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

  it('keeps an unresolved intent locked after the settled-result TTL', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('rpc timeout'))
      .mockResolvedValueOnce('0xsecond')
    await expect(withSpendIntent('k1', run)).rejects.toThrow('rpc timeout')
    vi.advanceTimersByTime(SEND_TOKEN_INTENT_TTL_MS + 1)
    await expect(withSpendIntent('k1', run)).rejects.toBeInstanceOf(
      UnresolvedSpendIntentError
    )
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('allows a new keyless send after the TTL expires', async () => {
    const run = vi.fn().mockResolvedValueOnce('0xfirst').mockResolvedValueOnce('0xsecond')
    await withSpendIntent('k1', run)
    vi.advanceTimersByTime(SEND_TOKEN_INTENT_TTL_MS + 1)
    const retry = await withSpendIntent('k1', run)
    expect(retry).toEqual({ value: '0xsecond', replayed: false })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('replays a durable keyed result after the keyless TTL', async () => {
    const run = vi.fn().mockResolvedValue('0xkeyed')
    await withSpendIntent('k1#invoice-1', run, { durable: true })
    vi.advanceTimersByTime(SEND_TOKEN_INTENT_TTL_MS + 1)
    const retry = await withSpendIntent('k1#invoice-1', run, { durable: true })
    expect(retry).toEqual({ value: '0xkeyed', replayed: true })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('fail-closes when a keyed retry changes the payload fingerprint', async () => {
    const run = vi.fn().mockResolvedValue('0xfirst')
    await withSpendIntent('send_token#invoice-1', run, {
      durable: true,
      fingerprint: 'send_token:8453:usdc:alice:10000000',
    })
    await expect(
      withSpendIntent('send_token#invoice-1', run, {
        durable: true,
        fingerprint: 'send_token:8453:usdc:alice:20000000',
      })
    ).rejects.toBeInstanceOf(SpendIntentConflictError)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not broadcast a corrected payload after an unresolved keyed attempt', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('rpc timeout'))
      .mockResolvedValueOnce('0xsecond')
    await expect(
      withSpendIntent('send_token#invoice-1', run, {
        durable: true,
        fingerprint: 'send_token:8453:usdc:alice:10000000',
      })
    ).rejects.toThrow('rpc timeout')
    await expect(
      withSpendIntent('send_token#invoice-1', run, {
        durable: true,
        fingerprint: 'send_token:8453:usdc:alice:20000000',
      })
    ).rejects.toBeInstanceOf(SpendIntentConflictError)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('never evicts a durable tombstone, however many keyed spends settle after it (Codex pass 4, P1)', async () => {
    await withSpendIntent('durable#first', async () => '0xfirst', { durable: true, fingerprint: 'fp-first' })
    for (let i = 0; i < SPEND_INTENT_MAX_DURABLE + 16_384 + 16; i++) {
      await withSpendIntent(`durable#later-${i}`, async () => `0x${i}`, { durable: true })
    }
    const retry = vi.fn().mockResolvedValue('0xagain')
    await expect(
      withSpendIntent('durable#first', retry, { durable: true, fingerprint: 'fp-first' })
    ).rejects.toBeInstanceOf(SettledIntentTombstoneError)
    // A different payload under the old key is still a conflict, not a new spend.
    await expect(
      withSpendIntent('durable#first', retry, { durable: true, fingerprint: 'fp-other' })
    ).rejects.toBeInstanceOf(SpendIntentConflictError)
    expect(retry).not.toHaveBeenCalled()
  })

  it('fails closed at the durable-identity ceiling instead of evicting (Codex pass 4, P1)', async () => {
    _setDurableIdentityCeilingForTests(8)
    try {
      for (let i = 0; i < 8; i++) {
        await withSpendIntent(`keyed#${i}`, async () => `0x${i}`, { durable: true })
      }
      const run = vi.fn().mockResolvedValue('0xnew')
      await expect(withSpendIntent('keyed#8', run, { durable: true })).rejects.toThrow(/idempotency keys/)
      expect(run).not.toHaveBeenCalled()
      // Existing keys still replay; keyless spends are unaffected.
      await expect(withSpendIntent('keyed#0', run, { durable: true })).resolves.toMatchObject({ replayed: true })
      await expect(withSpendIntent('keyless#1', async () => '0xok')).resolves.toMatchObject({ replayed: false })
    } finally {
      _setDurableIdentityCeilingForTests(undefined)
    }
  })

  it('tombstones an evicted durable key so reuse is refused, never re-executed', async () => {
    const run = vi.fn().mockResolvedValue('0xnew')
    for (let i = 0; i < SPEND_INTENT_MAX_DURABLE; i++) {
      await withSpendIntent(`durable#${i}`, async () => `0x${i}`, { durable: true })
    }
    expect(_spendIntentStoreSizes().durable).toBe(SPEND_INTENT_MAX_DURABLE)

    await withSpendIntent('durable#overflow', run, { durable: true })
    expect(_spendIntentStoreSizes().durable).toBe(SPEND_INTENT_MAX_DURABLE)
    expect(_spendIntentStoreSizes().tombstones).toBe(1)

    const evicted = vi.fn().mockResolvedValue('0xevicted-retry')
    await expect(
      withSpendIntent('durable#0', evicted, { durable: true })
    ).rejects.toBeInstanceOf(SettledIntentTombstoneError)
    expect(evicted).not.toHaveBeenCalled()
  })

  it('never evicts unresolved locks; admission fails closed at capacity (F14)', async () => {
    for (let i = 0; i < SPEND_INTENT_MAX_UNRESOLVED; i++) {
      await expect(
        withSpendIntent(`unknown#${i}`, async () => {
          throw new Error('rpc timeout')
        })
      ).rejects.toThrow('rpc timeout')
    }
    expect(_spendIntentStoreSizes().unresolved).toBe(SPEND_INTENT_MAX_UNRESOLVED)

    // At capacity a NEW intent is refused before its callback runs.
    const fresh = vi.fn().mockResolvedValue('0xfresh')
    await expect(withSpendIntent('unknown#overflow', fresh)).rejects.toBeInstanceOf(
      SpendIntentCapacityError
    )
    expect(fresh).not.toHaveBeenCalled()
    expect(_spendIntentStoreSizes().unresolved).toBe(SPEND_INTENT_MAX_UNRESOLVED)

    // The oldest lock is still in force: its retry never reaches the wallet.
    const retriedOldest = vi.fn().mockResolvedValue('0xafter-evict')
    await expect(withSpendIntent('unknown#0', retriedOldest)).rejects.toBeInstanceOf(
      UnresolvedSpendIntentError
    )
    expect(retriedOldest).not.toHaveBeenCalled()

    // Operator reconciliation frees exactly one slot.
    expect(resolveSpendIntent('unknown#0', 'unsettled')).toMatchObject({ outcome: 'unsettled', keyRetired: false })
    await expect(withSpendIntent('unknown#overflow', fresh)).resolves.toEqual({
      value: '0xfresh',
      replayed: false,
    })
  })

  it('counts in-flight intents at admission so locks never exceed the ceiling (Codex P2)', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const inFlight = Array.from({ length: SPEND_INTENT_MAX_UNRESOLVED }, (_, i) =>
      withSpendIntent(`flight#${i}`, async () => {
        await gate
        throw new Error('rpc timeout')
      }).catch((e: unknown) => e)
    )
    // Capacity is fully reserved by in-flight spends: a new one is refused.
    const extra = vi.fn()
    await expect(withSpendIntent('one-too-many', extra)).rejects.toBeInstanceOf(
      SpendIntentCapacityError
    )
    expect(extra).not.toHaveBeenCalled()
    release()
    await Promise.all(inFlight)
    expect(_spendIntentStoreSizes().unresolved).toBe(SPEND_INTENT_MAX_UNRESOLVED)
  })
})

describe('runClassifiedSpend', () => {
  it('classifies a failure before wallet write as definite', async () => {
    const walletClient = {
      sendTransaction: vi.fn().mockResolvedValue('0xsend'),
    }
    await expect(
      runClassifiedSpend(walletClient, async () => {
        throw new Error('quote rpc timeout')
      })
    ).rejects.toBeInstanceOf(DefiniteSpendFailure)
    expect(originalWalletMethod(walletClient.sendTransaction)).not.toHaveBeenCalled()
  })

  it('keeps an ambiguous post-broadcast error unknown', async () => {
    const walletClient = {
      sendTransaction: vi.fn().mockResolvedValue('0xsend'),
    }
    await expect(
      runClassifiedSpend(walletClient, async () => {
        await walletClient.sendTransaction({ to: '0x1' })
        throw new Error('rpc timeout')
      })
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(DefiniteSpendFailure)
      expect((error as Error).message).toBe('rpc timeout')
      return true
    })
  })

  // agentwallet-sdk 7 needs structured revert evidence; a bare message is held.
  it('holds a message-only revert as unknown (not retry-safe)', async () => {
    const walletClient = {
      sendTransaction: vi.fn().mockResolvedValue('0xsend'),
    }
    await expect(
      runClassifiedSpend(walletClient, async () => {
        await walletClient.sendTransaction({ to: '0x1' })
        throw new Error('depositForBurn transaction reverted (tx: 0xabc).')
      })
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).not.toBeInstanceOf(DefiniteSpendFailure)
      return true
    })
  })

  it('locks x402-style reverts after the first wallet write', async () => {
    const walletClient = {
      sendTransaction: vi.fn().mockResolvedValue('0xsend'),
    }
    await expect(
      runClassifiedSpend(
        walletClient,
        async () => {
          await walletClient.sendTransaction({ to: '0xfee' })
          throw new Error('execution reverted')
        },
        { lockAfterBroadcast: true }
      )
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(DefiniteSpendFailure)
      expect((error as Error).message).toBe('execution reverted')
      return true
    })
  })
})

describe('isConfirmedUnchargedRevert', () => {
  it('treats approve/burn reverts as uncharged and mint/attestation as charged', () => {
    expect(isConfirmedUnchargedRevert(new Error('execution reverted'))).toBe(true)
    expect(
      isConfirmedUnchargedRevert(new Error('USDC approve failed (tx: 0xabc).'))
    ).toBe(true)
    expect(
      isConfirmedUnchargedRevert(new Error('Circle attestation timeout'))
    ).toBe(false)
    expect(
      isConfirmedUnchargedRevert(new Error('[BridgeModule:MINT_FAILED] receiveMessage reverted'))
    ).toBe(false)
  })
})

describe('idempotencyKey discovery schema', () => {
  const published = [
    swapTokensTool.inputSchema.properties.idempotencyKey,
    bridgeUsdcTool.inputSchema.properties.idempotencyKey,
    sendTokenTool.inputSchema.properties.idempotencyKey,
    x402PayTool.inputSchema.properties.idempotencyKey,
    sendPaymentTool.inputSchema.properties.idempotencyKey,
  ]
  const discoveryPattern = new RegExp(IDEMPOTENCY_KEY_JSON_SCHEMA.pattern)
  const swapBase = {
    fromSymbol: 'USDC',
    toSymbol: 'WETH',
    amount: '1',
    chainId: 8453,
  }
  const bridgeBase = { fromChain: 'base' as const, toChain: 'optimism' as const, amount: '1' }
  const sendBase = {
    tokenSymbol: 'USDC',
    chainId: 8453,
    recipientAddress: '0xrecipient00000000000000000000000000000001',
    amount: '1',
  }
  const x402Base = {
    url: 'https://api.example.com/premium',
    max_payment_eth: '0.01',
    pay_to: '0xfeedfacefeedfacefeedfacefeedfacefeedface',
  }

  it('publishes the non-whitespace pattern on swap, bridge, send, and x402_pay', () => {
    for (const schema of published) {
      expect(schema).toMatchObject(IDEMPOTENCY_KEY_JSON_SCHEMA)
    }
    expect(discoveryPattern.test('   ')).toBe(false)
    expect(discoveryPattern.test('\t\n')).toBe(false)
    expect(discoveryPattern.test('invoice-1')).toBe(true)
    expect(discoveryPattern.test(' invoice-1 ')).toBe(true)
  })

  it('rejects whitespace-only keys at runtime to match discovery', () => {
    expect(SwapTokensSchema.safeParse({ ...swapBase, idempotencyKey: '   ' }).success).toBe(false)
    expect(BridgeUsdcSchema.safeParse({ ...bridgeBase, idempotencyKey: '   ' }).success).toBe(false)
    expect(SendTokenSchema.safeParse({ ...sendBase, idempotencyKey: '   ' }).success).toBe(false)
    expect(X402PaySchema.safeParse({ ...x402Base, idempotencyKey: '   ' }).success).toBe(false)
    expect(
      SendPaymentSchema.safeParse({ to: '0x' + '1'.repeat(40), amount_eth: '1', idempotencyKey: '   ' })
        .success
    ).toBe(false)
    expect(SwapTokensSchema.safeParse({ ...swapBase, idempotencyKey: 'invoice-1' }).success).toBe(
      true
    )
    expect(X402PaySchema.safeParse({ ...x402Base, idempotencyKey: 'invoice-1' }).success).toBe(true)
  })

  it('applies maxLength to the raw string, not the trimmed value', () => {
    const raw129 = ` ${'x'.repeat(128)}`
    expect(raw129.length).toBe(129)
    expect(raw129.trim().length).toBe(128)
    expect(SwapTokensSchema.safeParse({ ...swapBase, idempotencyKey: raw129 }).success).toBe(false)
    expect(BridgeUsdcSchema.safeParse({ ...bridgeBase, idempotencyKey: raw129 }).success).toBe(
      false
    )
    expect(SendTokenSchema.safeParse({ ...sendBase, idempotencyKey: raw129 }).success).toBe(false)
    expect(X402PaySchema.safeParse({ ...x402Base, idempotencyKey: raw129 }).success).toBe(false)
    expect(IdempotencyKeyZodSchema.safeParse(raw129).success).toBe(false)
    expect(raw129.length > IDEMPOTENCY_KEY_JSON_SCHEMA.maxLength).toBe(true)
    expect(SwapTokensSchema.safeParse({ ...swapBase, idempotencyKey: 'x'.repeat(128) }).success).toBe(
      true
    )
  })
})

describe('runClassifiedSpend concurrency (F12)', () => {
  it('keeps broadcast detection request-scoped across interleaved spends', async () => {
    const walletClient = {
      sendTransaction: vi.fn().mockResolvedValue('0xsend'),
      writeContract: vi.fn().mockResolvedValue('0xwrite'),
    }
    const step = () => new Promise((resolve) => setTimeout(resolve, 5))

    // A writes, then fails late. B starts after A and finishes (successfully)
    // BEFORE A fails — the old swap/restore implementation restored A's
    // captured originals at that point and lost A's broadcast flag.
    const a = runClassifiedSpend(walletClient, async () => {
      await step()
      await walletClient.sendTransaction({ to: '0xa' })
      await step()
      await step()
      await step()
      throw new Error('receipt polling failed')
    })
    const b = runClassifiedSpend(walletClient, async () => {
      await step()
      return 'b-ok'
    })
    // C never writes and fails: must stay definite despite A's write.
    const c = runClassifiedSpend(walletClient, async () => {
      await step()
      await step()
      throw new Error('quote failed')
    })

    const aSettled = a.catch((e: unknown) => e)
    const cSettled = c.catch((e: unknown) => e)
    await expect(b).resolves.toBe('b-ok')
    const aErr = await aSettled
    expect(aErr).toBeInstanceOf(Error)
    expect(aErr).not.toBeInstanceOf(DefiniteSpendFailure)
    expect(await cSettled).toBeInstanceOf(DefiniteSpendFailure)

    // The hook is installed once and never torn down mid-flight.
    expect(originalWalletMethod(walletClient.sendTransaction)).toHaveBeenCalledTimes(1)
    await walletClient.sendTransaction({ to: '0xoutside' })
    expect(originalWalletMethod(walletClient.sendTransaction)).toHaveBeenCalledTimes(2)
  })

  it('a spend that started later and wrote after an earlier one finished stays locked', async () => {
    // Reproduces the original race exactly: B installs, A installs over it,
    // B finishes and "restores" — the old code stripped A's detector here and
    // A's real broadcast was then released as definitely uncharged.
    const walletClient = { sendTransaction: vi.fn().mockResolvedValue('0xsend') }
    let finishA!: () => void
    let finishB!: () => void
    const gateA = new Promise<void>((r) => (finishA = r))
    const gateB = new Promise<void>((r) => (finishB = r))
    const b = runClassifiedSpend(walletClient, async () => {
      await gateB
      return 'b'
    })
    const a = runClassifiedSpend(walletClient, async () => {
      await gateA
      await walletClient.sendTransaction({})
      throw new Error('receipt lost')
    })
    const aSettled = a.catch((e: unknown) => e)
    finishB()
    await b
    finishA()
    const err = await aSettled
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(DefiniteSpendFailure)
  })

  it('every restore ordering keeps both flags accurate', async () => {
    for (const aFirst of [true, false]) {
      const walletClient = { writeContract: vi.fn().mockResolvedValue('0xw') }
      let finishA!: () => void
      let finishB!: () => void
      const gateA = new Promise<void>((r) => (finishA = r))
      const gateB = new Promise<void>((r) => (finishB = r))
      const a = runClassifiedSpend(walletClient, async () => {
        await walletClient.writeContract({})
        await gateA
        throw new Error('ambiguous A')
      })
      const b = runClassifiedSpend(walletClient, async () => {
        await gateB
        throw new Error('pre-write B')
      })
      const aSettled = a.catch((e: unknown) => e)
      const bSettled = b.catch((e: unknown) => e)
      if (aFirst) {
        finishA()
        await aSettled
        finishB()
      } else {
        finishB()
        await bSettled
        finishA()
      }
      expect(await aSettled).not.toBeInstanceOf(DefiniteSpendFailure)
      expect(await bSettled).toBeInstanceOf(DefiniteSpendFailure)
    }
  })
})

describe('spend-intent journal (opt-in durability)', () => {
  let dir: string
  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    dir = mkdtempSync(join(tmpdir(), 'agentpay-journal-'))
    process.env[STATE_DIR_ENV] = dir
    _resetSpendIntentStore()
  })
  afterEach(() => {
    delete process.env[STATE_DIR_ENV]
    _resetSpendIntentStore()
  })

  it('restores an ambiguous lock after a restart', async () => {
    await expect(
      withSpendIntent('send_token:8453:a:b:1', async () => {
        throw new Error('rpc timeout')
      })
    ).rejects.toThrow('rpc timeout')

    _resetSpendIntentStore() // simulate restart: memory gone, journal kept
    ensureJournalLoaded()
    expect(listUnresolvedSpendIntents().map((e) => e.key)).toContain('send_token:8453:a:b:1')
    const retry = vi.fn()
    await expect(withSpendIntent('send_token:8453:a:b:1', retry)).rejects.toBeInstanceOf(
      UnresolvedSpendIntentError
    )
    expect(retry).not.toHaveBeenCalled()
  })

  it('treats a begin without a terminal record (crash mid-spend) as locked', async () => {
    const { appendFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    appendFileSync(
      join(dir, 'spend-intents.jsonl'),
      JSON.stringify({ v: 1, at: 1, op: 'begin', key: 'k#crash', fp: 'fp' }) + '\n' +
        '{"v":1,"op":"settle","key":"k#crash"' // torn line from the crash
    )
    const retry = vi.fn()
    await expect(withSpendIntent('k#crash', retry, { fingerprint: 'fp' })).rejects.toBeInstanceOf(
      UnresolvedSpendIntentError
    )
    expect(retry).not.toHaveBeenCalled()
  })

  it('an unreadable journal refuses every spend until it can be replayed (Codex P1)', async () => {
    const { mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    // A directory where the journal file should be: reading it fails.
    mkdirSync(join(dir, 'spend-intents.jsonl'))
    const run = vi.fn()
    await expect(withSpendIntent('blocked#1', run)).rejects.toThrow(/could not be read/)
    await expect(withSpendIntent('blocked#2', run)).rejects.toThrow(/could not be read/)
    expect(run).not.toHaveBeenCalled()
  })

  it('a record written after a torn tail is not welded into it (review follow-up)', async () => {
    const { appendFileSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const file = join(dir, 'spend-intents.jsonl')
    appendFileSync(file, '{"v":1,"op":"settle","key":"old","fp":"x","dur') // crash mid-write
    await expect(
      withSpendIntent('after#torn', async () => {
        throw new Error('rpc timeout')
      })
    ).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).toMatch(/"dur\n\{"v":1/)
    _resetSpendIntentStore()
    ensureJournalLoaded()
    expect(listUnresolvedSpendIntents().map((e) => e.key)).toContain('after#torn')
  })

  it('keyed settlements survive a restart as tombstones; definite failures do not lock', async () => {
    await withSpendIntent('send_token#key-1', async () => '0xsettled', {
      durable: true,
      fingerprint: 'fp1',
    })
    await expect(
      withSpendIntent('send_token#key-2', async () => {
        throw new DefiniteSpendFailure('policy said no')
      })
    ).rejects.toBeInstanceOf(DefiniteSpendFailure)

    _resetSpendIntentStore()
    const rerun = vi.fn()
    await expect(
      withSpendIntent('send_token#key-1', rerun, { durable: true, fingerprint: 'fp1' })
    ).rejects.toBeInstanceOf(SettledIntentTombstoneError)
    expect(rerun).not.toHaveBeenCalled()
    await expect(
      withSpendIntent('send_token#key-2', async () => 'ok')
    ).resolves.toEqual({ value: 'ok', replayed: false })
  })

  it('operator resolve clears a lock durably; forget clears a settled result', async () => {
    await expect(
      withSpendIntent('lock#1', async () => {
        throw new Error('rpc timeout')
      })
    ).rejects.toThrow()
    expect(resolveSpendIntent('lock#1', 'unsettled')).toMatchObject({ outcome: 'unsettled' })
    _resetSpendIntentStore()
    await expect(withSpendIntent('lock#1', async () => 'after')).resolves.toEqual({
      value: 'after',
      replayed: false,
    })
    forgetSettledIntent('lock#1')
    await expect(withSpendIntent('lock#1', async () => 'again')).resolves.toEqual({
      value: 'again',
      replayed: false,
    })
  })
})

describe('withKeyedLock', () => {
  it('serialises tasks per key and isolates failures', async () => {
    const order: string[] = []
    const slow = withKeyedLock('origin-a', async () => {
      order.push('a1-start')
      await new Promise((r) => setTimeout(r, 10))
      order.push('a1-end')
      throw new Error('boom')
    })
    const second = withKeyedLock('origin-a', async () => {
      order.push('a2')
      return 2
    })
    const other = withKeyedLock('origin-b', async () => {
      order.push('b1')
      return 3
    })
    await expect(slow).rejects.toThrow('boom')
    await expect(second).resolves.toBe(2)
    await expect(other).resolves.toBe(3)
    expect(order.indexOf('a2')).toBeGreaterThan(order.indexOf('a1-end'))
    expect(order.indexOf('b1')).toBeLessThan(order.indexOf('a1-end'))
  })
})
