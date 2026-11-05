import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exampleError, exampleLog, exampleSafeText } from '../examples/value-packs/shared/redact.js'
import { printError, printInfo } from '../examples/value-packs/shared/ui.js'

// Fake values only (S7).
const FAKE_RPC = 'https://base-mainnet.example-rpc.test/v2/FAKEfakeFAKE0123456789abcd'
const FAKE_KEY = '0x' + '1f'.repeat(32)

function region(path: string): string {
  const src = readFileSync(new URL(path, import.meta.url), 'utf8')
  const a = src.indexOf('// BEGIN redact-core')
  const b = src.indexOf('// END redact-core')
  expect(a).toBeGreaterThan(-1)
  expect(b).toBeGreaterThan(a)
  return src.slice(a, b)
}

describe('examples redaction copy', () => {
  afterEach(() => vi.restoreAllMocks())

  it('the vendored redact-core region is byte-identical to src/utils/sink.ts', () => {
    expect(region('../examples/value-packs/shared/redact.ts')).toBe(region('../src/utils/sink.ts'))
  })

  it('exampleSafeText masks an RPC key path and a private key', () => {
    const out = exampleSafeText(`rpc ${FAKE_RPC} key ${FAKE_KEY}`)
    expect(out).not.toContain('FAKEfakeFAKE0123456789abcd')
    expect(out).not.toContain('1f'.repeat(32))
  })

  it('printError and printInfo write redacted text', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    printError(`failed: ${FAKE_RPC}`)
    printInfo('Key', FAKE_KEY)
    const written = out.mock.calls.map((c) => String(c[0])).join('')
    expect(written).toContain('failed:')
    expect(written).not.toContain('FAKEfakeFAKE0123456789abcd')
    expect(written).not.toContain('1f'.repeat(32))
  })

  it('exampleLog/exampleError format args like console and redact', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    exampleLog('Payment #1:', { url: FAKE_RPC })
    exampleError('boom', FAKE_KEY)
    expect(String(out.mock.calls[0][0])).toContain('Payment #1:')
    expect(String(out.mock.calls[0][0])).not.toContain('FAKEfakeFAKE0123456789abcd')
    expect(String(err.mock.calls[0][0])).not.toContain('1f'.repeat(32))
  })
})
