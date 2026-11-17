import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as format from '../src/utils/format.js'
import { guardRequest, guardToolCall, redactToolResult } from '../src/utils/tool-guard.js'

// Fake secret only (S7).
const SECRET = 'FAKEsecretPATHnotreal'

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
