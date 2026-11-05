import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetStdioProtocolModeForTests, enterStdioProtocolMode, isStdioProtocolMode, logErr, logOut } from '../src/utils/sink.js'

// S6: once the MCP stdio transport owns stdout, logOut must never write there.
describe('S6: logOut is unreachable on stdout in MCP stdio mode', () => {
  afterEach(() => {
    _resetStdioProtocolModeForTests()
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
    vi.spyOn(console, 'error').mockImplementation(() => {})
    logErr('x')
    expect(out).not.toHaveBeenCalled()
  })

  it('main() enters stdio mode before server.connect, and nothing in index.ts writes stdout directly', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const main = src.slice(src.indexOf('async function main('))
    const enter = main.indexOf('enterStdioProtocolMode()')
    const connect = main.indexOf('server.connect(')
    expect(enter).toBeGreaterThan(-1)
    expect(enter).toBeLessThan(connect)
    expect(src).not.toMatch(/process\.stdout|console\./)
  })
})
