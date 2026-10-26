/**
 * F18 / CWE-400: add_custom_token must not allow unbounded retained registry
 * growth, and list_chain_tokens must not serialize the whole registry.
 *
 * Uses the REAL agentwallet-sdk global TokenRegistry (no mock) so the quota is
 * exercised against the same process-wide store the payment tools read.
 * Each test uses its own symbol/address prefix because the SDK registry
 * itself cannot be cleared; `_resetCustomTokenQuota()` clears only the
 * tool's own tracking.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { getGlobalRegistry } from 'agentwallet-sdk'
import {
  AddCustomTokenSchema,
  ListChainTokensSchema,
  CUSTOM_TOKEN_CHAIN_IDS,
  MAX_CUSTOM_TOKENS_PER_CHAIN,
  MAX_CUSTOM_TOKENS_TOTAL,
  LIST_TOKENS_DEFAULT_LIMIT,
  LIST_TOKENS_MAX_LIMIT,
  addCustomTokenTool,
  listChainTokensTool,
  handleAddCustomToken,
  handleListChainTokens,
  getCustomTokenQuotaUsage,
  _resetCustomTokenQuota,
} from '../src/tools/tokens.js'
import { UNTRUSTED_BODY_BEGIN } from '../src/utils/format.js'

const BASE = 8453
const BASE_SEPOLIA = 84532
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** Unique lowercase address: 2-hex test prefix + counter. */
function addr(prefix: number, i: number): string {
  return `0x${prefix.toString(16).padStart(2, '0')}${(i + 1).toString(16).padStart(38, '0')}`
}

async function add(symbol: string, address: string, chainId = BASE, decimals = 18, name?: string) {
  return handleAddCustomToken({ symbol, address, decimals, chainId, ...(name ? { name } : {}) })
}

beforeEach(() => {
  _resetCustomTokenQuota()
})

describe('add_custom_token schema bounds', () => {
  const ok = { symbol: 'GOOD', address: addr(0x01, 0), decimals: 18, chainId: BASE }

  it('accepts a well-formed token', () => {
    expect(AddCustomTokenSchema.safeParse(ok).success).toBe(true)
    expect(AddCustomTokenSchema.safeParse({ ...ok, symbol: 'cbBTC.e_v2-x' }).success).toBe(true)
  })

  it('bounds symbol length and charset', () => {
    expect(AddCustomTokenSchema.safeParse({ ...ok, symbol: '' }).success).toBe(false)
    expect(AddCustomTokenSchema.safeParse({ ...ok, symbol: 'A'.repeat(16) }).success).toBe(true)
    expect(AddCustomTokenSchema.safeParse({ ...ok, symbol: 'A'.repeat(17) }).success).toBe(false)
    expect(AddCustomTokenSchema.safeParse({ ...ok, symbol: 'US DC' }).success).toBe(false)
    expect(AddCustomTokenSchema.safeParse({ ...ok, symbol: 'USDC\n' }).success).toBe(false)
    expect(AddCustomTokenSchema.safeParse({ ...ok, symbol: 'IGNORE→ALL' }).success).toBe(false)
  })

  it('bounds name length and rejects control characters', () => {
    expect(AddCustomTokenSchema.safeParse({ ...ok, name: 'N'.repeat(64) }).success).toBe(true)
    expect(AddCustomTokenSchema.safeParse({ ...ok, name: 'N'.repeat(65) }).success).toBe(false)
    expect(AddCustomTokenSchema.safeParse({ ...ok, name: 'line1\nline2' }).success).toBe(false)
    expect(AddCustomTokenSchema.safeParse({ ...ok, name: 'rlo‮evil' }).success).toBe(false)
  })

  it('requires a valid, non-zero EVM address', () => {
    expect(AddCustomTokenSchema.safeParse({ ...ok, address: '0x1234' }).success).toBe(false)
    expect(AddCustomTokenSchema.safeParse({ ...ok, address: 'not an address' }).success).toBe(false)
    expect(
      AddCustomTokenSchema.safeParse({ ...ok, address: '0x0000000000000000000000000000000000000000' })
        .success
    ).toBe(false)
    // bad EIP-55 checksum (mixed case, wrong)
    expect(
      AddCustomTokenSchema.safeParse({ ...ok, address: '0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913' })
        .success
    ).toBe(false)
    expect(AddCustomTokenSchema.safeParse({ ...ok, address: USDC_BASE }).success).toBe(true)
  })

  it('restricts chainId to supported chains', () => {
    for (const chainId of CUSTOM_TOKEN_CHAIN_IDS) {
      expect(AddCustomTokenSchema.safeParse({ ...ok, chainId }).success).toBe(true)
    }
    for (const chainId of [1, 10, 137, 42161, 99999, 0, -1]) {
      expect(AddCustomTokenSchema.safeParse({ ...ok, chainId }).success).toBe(false)
    }
  })

  it('handler enforces bounds even when called without the dispatcher parse', async () => {
    const before = getCustomTokenQuotaUsage().total
    for (const bad of [
      { symbol: 'S'.repeat(10_000), address: addr(0x02, 0), decimals: 18, chainId: BASE },
      { symbol: 'ZERO', address: '0x0000000000000000000000000000000000000000', decimals: 18, chainId: BASE },
      { symbol: 'OTHERCHAIN', address: addr(0x02, 1), decimals: 18, chainId: 99999 },
      { symbol: 'LONGNAME', address: addr(0x02, 2), decimals: 18, chainId: BASE, name: 'n'.repeat(5000) },
    ]) {
      const result = await handleAddCustomToken(bad as any)
      expect(result.isError).toBe(true)
      // Errors are fenced (zod quotes offending input).
      expect(result.content[0]!.text).toContain(UNTRUSTED_BODY_BEGIN)
    }
    expect(getCustomTokenQuotaUsage().total).toBe(before)
    expect(getGlobalRegistry().getToken('ZERO', BASE)).toBeUndefined()
    expect(getGlobalRegistry().listTokens(99999)).toHaveLength(0)
  })

  it('published inputSchema mirrors the zod bounds', () => {
    const p = addCustomTokenTool.inputSchema.properties
    expect(p.symbol).toMatchObject({ minLength: 1, maxLength: 16, pattern: '^[A-Za-z0-9._-]+$' })
    expect(p.name).toMatchObject({ maxLength: 64 })
    expect(p.address).toMatchObject({ pattern: '^0x[0-9a-fA-F]{40}$' })
    expect(p.chainId).toMatchObject({ enum: [...CUSTOM_TOKEN_CHAIN_IDS] })
    expect(p.decimals).toMatchObject({ minimum: 0, maximum: 18 })

    const l = listChainTokensTool.inputSchema.properties
    expect(l.limit).toMatchObject({ minimum: 1, maximum: LIST_TOKENS_MAX_LIMIT })
    expect(l.offset).toMatchObject({ minimum: 0 })
  })
})

