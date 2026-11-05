import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { guardRequest, guardToolCall } from '../src/utils/tool-guard.js'

// Fake secret only (S7).
const SECRET = 'FAKEsecretPATHnotreal'

describe('S1: dispatcher boundary', () => {
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
