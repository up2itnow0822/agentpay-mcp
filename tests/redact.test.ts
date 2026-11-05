/**
 * Redaction rules R1-R7 of the round-3 output sink (SO f9fa2539 S2, S3, S7).
 * Every secret here is a FAKE value made up for the test.
 */
import { describe, it, expect } from 'vitest'
import { HttpRequestError } from 'viem'
import { redactSecrets, safeText, toolText } from '../src/utils/sink.js'

const FAKE_KEY = '0x' + '1f'.repeat(32)
const FAKE_RPC = 'https://base-mainnet.example-rpc.test/v2/FAKEfakeFAKE0123456789abcd'
const ENV = { RPC_URL: FAKE_RPC, AGENT_PRIVATE_KEY: FAKE_KEY, SOME_API_KEY: 'fake-api-key-value-123', OTEL_AUTH: 'fake-auth-0987654' }

describe('R1: configured secret values verbatim', () => {
  it.each([
    ['RPC_URL', FAKE_RPC],
    ['AGENT_PRIVATE_KEY with 0x', FAKE_KEY],
    ['AGENT_PRIVATE_KEY without 0x', FAKE_KEY.slice(2)],
    ['AGENT_PRIVATE_KEY uppercase hex', FAKE_KEY.slice(2).toUpperCase()],
    ['*_API_KEY env', ENV.SOME_API_KEY],
    ['*_AUTH env', ENV.OTEL_AUTH],
  ])('removes %s', (_label, value) => {
    const out = redactSecrets(`failed: ${value} end`, ENV)
    expect(out).not.toContain(value)
    expect(out).toContain('[redacted]')
  })
  it('ignores short or non-secret env values', () => {
    expect(redactSecrets('chain 8453', { CHAIN_ID: '8453', X_TOKEN: 'short' })).toBe('chain 8453')
  })
})

describe('S2: R1 runs before the R4 tx-hash exemption', () => {
  it('redacts `tx hash: <key without 0x>`', () => {
    const out = redactSecrets(`tx hash: ${FAKE_KEY.slice(2)}`, ENV)
    expect(out).not.toContain(FAKE_KEY.slice(2))
    expect(out).toBe('tx hash: [redacted]')
  })
})

describe('R2: viem URL field', () => {
  it('masks the URL of a real viem HttpRequestError', () => {
    const err = new HttpRequestError({ url: 'https://rpc.fake.test/v2/k', body: { method: 'eth_call' }, details: 'boom' })
    const out = redactSecrets(err.message, {})
    expect(out).not.toContain('rpc.fake.test/v2/k')
    expect(out).toContain('URL: [redacted]')
  })
  it('leaves AgentPay-owned URL lines alone', () => {
    expect(redactSecrets('  URL: https://api.example.com/data', {})).toBe('  URL: https://api.example.com/data')
  })
})

describe('R3/S3: credential-bearing URLs keep scheme://host:port only', () => {
  it('drops userinfo, path key and query key', () => {
    const out = redactSecrets('see https://u:p@host.fake.test:8545/v2/K?apikey=Z now', {})
    expect(out).toBe('see https://host.fake.test:8545/[redacted] now')
    for (const s of ['u:p', 'K?', 'apikey', 'Z ']) expect(out).not.toContain(s)
  })
  it.each([
    'https://base-mainnet.g.alchemy.test/v2/FAKEalchemyKey0123456789',
    'https://mainnet.infura.test/v3/0123456789abcdef0123456789abcdef',
    'https://example.quiknode.test/FAKEqn0123456789abcdefgh/',
    'wss://rpc.fake.test/ws?token=FAKE123',
  ])('masks %s', (url) => {
    const out = redactSecrets(`err ${url}`, {})
    expect(out).toMatch(/^err (https|wss):\/\/[^/]+\/\[redacted\]$/)
  })
  it('keeps ordinary URLs', () => {
    expect(redactSecrets('https://api.example.com/paid-during-outage?page=2', {})).toBe(
      'https://api.example.com/paid-during-outage?page=2'
    )
  })
})