describe('add_custom_token quotas', () => {
  it('enforces the per-chain limit and fails closed', async () => {
    for (let i = 0; i < MAX_CUSTOM_TOKENS_PER_CHAIN; i++) {
      const r = await add(`PC${i}`, addr(0x10, i))
      expect(r.isError).toBeUndefined()
    }
    expect(getCustomTokenQuotaUsage().byChain[BASE]).toBe(MAX_CUSTOM_TOKENS_PER_CHAIN)

    const over = await add('PCOVER', addr(0x10, 999))
    expect(over.isError).toBe(true)
    expect(over.content[0]!.text).toContain(`Custom token limit reached for chain ${BASE}`)
    expect(getGlobalRegistry().getToken('PCOVER', BASE)).toBeUndefined()

    // other chain still has room
    const other = await add('PCOTHER', addr(0x11, 0), BASE_SEPOLIA)
    expect(other.isError).toBeUndefined()
  })

  it('enforces the global limit across chains and fails closed', async () => {
    expect(MAX_CUSTOM_TOKENS_TOTAL).toBeLessThan(
      MAX_CUSTOM_TOKENS_PER_CHAIN * CUSTOM_TOKEN_CHAIN_IDS.length
    )
    let n = 0
    for (let i = 0; i < MAX_CUSTOM_TOKENS_PER_CHAIN; i++, n++) {
      expect((await add(`GA${i}`, addr(0x20, i), BASE)).isError).toBeUndefined()
    }
    for (let i = 0; n < MAX_CUSTOM_TOKENS_TOTAL; i++, n++) {
      expect((await add(`GB${i}`, addr(0x21, i), BASE_SEPOLIA)).isError).toBeUndefined()
    }
    expect(getCustomTokenQuotaUsage().total).toBe(MAX_CUSTOM_TOKENS_TOTAL)

    const over = await add('GBOVER', addr(0x21, 999), BASE_SEPOLIA)
    expect(over.isError).toBe(true)
    expect(over.content[0]!.text).toContain(`${MAX_CUSTOM_TOKENS_TOTAL} total`)
    expect(getGlobalRegistry().getToken('GBOVER', BASE_SEPOLIA)).toBeUndefined()
    expect(getCustomTokenQuotaUsage().total).toBe(MAX_CUSTOM_TOKENS_TOTAL)
  })

  it('identical re-registration is idempotent and does not consume quota', async () => {
    const first = await add('IDEM', addr(0x30, 0))
    expect(JSON.parse(first.content[0]!.text).idempotent).toBe(false)
    const usage = getCustomTokenQuotaUsage().total

    for (let i = 0; i < 10; i++) {
      // case-insensitive symbol, same address/decimals
      const again = await add('idem', addr(0x30, 0))
      expect(again.isError).toBeUndefined()
      expect(JSON.parse(again.content[0]!.text).idempotent).toBe(true)
    }
    expect(getCustomTokenQuotaUsage().total).toBe(usage)
  })

  it('idempotent re-registration still succeeds when the quota is full', async () => {
    for (let i = 0; i < MAX_CUSTOM_TOKENS_PER_CHAIN; i++) {
      await add(`FULL${i}`, addr(0x31, i))
    }
    const again = await add('FULL0', addr(0x31, 0))
    expect(again.isError).toBeUndefined()
    expect(JSON.parse(again.content[0]!.text).idempotent).toBe(true)
  })

  it('keeps overwrite/alias refusal semantics via the O(1) index', async () => {
    // built-in alias with different decimals is refused
    const fake = await add('FAKEUSDC', USDC_BASE, BASE, 18)
    expect(fake.isError).toBe(true)
    expect(fake.content[0]!.text).toContain('A different symbol does not bypass the decimals lock')

    // custom alias with different decimals is refused
    expect((await add('MINE', addr(0x40, 0), BASE, 8)).isError).toBeUndefined()
    const alias = await add('MINE2', addr(0x40, 0), BASE, 18)
    expect(alias.isError).toBe(true)
    expect(alias.content[0]!.text).toContain('A different symbol does not bypass the decimals lock')

    // same-decimals alias is allowed (and consumes quota)
    const before = getCustomTokenQuotaUsage().total
    expect((await add('MINE3', addr(0x40, 0), BASE, 8)).isError).toBeUndefined()
    expect(getCustomTokenQuotaUsage().total).toBe(before + 1)

    // overwrite of existing symbol is refused
    const over = await add('MINE', addr(0x40, 1), BASE, 8)
    expect(over.isError).toBe(true)
    expect(over.content[0]!.text).toContain('already registered')
  })
})

