import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetStdioConsoleSinkForTests,
  _resetStdioProtocolModeForTests,
  enterStdioProtocolMode,
  installStdioConsoleSink,
  isStdioProtocolMode,
  logErr,
  logOut,
} from '../src/utils/sink.js'

// S6: once the MCP stdio transport owns stdout, logOut must never write there.
describe('S6: logOut is unreachable on stdout in MCP stdio mode', () => {
  afterEach(() => {
    _resetStdioProtocolModeForTests()
    _resetStdioConsoleSinkForTests()
    vi.restoreAllMocks()
  })

  it('diverts logOut to stderr after enterStdioProtocolMode()', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    enterStdioProtocolMode()
    expect(isStdioProtocolMode()).toBe(true)
    logOut('hello')
    expect(out).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith('hello\n')
  })

  it('writes to stdout before stdio mode (CLI help/version paths)', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    logOut('v1')
    expect(out).toHaveBeenCalledWith('v1\n')
  })

  it('logErr never touches stdout', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    logErr('x')
    expect(out).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledWith('x\n')
  })

  it('main() enters stdio mode before server.connect, and nothing in index.ts writes stdout directly', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const main = src.slice(src.indexOf('async function main('))
    const enter = main.indexOf('enterStdioProtocolMode()')
    const connect = main.indexOf('server.connect(')
    expect(enter).toBeGreaterThan(-1)
    expect(enter).toBeLessThan(connect)
    expect(src).toContain("import './console-bootstrap.js'")
    const tools = src.indexOf("// ─── Tool imports (v1.0.0)")
    const bootstrap = src.indexOf("import './console-bootstrap.js'")
    expect(bootstrap).toBeGreaterThan(-1)
    expect(bootstrap).toBeLessThan(tools)
    expect(src).not.toMatch(/process\.stdout|console\./)
  })

  it('SDK-style console.warn/info reach redacted stderr only in stdio mode', () => {
    const FAKE_RPC = 'https://base-mainnet.example-rpc.test/v2/FAKEfakeFAKE0123456789abcd'
    const FAKE_KEY = '0x' + '2e'.repeat(32)
    const prev = { ...process.env }
    process.env.RPC_URL = FAKE_RPC
    process.env.AGENT_PRIVATE_KEY = FAKE_KEY
    try {
      installStdioConsoleSink()
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      enterStdioProtocolMode()
      console.warn(`request failed\n\nURL: ${FAKE_RPC}`)
      console.info(`Wallet initialized with ${FAKE_KEY}`)
      expect(out).not.toHaveBeenCalled()
      expect(err.mock.calls.join('\n')).not.toContain(FAKE_RPC)
      expect(err.mock.calls.join('\n')).not.toContain(FAKE_KEY)
      expect(err.mock.calls.join('\n')).not.toContain(FAKE_KEY.slice(2))
      expect(err.mock.calls.join('\n')).toContain('[redacted]')
    } finally {
      process.env = prev
    }
  })
})
