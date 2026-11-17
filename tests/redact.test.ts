/**
 * Redaction rules R1-R7 of the round-3 output sink (SO f9fa2539 S2, S3, S7).
 * Every secret here is a FAKE value made up for the test.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { HttpRequestError } from 'viem'
import {
  _resetStdioConsoleSinkForTests,
  _resetStdioProtocolModeForTests,
  enterStdioProtocolMode,
  installStdioConsoleSink,
  redactSecrets,
  safeText,
  toolText,
} from '../src/utils/sink.js'

const FAKE_KEY = '0x' + '1f'.repeat(32)
const FAKE_RPC = 'https://base-mainnet.example-rpc.test/v2/FAKEfakeFAKE0123456789abcd'
const ENV = { RPC_URL: FAKE_RPC, AGENT_PRIVATE_KEY: FAKE_KEY, SOME_API_KEY: 'fake-api-key-value-123', OTEL_AUTH: 'fake-auth-0987654' }

describe('R1: URL-encoded secret env values', () => {
  it('masks double URL-encoding of a configured secret', () => {
    const rpc = 'https://rpc.fake.test/v2/key=a/b'
    const once = encodeURIComponent(rpc)
    const twice = encodeURIComponent(once)
    const out = redactSecrets(`q=${twice}`, { RPC_URL: rpc })
    expect(out).not.toContain(once)
    expect(out).not.toContain(twice)
    expect(out).toContain('[redacted]')
  })
  it('masks encodeURIComponent(RPC_URL) when it differs from the raw value', () => {
    const rpc = 'https://rpc.fake.test/v2/key=a/b'
    const encoded = encodeURIComponent(rpc)
    expect(encoded).not.toBe(rpc)
    const out = redactSecrets(`probe ?u=${encoded}`, { RPC_URL: rpc })
    expect(out).not.toContain('a/b')
    expect(out).not.toContain(encoded)
    expect(out).toContain('[redacted]')
  })
})

describe('R1: configured secret values verbatim', () => {
  it('redacts padded env secret values and surrounding output (A8 / 60de729)', () => {
    const secret = 'FAKEpaddedSecretValue012345'
    const env = { SOME_API_KEY: `  ${secret}  ` }
    const out = redactSecrets(`before ${secret} after`, env)
    expect(out).not.toContain(secret)
    expect(out).toContain('[redacted]')
  })

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
  it.each([
    ['GITHUB_PAT', 'ghp_FAKEgithubPATtoken0123456789'],
    ['WALLET_PASSPHRASE', 'fake-wallet-passphrase-12345'],
    ['BACKUP_MNEMONIC', 'fake-exported-mnemonic-string'],
    ['WALLET_SEED', 'fake-wallet-seed-material1'],
    ['SEED_PHRASE', 'fake-seed-phrase-material-xyz'],
    ['BROKER_CREDENTIALS', 'fake-broker-credentials99'],
  ])('removes %s pattern values (A6)', (name, value) => {
    const out = redactSecrets(`failed: ${value} end`, { [name]: value })
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

describe('A7: short provider path keys without RPC_URL configured', () => {
  it('masks an Alchemy-style short v2 key path', () => {
    const url = 'https://base-mainnet.g.alchemy.test/v2/Ab12Cd34Ef56Gh78'
    const out = redactSecrets(`err ${url}`, {})
    expect(out).toBe('err https://base-mainnet.g.alchemy.test/[redacted]')
    expect(out).not.toContain('Ab12Cd34Ef56Gh78')
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

describe('A4: prose must not exempt private keys', () => {
  const hex = 'ab'.repeat(32)
  it('masks transaction signing failed for key 0x…', () => {
    const out = redactSecrets(`transaction signing failed for key 0x${hex}`, { AGENT_PRIVATE_KEY: `0x${hex}` })
    expect(out).not.toContain(hex)
    expect(out).toContain('[redacted]')
  })
  it('SO A4 masks transaction signing failed for key 0x<64hex> without env match', () => {
    const out = redactSecrets(`transaction signing failed for key 0x${hex}`, {})
    expect(out).not.toContain(hex)
    expect(out).toContain('[redacted-hex64]')
  })
  it('SO A4 masks cannot sign tx with key 0x<64hex>', () => {
    const out = redactSecrets(`cannot sign tx with key 0x${hex}`, {})
    expect(out).not.toContain(hex)
    expect(out).toContain('[redacted-hex64]')
  })
  it('masks similar prose with hash wording but no label', () => {
    const out = redactSecrets(`could not verify hash material 0x${hex}`, {})
    expect(out).toBe('could not verify hash material [redacted-hex64]')
  })
})

describe('R4: bare 32-byte hex', () => {
  const hex = 'ab'.repeat(32)
  it('masks unlabelled hex64', () => {
    expect(redactSecrets(`value ${hex}`, {})).toBe('value [redacted-hex64]')
  })
  it.each([
    'TX Hash:   0x',
    'txHash: 0x',
    'tx_hash: 0x',
    'transactionHash: 0x',
    'hash: 0x',
    'tx: 0x',
    'blockHash: 0x',
  ])('keeps labelled %j', (label) => {
    expect(redactSecrets(`${label}${hex}`, {})).toBe(`${label}${hex}`)
  })
  it('keeps tx hash with long whitespace run before hex (A8 / 60de729)', () => {
    const label = `hash:${' '.repeat(32)}`
    expect(redactSecrets(`${label}${hex}`, {})).toBe(`${label}${hex}`)
  })
  it('masks whitespace-split unconfigured private key', () => {
    const split = hex.match(/.{2}/g)!.join(' ')
    expect(redactSecrets(`leaked ${split}`, {})).toBe('leaked [redacted-hex64]')
  })
  it('masks a 64-hex key split into two 32-char halves (Sev4)', () => {
    const a = hex.slice(0, 32)
    const b = hex.slice(32)
    expect(redactSecrets(`k=${a} ${b}`, {})).toBe('k=[redacted-hex64]')
  })
  it('keeps 20-byte addresses', () => {
    const addr = '0x' + '12'.repeat(20)
    expect(redactSecrets(addr, {})).toBe(addr)
  })
  it('Sev4 word-boundary labels: ctx and secretHash do not exempt bare hex', () => {
    const hex = 'ab'.repeat(32)
    expect(redactSecrets(`ctx: 0x${hex}`, {})).toBe(`ctx: [redacted-hex64]`)
    expect(redactSecrets(`secretHash: 0x${hex}`, {})).toBe(`secretHash: [redacted-hex64]`)
  })
  it('Sev4 keys ending in block do not exempt bare hex', () => {
    const hex = 'ab'.repeat(32)
    expect(redactSecrets(`fooBlock: 0x${hex}`, {})).toBe(`fooBlock: [redacted-hex64]`)
  })
  it('Sev4 still exempts txHash labelled output', () => {
    const hex = 'ab'.repeat(32)
    expect(redactSecrets(`txHash: 0x${hex}`, {})).toBe(`txHash: 0x${hex}`)
  })
})

describe('SO A3 console shim single-quoted headers', () => {
  afterEach(() => {
    _resetStdioConsoleSinkForTests()
    _resetStdioProtocolModeForTests()
    vi.restoreAllMocks()
  })

  it.each([
    "{ 'x-auth-token': 'FAKE' }",
    "{ 'api-key': 'FAKE' }",
    "{ 'x-api-key': 'FAKE' }",
    "{ 'cookie': 'sid=FAKE' }",
    "{ 'set-cookie': 'sid=FAKE; Path=/' }",
    "{ 'x-payment': 'FAKE' }",
    'Cookie: sid="FAKE"',
  ])('SO A3 console shim stderr redacts %s', (line) => {
    installStdioConsoleSink()
    enterStdioProtocolMode()
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    console.info(line)
    const written = err.mock.calls.map((c) => String(c[0])).join('')
    expect(written).not.toContain('FAKE')
    expect(written).toContain('[redacted]')
  })
})

describe('R5: BIP-39 mnemonics', () => {
  const twelve = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
  it('masks 12 words', () => expect(redactSecrets(`mnemonic=${twelve}.`, {})).toBe('mnemonic=[redacted-mnemonic].'))
  it('masks 24 words', () => expect(redactSecrets(`${twelve} ${twelve}`, {})).toBe('[redacted-mnemonic]'))
  it('masks capitalized mnemonics (A5)', () => {
    const cap = twelve.replace(/\b\w/g, (c) => c.toUpperCase())
    expect(redactSecrets(cap, {})).toBe('[redacted-mnemonic]')
  })
  it('masks NBSP-split mnemonics (A5)', () => {
    expect(redactSecrets(twelve.replace(/ /g, '\u00a0'), {})).toBe('[redacted-mnemonic]')
  })
  it('masks numbered mnemonic lists (A5)', () => {
    const numbered = twelve
      .split(' ')
      .map((w, i) => `${i + 1}. ${w}`)
      .join(' ')
    expect(redactSecrets(numbered, {})).toBe('[redacted-mnemonic]')
  })
  it('leaves ordinary sentences', () => {
    const s = 'the payment could not be completed because the remote server returned an invalid response body'
    expect(redactSecrets(s, {})).toBe(s)
  })
})

describe('R6: JWT-shaped tokens', () => {
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlIn0.FAKEsigFAKEsigFAKEsigFAKEsigFAKEsig00'
  it('masks a JWT with spaces around dots', () => {
    const spaced = jwt.replace(/\./g, ' . ')
    const out = redactSecrets(`t=${spaced}`, {})
    expect(out).not.toContain('eyJhbGci')
    expect(out).toContain('[redacted-jwt]')
  })
  it('masks a bare JWT', () => {
    const out = redactSecrets(`token ${jwt} end`, {})
    expect(out).not.toContain(jwt)
    expect(out).toContain('[redacted-jwt]')
  })
  it('masks a JWT inside JSON', () => {
    const out = redactSecrets(`{"access_token":"${jwt}"}`, {})
    expect(out).not.toContain(jwt)
    expect(out).toContain('[redacted-jwt]')
  })
})

describe('R6: auth headers and bearer tokens', () => {
  it("masks single-quoted 'authorization'", () => {
    expect(redactSecrets("'authorization': 'FAKEbearer123456'", {})).not.toContain('FAKEbearer123456')
  })
  it("masks single-quoted 'proxy-authorization'", () => {
    expect(redactSecrets("'proxy-authorization': 'FAKEproxy99'", {})).not.toContain('FAKEproxy99')
  })
  it.each([
    ["{ 'x-auth-token': 'FAKE' }", 'FAKE'],
    ["{ 'api-key': 'FAKE' }", 'FAKE'],
    ["{ 'x-api-key': 'FAKE' }", 'FAKE'],
    ["{ 'cookie': 'sid=FAKE' }", 'FAKE'],
    ["{ 'set-cookie': 'sid=FAKE; Path=/' }", 'FAKE'],
    ["{ 'x-payment': 'FAKE' }", 'FAKE'],
    ['Cookie: sid="FAKE"', 'FAKE'],
  ])('SO A3 safeText redacts %s', (input, secret) => {
    const out = safeText(input)
    expect(out).not.toContain(secret)
    expect(out).toContain('[redacted]')
  })
  it('masks x-auth-token header', () => {
    expect(redactSecrets('x-auth-token: FAKEauthToken12', {})).not.toContain('FAKEauthToken12')
  })
  it('masks api-key header', () => {
    expect(redactSecrets('api-key: FAKEapiKeyHeader9', {})).not.toContain('FAKEapiKeyHeader9')
  })
  it('SO A3 masks Authorization header value with double quotes', () => {
    expect(redactSecrets('"authorization": "FAKEheaderSecret"', {})).not.toContain('FAKEheaderSecret')
  })
  it('SO A3 masks client_secret and access-token query params in URLs', () => {
    const u1 = redactSecrets('https://oauth.example/cb?client_secret=FAKEclientSecret99', {})
    const u2 = redactSecrets('https://api.example/t?access-token=FAKEaccessTok12', {})
    expect(u1).not.toContain('FAKEclientSecret99')
    expect(u2).not.toContain('FAKEaccessTok12')
    expect(u1).toContain('[redacted]')
    expect(u2).toContain('[redacted]')
  })
  it('masks credentials query parameter URL', () => {
    const out = redactSecrets('https://api.example.com/x?credentials=FAKEcred99', {})
    expect(out).not.toContain('FAKEcred99')
    expect(out).toContain('[redacted]')
  })
  it.each([
    ['Authorization: Bearer FAKEtoken123456', 'FAKEtoken123456'],
    ['Proxy-Authorization: Basic FAKEproxyauth99', 'FAKEproxyauth99'],
    ['X-API-Key: FAKEheaderApiKey12', 'FAKEheaderApiKey12'],
    ['X-PAYMENT: eyJfakepayload', 'eyJfakepayload'],
    ['X-PAYMENT-RESPONSE: eyJfakeresp', 'eyJfakeresp'],
    ['cookie: session=FAKEcookie', 'FAKEcookie'],
    ['sent Bearer FAKEsessionTok3n', 'FAKEsessionTok3n'],
    ['https://api.example.com/x?x-api-key=FAKEqueryKey9', 'FAKEqueryKey9'],
  ])('%s', (input, secret) => {
    expect(redactSecrets(input, {})).not.toContain(secret)
  })
})

describe('R7: idempotent, total, bounded', () => {
  it('is idempotent on mixed input', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJmYWtlIjp0cnVlfQ.FAKEjwtFAKEjwtFAKEjwtFAKEjwtFAKEjwt00'
    const x = `${FAKE_RPC} tx hash: ${FAKE_KEY} URL: https://u:p@h.test/x?key=1 Authorization: Bearer FAKEtoken123456 ${jwt}`
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

  describe('round-3 fix round (review of 416ba5d)', () => {
    it('masks serialized JSON auth headers, including Basic', () => {
      const out = redactSecrets('{"Authorization":"Basic RkFLRTpmYWtlcGFzcw==","x-payment": "FAKEpay123"}', {})
      expect(out).not.toContain('RkFLRTpmYWtlcGFzcw==')
      expect(out).not.toContain('FAKEpay123')
      expect(out).toContain('"Authorization":"[redacted]"')
    })
    it('masks digit-only and letter-only 32+ char key paths', () => {
      expect(redactSecrets('https://rpc.fake.test/v3/01234567890123456789012345678901', {})).toBe('https://rpc.fake.test/[redacted]')
      expect(redactSecrets('https://rpc.fake.test/v2/FAKEabcdefghijklmnopqrstuvwxyzABCDEF', {})).toBe('https://rpc.fake.test/[redacted]')
      expect(redactSecrets('https://api.example.com/paid-during-outage', {})).toBe('https://api.example.com/paid-during-outage')
    })
    it('masks a mnemonic split across lines', () => {
      const words = Array(11).fill('abandon').concat('about')
      expect(redactSecrets(words.join('\n'), {})).toBe('[redacted-mnemonic]')
    })
  })
})
