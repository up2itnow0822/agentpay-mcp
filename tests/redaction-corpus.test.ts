/**
 * Table-driven redaction regression corpus (327 rows × 6 output paths).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardRequest, guardToolCall } from '../src/utils/tool-guard.js'
import {
  _resetStdioConsoleSinkForTests,
  _resetStdioProtocolModeForTests,
  enterStdioProtocolMode,
  installStdioConsoleSink,
  logErr,
  logOut,
  safeErrorText,
  safeText,
  toolText,
} from '../src/utils/sink.js'
import * as sinkModule from '../src/utils/sink.js'
import * as sinkSensitive from '../src/utils/sink-sensitive-text.js'

type CorpusRow = {
  id: string
  source_receipt: string
  input: string
  kind: 'secret_absent' | 'benign_intact'
  needle: string
  note?: string
  log_overredaction_ok?: boolean
}

const corpus: CorpusRow[] = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/redaction-corpus.json'), 'utf8')
)

const OUTPUT_PATHS = [
  'tool_text',
  'error_text',
  'list_tools_error',
  'stderr',
  'cli',
  'console_shim',
] as const

type OutputPath = (typeof OUTPUT_PATHS)[number]

function assertSecretAbsent(out: string, needle: string, row: CorpusRow, path: OutputPath): void {
  expect(out, `${row.id} ${path}: ${row.note ?? ''}`).not.toContain(needle)
}

function assertBenignPresent(out: string, needle: string, row: CorpusRow, path: OutputPath): void {
  if (path === 'stderr' || path === 'cli' || path === 'console_shim') {
    if (row.log_overredaction_ok && !out.includes(needle)) {
      // eslint-disable-next-line no-console
      console.info(`[corpus over-redaction ok] ${row.id} ${path}: ${row.note ?? ''}`)
      return
    }
  }
  expect(out, `${row.id} ${path}: ${row.note ?? ''}`).toContain(needle)
}

async function runToolText(input: string): Promise<string> {
  const r = await guardToolCall('corpus', () => ({ content: [toolText(input)] }))
  return r.content[0]!.text
}

async function runErrorText(input: string): Promise<string> {
  const direct = safeErrorText(input)
  const r = await guardToolCall('corpus', () => {
    throw new Error(input)
  })
  const toolErr = r.content[0]!.text
  return `${direct}\n${toolErr}`
}

async function runListToolsError(input: string): Promise<string> {
  try {
    await guardRequest(() => {
      throw new Error(input)
    })
    return ''
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

function runStderr(input: string): string {
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  logErr(input)
  const written = err.mock.calls.map((c) => String(c[0])).join('')
  err.mockRestore()
  return written
}

function runCli(input: string): string {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  logOut(input)
  const written =
    out.mock.calls.map((c) => String(c[0])).join('') + err.mock.calls.map((c) => String(c[0])).join('')
  out.mockRestore()
  err.mockRestore()
  return written
}

function runConsoleShim(input: string): string {
  installStdioConsoleSink()
  enterStdioProtocolMode()
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  console.info(input)
  const written = err.mock.calls.map((c) => String(c[0])).join('')
  err.mockRestore()
  return written
}

async function runPath(path: OutputPath, input: string): Promise<string> {
  switch (path) {
    case 'tool_text':
      return runToolText(input)
    case 'error_text':
      return runErrorText(input)
    case 'list_tools_error':
      return runListToolsError(input)
    case 'stderr':
      return runStderr(input)
    case 'cli':
      return runCli(input)
    case 'console_shim':
      return runConsoleShim(input)
    default: {
      const _exhaust: never = path
      return _exhaust
    }
  }
}

const table = corpus.flatMap((row) =>
  OUTPUT_PATHS.map((path) => ({ row, path, name: `${row.id} ${path}` as const }))
)

describe('redaction corpus', () => {
  afterEach(() => {
    _resetStdioConsoleSinkForTests()
    _resetStdioProtocolModeForTests()
    vi.restoreAllMocks()
  })

  it.each(table)('$name', async ({ row, path }) => {
    const out = await runPath(path, row.input)
    if (row.kind === 'secret_absent') {
      assertSecretAbsent(out, row.needle, row, path)
    } else {
      assertBenignPresent(out, row.needle, row, path)
    }
  })
})

describe('F13 safeText family identity', () => {
  afterEach(() => vi.restoreAllMocks())

  it('stderr logErr and console shim both invoke the same exported safeText-family sink', () => {
    const spy = vi.spyOn(sinkModule.REDACTION_LOG_ENTRY, 'redact')
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      logErr('probe-token-abc')
      _resetStdioConsoleSinkForTests()
      installStdioConsoleSink()
      enterStdioProtocolMode()
      console.info('probe-token-xyz')
    } finally {
      err.mockRestore()
      out.mockRestore()
      _resetStdioConsoleSinkForTests()
      _resetStdioProtocolModeForTests()
    }
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('stdio console shim reentrancy', () => {
  afterEach(() => {
    _resetStdioConsoleSinkForTests()
    _resetStdioProtocolModeForTests()
    vi.restoreAllMocks()
  })

  it('does not recurse or hang when console runs during redaction', async () => {
    installStdioConsoleSink()
    enterStdioProtocolMode()
    const original = sinkModule.safeText
    vi.spyOn(sinkModule, 'safeText').mockImplementation((text: string) => {
      console.info('nested-during-redact')
      return original(text)
    })
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const t = Date.now()
    console.info('outer-line-secret-q7q')
    expect(Date.now() - t).toBeLessThan(5000)
    err.mockRestore()
    vi.restoreAllMocks()
  })
})

describe('log path fail-closed', () => {
  const RAW = 'RAW_SECRET_LINE_q7q'

  afterEach(() => {
    _resetStdioConsoleSinkForTests()
    _resetStdioProtocolModeForTests()
    vi.restoreAllMocks()
  })

  it('stderr writes exactly [log withheld by redaction guard] when redaction throws', () => {
    vi.spyOn(sinkSensitive, 'maskSensitiveTextFields').mockImplementation(() => {
      throw new Error('redact blew up')
    })
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    logErr(RAW)
    const written = err.mock.calls.map((c) => String(c[0])).join('')
    expect(written).toBe(`${sinkModule.LOG_REDACTION_WITHHELD}\n`)
    expect(written).not.toContain(RAW)
    err.mockRestore()
  })

  it('console shim writes exactly [log withheld by redaction guard] when redaction throws', () => {
    installStdioConsoleSink()
    enterStdioProtocolMode()
    vi.spyOn(sinkSensitive, 'maskSensitiveTextFields').mockImplementation(() => {
      throw new Error('redact blew up')
    })
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    console.info(RAW)
    const written = err.mock.calls.map((c) => String(c[0])).join('')
    expect(written).toBe(`${sinkModule.LOG_REDACTION_WITHHELD}\n`)
    expect(written).not.toContain(RAW)
    err.mockRestore()
  })
})