import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTERED_TOOLS } from './registered-tools.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import * as format from '../src/utils/format.js'
import {
  REDACTION_GUARD_ERROR_TEXT,
  REQUEST_ERROR_WITHHELD,
  guardRequest,
  guardToolCall,
  redactToolResult,
} from '../src/utils/tool-guard.js'

const SECRET = 'FAKEsecretPATHnotreal'
const ROOT = join(import.meta.dirname, '..')

function expectValidCallToolResult(result: unknown): void {
  CallToolResultSchema.parse(result)
}

const TEXT_OUTPUT_MAX = 4 * 1024 * 1024

describe('S1: dispatcher boundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('no registered tool declares outputSchema', () => {
    expect(REGISTERED_TOOLS).toHaveLength(28)
    for (const tool of REGISTERED_TOOLS) {
      expect(tool, tool.name).not.toHaveProperty('outputSchema')
    }
  })

  it('MCP server exposes only list_tools and call_tool handlers (no resources/prompts/logging)', () => {
    const src = readFileSync(join(ROOT, 'src/index.ts'), 'utf8')
    expect(src).toContain('ListToolsRequestSchema')
    expect(src).toContain('CallToolRequestSchema')
    expect(src).not.toMatch(/ListResources|ReadResource|GetPrompt|ListPrompts|logging/i)
    expect(src).not.toMatch(/setRequestHandler\s*\(\s*[^,]+,\s*async[^)]*resources/i)
  })

  it('fail-closed when formatError throws (A1)', async () => {
    vi.spyOn(format, 'formatError').mockImplementation(() => {
      throw new Error('format exploded')
    })
    const r = await guardToolCall('x', () => {
      throw new Error(`URL: https://x/v2/${SECRET}`)
    })
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toContain('[tool error withheld: safe formatting failed]')
    expect(JSON.stringify(r)).not.toContain(SECRET)
  })

  it('drops structuredContent, _meta and non-text content blocks', () => {
    const r = redactToolResult({
      content: [
        { type: 'text', text: JSON.stringify({ api_key: SECRET, note: 'ok' }) },
        { type: 'image', data: SECRET },
      ],
      structuredContent: { api_key: SECRET },
      _meta: { note: SECRET },
    })
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(r).not.toHaveProperty('structuredContent')
    expect(r).not.toHaveProperty('_meta')
    expect(r.content).toHaveLength(1)
    expect(r.content[0]!.type).toBe('text')
    expect(r.content[0]!.text).toContain('[redacted]')
    expect(r.content[0]!.text).not.toContain(SECRET)
  })

  it('masks api_key secrets in text JSON (field dropped from structuredContent)', () => {
    const r = redactToolResult({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ api_key: SECRET, nested: { client_secret: SECRET } }),
        },
      ],
      structuredContent: { api_key: SECRET, nested: { client_secret: SECRET } },
    })
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(r).not.toHaveProperty('structuredContent')
    expect(r.content[0]!.text).toContain('[redacted]')
  })

  it('redacts secrets returned from toJSON inside text content', () => {
    const boxed = {
      toJSON() {
        return { api_key: SECRET, ok: true }
      },
    }
    const r = redactToolResult({
      content: [{ type: 'text', text: JSON.stringify(boxed) }],
    })
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(r.content[0]!.text).toContain('[redacted]')
    expect(r.content[0]!.text).toContain('"ok":true')
  })

  it('withholds circular tool results (CallToolResult schema)', () => {
    const ring: Record<string, unknown> = { content: [{ type: 'text', text: 'ok' }] }
    ring.self = ring
    const r = redactToolResult(ring)
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toBe(REDACTION_GUARD_ERROR_TEXT)
    expectValidCallToolResult(r)
  })

  it('withholds when a text block getter throws (CallToolResult schema)', async () => {
    const block = { type: 'text' as const }
    Object.defineProperty(block, 'text', {
      enumerable: true,
      get() {
        throw new Error(`URL: https://x/v2/${SECRET}`)
      },
    })
    const r = await guardToolCall('x', async () => ({ content: [block] }))
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toBe(REDACTION_GUARD_ERROR_TEXT)
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expectValidCallToolResult(r)
  })

  it('withholds when a single text block exceeds 4 MiB (CallToolResult schema)', () => {
    const big = 'x'.repeat(TEXT_OUTPUT_MAX + 1)
    const r = redactToolResult({ content: [{ type: 'text', text: big }] })
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toBe(REDACTION_GUARD_ERROR_TEXT)
    expectValidCallToolResult(r)
  })

  it('redacts structuredContent URIs only in text (resource block dropped)', () => {
    const r = redactToolResult({
      content: [{ type: 'text', text: `ok` }],
      structuredContent: { note: `URL: https://x/v2/${SECRET}` },
      resource: { uri: 'x', mimeType: 'text/plain', text: `Bearer ${SECRET}bearer` },
    })
    expect(r).not.toHaveProperty('structuredContent')
    expect(r).not.toHaveProperty('resource')
    expect(r.content).toHaveLength(1)
    expect(r.content[0]!.text).toBe('ok')
  })

  it('a throwing tool returns a redacted tool error, never the secret', async () => {
    const r = await guardToolCall('pay_x402', () => {
      throw new Error(`URL: https://x/v2/${SECRET}`)
    })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(r.content[0]!.text).toContain('URL: [redacted]')
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
    await expect(guardRequest(() => {
      throw evil
    })).rejects.toThrow(REQUEST_ERROR_WITHHELD)
    const err = await guardRequest(() => {
      throw evil
    }).catch((e: Error) => e)
    expect(err.message).toBe(REQUEST_ERROR_WITHHELD)
    expect(JSON.stringify(err)).not.toContain(SECRET)
  })

  it('list-handler errors carry no secret in the JSON-RPC message', async () => {
    await expect(guardRequest(() => {
      throw new Error(`URL: https://x/v2/${SECRET}`)
    })).rejects.toThrow(/URL: \[redacted\]/)
    const err = await guardRequest(() => {
      throw new Error(`URL: https://x/v2/${SECRET}`)
    }).catch((e: Error) => e)
    expect(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: (err as Error).message } })).not.toContain(
      SECRET
    )
  })

  it('index.ts wraps both handlers and awaits every tool handler', () => {
    const src = readFileSync(join(ROOT, 'src/index.ts'), 'utf8')
    expect(src).toMatch(/ListToolsRequestSchema,\s*async \(\) =>\s*guardRequest\(/)
    expect(src).toMatch(/CallToolRequestSchema,[^\n]*\n[\s\S]{0,200}guardToolCall\(request\.params\?\.name, \(\) => routeToolCall\(request\)\)/)
    expect(src).not.toMatch(/return handle[A-Z]/)
    expect((src.match(/return await handle[A-Z]/g) ?? []).length).toBeGreaterThanOrEqual(28)
  })
})