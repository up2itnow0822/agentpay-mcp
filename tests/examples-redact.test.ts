import { afterEach, describe, expect, it, vi } from 'vitest'
import { exampleError, exampleLog, exampleSafeText } from '../examples/value-packs/shared/redact.js'
import { printError, printInfo } from '../examples/value-packs/shared/ui.js'
import { safeText } from '../src/utils/sink.js'

// Fake values only (S7).
const FAKE_RPC = 'https://base-mainnet.example-rpc.test/v2/FAKEfakeFAKE0123456789abcd'
const FAKE_KEY = '0x' + '1f'.repeat(32)

describe('examples redaction copy', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exampleSafeText is the same safeText function as src/utils/sink.ts', () => {
    const probe = 'password=zqProbe10 token=zqProbe11'
    expect(exampleSafeText(probe)).toBe(safeText(probe))
    expect(exampleSafeText(probe)).not.toContain('zqProbe10')
  })

  it('the examples copy masks 15/18/21-word mnemonics by shape', () => {
    for (const n of [12, 15, 18, 21, 24]) {
      expect(exampleSafeText(Array(n).fill('zoo').join(' '))).toBe('[redacted-mnemonic]')
    }
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
