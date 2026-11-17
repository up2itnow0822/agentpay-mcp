import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as format from '../src/utils/format.js'
import {
  REQUEST_ERROR_WITHHELD,
  SENSITIVE_JSON_FIELD_NAMES,
  STRUCTURED_RESULT_WITHHELD,
  guardRequest,
  guardToolCall,
  redactToolResult,
} from '../src/utils/tool-guard.js'

// Fake secret only (S7).
const SECRET = 'FAKEsecretPATHnotreal'
const SHORT = 'tiny-leak-xyzzy'

describe('S1: dispatcher boundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('fail-closed when formatError throws (A1)', async () => {
    vi.spyOn(format, 'formatError').mockImplementation(() => {
      throw new Error('format exploded')
    })
    const r = (await guardToolCall('x', () => {
      throw new Error(`URL: https://x/v2/${SECRET}`)
    })) as { content: Array<{ text: string }>; isError: boolean }
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toContain('[tool error withheld: safe formatting failed]')
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('redacts sensitive object keys (A2)', () => {
    const r = redactToolResult({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { api_key: `https://x/v2/${SECRET}`, nested: { client_secret: SECRET } },
    }) as { structuredContent: Record<string, unknown> }
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(r.structuredContent).not.toHaveProperty('api_key')
    expect(r.structuredContent['[redacted]']).toBe('[redacted]')
    expect((r.structuredContent.nested as Record<string, unknown>)['[redacted]']).toBe('[redacted]')
    expect((r.structuredContent.nested as Record<string, unknown>)).not.toHaveProperty('client_secret')
  })

  it('redacts object keys that embed RPC URLs (A2 round 3)', () => {
    const evilKey = `https://x/v2/${SECRET}/_meta`
    const r = redactToolResult({
      structuredContent: { [evilKey]: 'safe-value' },
    }) as { structuredContent: Record<string, unknown> }
    const serialized = JSON.stringify(r)
    expect(serialized).not.toContain(SECRET)
    expect(Object.keys(r.structuredContent)).not.toContain(evilKey)
    expect(r.structuredContent[Object.keys(r.structuredContent)[0]!]).toBe('safe-value')
  })

  it('disambiguates natural keys that export to the same [redacted] text without dropping siblings', () => {
    const r = redactToolResult({
      structuredContent: { api_key: 'value-one', client_secret: 'value-two', visible: 'ok' },
    }) as { structuredContent: Record<string, unknown> }
    const keys = Object.keys(r.structuredContent).filter((k) => k === '[redacted]' || k.startsWith('[redacted] #'))
    expect(keys).toHaveLength(2)
    expect(new Set(keys)).toEqual(new Set(['[redacted]', '[redacted] #2']))
    expect(r.structuredContent['[redacted]']).toBe('[redacted]')
    expect(r.structuredContent['[redacted] #2']).toBe('[redacted]')
    expect(r.structuredContent.visible).toBe('ok')
  })

  it('disambiguates redacted object keys without dropping sibling values (A2 round 3)', () => {
    const keyA = 'https://x.y/v2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/keyA'
    const keyB = 'https://x.y/v2/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/keyB'
    const r = redactToolResult({
      structuredContent: { [keyA]: 'value-one', [keyB]: 'value-two' },
    }) as { structuredContent: Record<string, unknown> }
    const keys = Object.keys(r.structuredContent)
    expect(keys).toHaveLength(2)
    expect(new Set(Object.values(r.structuredContent))).toEqual(new Set(['value-one', 'value-two']))
    expect(keys.some((k) => k.includes(' #2'))).toBe(true)
  })

  it('keeps a literal [redacted] #2 export key distinct (A2 round 3)', () => {
    const r = redactToolResult({
      structuredContent: {
        '[redacted]': 'first',
        '[redacted] #2': 'second',
      },
    }) as { structuredContent: Record<string, unknown> }
    expect(r.structuredContent['[redacted]']).toBe('first')
    expect(r.structuredContent['[redacted] #2']).toBe('second')
  })

  it('redacts _meta values holding RPC URLs (A2)', () => {
    const r = redactToolResult({
      structuredContent: { _meta: `URL: https://x/v2/${SECRET}` },
    }) as { structuredContent: { _meta: string } }
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(r.structuredContent._meta).toContain('[redacted]')
  })

  it.each(SENSITIVE_JSON_FIELD_NAMES)(
    'masks JSON key %s (escaped \\" in value, sibling intact)',
    (name) => {
      const r = redactToolResult({
        structuredContent: { [name]: `x\\"${SHORT}`, sibling_ok: 'visible' },
      }) as { structuredContent: Record<string, unknown> }
      expect(JSON.stringify(r)).not.toContain(SHORT)
      expect(r.structuredContent['[redacted]']).toBe('[redacted]')
      expect(r.structuredContent.sibling_ok).toBe('visible')
    }
  )

  it('masks sensitive api_key at top level', () => {
    const r = redactToolResult({ structuredContent: { api_key: SHORT } }) as {
      structuredContent: Record<string, unknown>
    }
    expect(JSON.stringify(r)).not.toContain(SHORT)
    expect(r.structuredContent['[redacted]']).toBe('[redacted]')
  })

  it('masks sensitive client_secret in a nested object', () => {
    const r = redactToolResult({
      structuredContent: { nested: { client_secret: SHORT } },
    }) as { structuredContent: { nested: Record<string, unknown> } }
    expect(JSON.stringify(r)).not.toContain(SHORT)
    expect(r.structuredContent.nested['[redacted]']).toBe('[redacted]')
  })

  it('masks sensitive password under _meta', () => {
    const r = redactToolResult({
      structuredContent: { _meta: { password: SHORT } },
    }) as { structuredContent: { _meta: Record<string, unknown> } }
    expect(JSON.stringify(r)).not.toContain(SHORT)
    expect((r.structuredContent._meta as Record<string, unknown>)['[redacted]']).toBe('[redacted]')
  })

  it('masks sensitive token inside an array of objects', () => {
    const r = redactToolResult({
      structuredContent: { items: [{ token: SHORT }, { note: 'ok' }] },
    }) as { structuredContent: { items: Array<Record<string, unknown>> } }
    expect(JSON.stringify(r)).not.toContain(SHORT)
    expect(r.structuredContent.items[0]!['[redacted]']).toBe('[redacted]')
    expect(r.structuredContent.items[1]!.note).toBe('ok')
  })

  it('masks a URL containing \\" in JSON text values', () => {
    const r = redactToolResult({
      structuredContent: {
        note: `see https://x/v2/${SECRET}/path\\"frag`,
      },
    }) as { structuredContent: { note: string } }
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(r.structuredContent.note).toContain('[redacted]')
  })

  it('serializes bigint fields as decimal strings (viem-shaped transfer)', () => {
    const r = redactToolResult({
      structuredContent: {
        value: 1_000_000n,
        gas: 21_000n,
        blockNumber: 18_500_000n,
      },
    }) as { structuredContent: { value: string; gas: string; blockNumber: string } }
    expect(r.structuredContent.value).toBe('1000000')
    expect(r.structuredContent.gas).toBe('21000')
    expect(r.structuredContent.blockNumber).toBe('18500000')
  })

  it('__proto__ stays an own key and does not pollute Object.prototype', () => {
    const probe = { marker: 'keep' }
    const input: Record<string, unknown> = { note: 'ok' }
    Object.defineProperty(input, '__proto__', {
      value: probe,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    const r = redactToolResult(input) as Record<string, unknown>
    expect(Object.prototype).not.toHaveProperty('marker')
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype)
    expect(Object.hasOwn(r, '__proto__')).toBe(true)
    expect(r['__proto__']).toEqual({ marker: 'keep' })
    expect(r.note).toBe('ok')
  })

  it('withholds circular structured results', () => {
    const ring: Record<string, unknown> = { a: 1 }
    ring.self = ring
    expect(redactToolResult({ structuredContent: ring })).toBe(STRUCTURED_RESULT_WITHHELD)
  })

  it('withholds when structuredContent has a throwing getter', async () => {
    const evil: Record<string, unknown> = {}
    Object.defineProperty(evil, 'note', {
      enumerable: true,
      get() {
        throw new Error(`URL: https://x/v2/${SECRET}`)
      },
    })
    const r = await guardToolCall('x', async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: evil,
    }))
    expect(r).toBe(STRUCTURED_RESULT_WITHHELD)
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('redacts secrets returned from toJSON before stringify', () => {
    const boxed = {
      toJSON() {
        return { api_key: SECRET, ok: true }
      },
    }
    const r = redactToolResult({ structuredContent: boxed }) as {
      structuredContent: Record<string, unknown>
    }
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(r.structuredContent['[redacted]']).toBe('[redacted]')
    expect(r.structuredContent.ok).toBe(true)
  })

  it('redacts structuredContent and resource blocks (A2)', () => {
    const r = redactToolResult({
      content: [{ type: 'text', text: `ok` }],
      structuredContent: { note: `URL: https://x/v2/${SECRET}` },
      resource: { uri: 'x', mimeType: 'text/plain', text: `Bearer ${SECRET}bearer` },
    }) as {
      structuredContent: { note: string }
      resource: { text: string }
    }
    expect(r.structuredContent.note).not.toContain(SECRET)
    expect(r.resource.text).not.toContain(SECRET)
    expect(r.structuredContent.note).toContain('[redacted]')
  })

  it('a throwing tool returns a redacted tool error, never the secret', async () => {
    const r = (await guardToolCall('pay_x402', () => {
      throw new Error(`URL: https://x/v2/${SECRET}`)
    })) as { content: Array<{ text: string }>; isError: boolean }
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(r.content[0].text).toContain('URL: [redacted]')
  })

  it('a rejecting async tool is caught too', async () => {
    const r = await guardToolCall('x', async () => Promise.reject(new Error(`URL: https://x/v2/${SECRET}`)))
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('successful results are re-redacted', async () => {
    const r = await guardToolCall('x', async () => ({
      content: [{ type: 'text', text: `URL: https://x/v2/${SECRET}\nRequest body: {}` }],
    }))
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('guardRequest withholds when error.message getter throws', async () => {
    const evil = Object.create(Error.prototype) as Error
    Object.defineProperty(evil, 'message', {
      configurable: true,
      get(): string {
        throw new Error(`URL: https://x/v2/${SECRET}`)
      },
    })
    await expect(
      guardRequest(() => {
        throw evil
      })
    ).rejects.toThrow(REQUEST_ERROR_WITHHELD)
    const err = await guardRequest(() => {
      throw evil
    }).catch((e: Error) => e)
    expect(err.message).toBe(REQUEST_ERROR_WITHHELD)
    expect(JSON.stringify(err)).not.toContain(SECRET)
  })

  it('list-handler errors carry no secret in the JSON-RPC message', async () => {
    await expect(
      guardRequest(() => {
        throw new Error(`URL: https://x/v2/${SECRET}`)
      })
    ).rejects.toThrow(/URL: \[redacted\]/)
    const err = await guardRequest(() => {
      throw new Error(`URL: https://x/v2/${SECRET}`)
    }).catch((e: Error) => e)
    expect(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (err as Error).message } })).not.toContain(SECRET)
  })

  it('index.ts wraps both handlers and awaits every tool handler', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/ListToolsRequestSchema,\s*async \(\) =>\s*guardRequest\(/)
    expect(src).toMatch(/CallToolRequestSchema,[^\n]*\n[\s\S]{0,200}guardToolCall\(request\.params\?\.name, \(\) => routeToolCall\(request\)\)/)
    expect(src).not.toMatch(/return handle[A-Z]/)
    expect((src.match(/return await handle[A-Z]/g) ?? []).length).toBeGreaterThanOrEqual(28)
  })
})