describe('R4: bare 32-byte hex', () => {
  const hex = 'ab'.repeat(32)
  it('masks unlabelled hex64', () => {
    expect(redactSecrets(`value ${hex}`, {})).toBe('value [redacted-hex64]')
  })
  it.each(['TX Hash:   0x', 'txHash: 0x', 'blockHash 0x', 'transaction 0x'])('keeps labelled %j', (label) => {
    expect(redactSecrets(`${label}${hex}`, {})).toBe(`${label}${hex}`)
  })
  it('keeps 20-byte addresses', () => {
    const addr = '0x' + '12'.repeat(20)
    expect(redactSecrets(addr, {})).toBe(addr)
  })
})

describe('R5: BIP-39 mnemonics', () => {
  const twelve = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
  it('masks 12 words', () => expect(redactSecrets(`mnemonic=${twelve}.`, {})).toBe('mnemonic=[redacted-mnemonic].'))
  it('masks 24 words', () => expect(redactSecrets(`${twelve} ${twelve}`, {})).toBe('[redacted-mnemonic]'))
  it('leaves ordinary sentences', () => {
    const s = 'the payment could not be completed because the remote server returned an invalid response body'
    expect(redactSecrets(s, {})).toBe(s)
  })
})

describe('R6: auth headers and bearer tokens', () => {
  it.each([
    ['Authorization: Bearer FAKEtoken123456', 'FAKEtoken123456'],
    ['X-PAYMENT: eyJfakepayload', 'eyJfakepayload'],
    ['X-PAYMENT-RESPONSE: eyJfakeresp', 'eyJfakeresp'],
    ['cookie: session=FAKEcookie', 'FAKEcookie'],
    ['sent Bearer FAKEsessionTok3n', 'FAKEsessionTok3n'],
  ])('%s', (input, secret) => {
    expect(redactSecrets(input, {})).not.toContain(secret)
  })
})

describe('R7: idempotent, total, bounded', () => {
  it('is idempotent on mixed input', () => {
    const x = `${FAKE_RPC} tx hash: ${FAKE_KEY} URL: https://u:p@h.test/x?key=1 Authorization: Bearer FAKEtoken123456`
    const once = redactSecrets(x, ENV)
    expect(redactSecrets(once, ENV)).toBe(once)
  })
  it('never throws on odd input', () => {
    expect(() => redactSecrets(undefined as unknown as string, {})).not.toThrow()
    expect(redactSecrets('', {})).toBe('')
  })
  it('handles 1 MB within 500 ms and idempotently over seeded random cases', () => {
    let seed = 42
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    const parts = ['a ', 'https://x.test/', 'ab'.repeat(32), ' URL: ', 'Bearer ', 'abandon ', '\n', FAKE_KEY]
    const big = Array.from({ length: 60000 }, () => parts[Math.floor(rnd() * parts.length)]).join('')
    const t = Date.now()
    const out = redactSecrets(big, ENV)
    expect(Date.now() - t).toBeLessThan(500)
    expect(redactSecrets(out, ENV)).toBe(out)
    for (let i = 0; i < 200; i++) {
      const s = Array.from({ length: 20 }, () => parts[Math.floor(rnd() * parts.length)]).join('')
      const r = redactSecrets(s, ENV)
      expect(redactSecrets(r, ENV)).toBe(r)
      expect(r).not.toContain(FAKE_KEY.slice(2))
    }
  })
})

describe('sink entry points', () => {
  it('safeText and toolText redact', () => {
    process.env['__FAKE_TEST_TOKEN'] = 'fake-token-abcdef'
    try {
      expect(safeText('x fake-token-abcdef')).toBe('x [redacted]')
      expect(toolText('x fake-token-abcdef')).toEqual({ type: 'text', text: 'x [redacted]' })
    } finally {
      delete process.env['__FAKE_TEST_TOKEN']
    }
  })
})
