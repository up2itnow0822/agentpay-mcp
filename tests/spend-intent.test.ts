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
  SpendIntentConflictError,
  UnresolvedSpendIntentError,
  _resetSpendIntentStore,
  _spendIntentStoreSizes,
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

  it('evicts the oldest durable result when the LRU cap is exceeded', async () => {
    const run = vi.fn().mockResolvedValue('0xnew')
    for (let i = 0; i < SPEND_INTENT_MAX_DURABLE; i++) {
      await withSpendIntent(`durable#${i}`, async () => `0x${i}`, { durable: true })
    }
    expect(_spendIntentStoreSizes().durable).toBe(SPEND_INTENT_MAX_DURABLE)

    await withSpendIntent('durable#overflow', run, { durable: true })
    expect(_spendIntentStoreSizes().durable).toBe(SPEND_INTENT_MAX_DURABLE)

    const evicted = vi.fn().mockResolvedValue('0xevicted-retry')
    const replay = await withSpendIntent('durable#0', evicted, { durable: true })
    expect(replay).toEqual({ value: '0xevicted-retry', replayed: false })
    expect(evicted).toHaveBeenCalledTimes(1)
  })

  it('caps unresolved locks so the permanent map cannot grow without bound', async () => {
    for (let i = 0; i < SPEND_INTENT_MAX_UNRESOLVED; i++) {
      await expect(
        withSpendIntent(`unknown#${i}`, async () => {
          throw new Error('rpc timeout')
        })
      ).rejects.toThrow('rpc timeout')
    }
    expect(_spendIntentStoreSizes().unresolved).toBe(SPEND_INTENT_MAX_UNRESOLVED)

    await expect(
      withSpendIntent('unknown#overflow', async () => {
        throw new Error('rpc timeout')
      })
    ).rejects.toThrow('rpc timeout')
    expect(_spendIntentStoreSizes().unresolved).toBe(SPEND_INTENT_MAX_UNRESOLVED)

    const retriedOldest = vi.fn().mockResolvedValue('0xafter-evict')
    const result = await withSpendIntent('unknown#0', retriedOldest)
    expect(result).toEqual({ value: '0xafter-evict', replayed: false })
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
    expect(walletClient.sendTransaction).not.toHaveBeenCalled()
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

  it('classifies a confirmed uncharged revert as definite', async () => {
    const walletClient = {
      sendTransaction: vi.fn().mockResolvedValue('0xsend'),
    }
    await expect(
      runClassifiedSpend(walletClient, async () => {
        await walletClient.sendTransaction({ to: '0x1' })
        throw new Error('depositForBurn transaction reverted (tx: 0xabc).')
      })
    ).rejects.toBeInstanceOf(DefiniteSpendFailure)
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
  const x402Base = { url: 'https://api.example.com/premium' }

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