describe('list_chain_tokens pagination', () => {
  it('defaults, caps the limit and reports total + nextOffset', async () => {
    for (let i = 0; i < 60; i++) {
      await add(`LP${i}`, addr(0x50, i), BASE_SEPOLIA)
    }
    const total = getGlobalRegistry().listTokens(BASE_SEPOLIA).length
    expect(total).toBeGreaterThanOrEqual(60)

    const page1 = JSON.parse((await handleListChainTokens({ chainId: BASE_SEPOLIA })).content[0]!.text)
    expect(page1.total).toBe(total)
    expect(page1.limit).toBe(LIST_TOKENS_DEFAULT_LIMIT)
    expect(page1.tokens).toHaveLength(LIST_TOKENS_DEFAULT_LIMIT)
    expect(page1.count).toBe(LIST_TOKENS_DEFAULT_LIMIT)
    expect(page1.nextOffset).toBe(LIST_TOKENS_DEFAULT_LIMIT)

    const page2 = JSON.parse(
      (await handleListChainTokens({ chainId: BASE_SEPOLIA, offset: page1.nextOffset })).content[0]!
        .text
    )
    expect(page2.tokens).toHaveLength(total - LIST_TOKENS_DEFAULT_LIMIT)
    expect(page2.nextOffset).toBeNull()
    const seen = new Set([...page1.tokens, ...page2.tokens].map((t: any) => t.symbol))
    expect(seen.size).toBe(total)

    // limit is capped even when called directly
    const big = JSON.parse(
      (await handleListChainTokens({ chainId: BASE_SEPOLIA, limit: 10_000 })).content[0]!.text
    )
    expect(big.limit).toBe(LIST_TOKENS_MAX_LIMIT)
    expect(big.tokens.length).toBeLessThanOrEqual(LIST_TOKENS_MAX_LIMIT)

    // offset past the end
    const past = JSON.parse(
      (await handleListChainTokens({ chainId: BASE_SEPOLIA, offset: 10_000 })).content[0]!.text
    )
    expect(past.tokens).toHaveLength(0)
    expect(past.nextOffset).toBeNull()
  })

  it('schema rejects limit above max and negative offset', () => {
    expect(ListChainTokensSchema.safeParse({ chainId: BASE, limit: LIST_TOKENS_MAX_LIMIT }).success).toBe(true)
    expect(ListChainTokensSchema.safeParse({ chainId: BASE, limit: LIST_TOKENS_MAX_LIMIT + 1 }).success).toBe(false)
    expect(ListChainTokensSchema.safeParse({ chainId: BASE, limit: 0 }).success).toBe(false)
    expect(ListChainTokensSchema.safeParse({ chainId: BASE, offset: -1 }).success).toBe(false)
  })
})
