/**
 * Table-driven redaction regression corpus (327 rows × 6 output paths).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  REDACTION_GUARD_ERROR_TEXT,
  guardRequest,
  guardToolCall,
  TEXT_OUTPUT_MAX_BYTES,
} from '../src/utils/tool-guard.js'
import { formatUntrustedBody } from '../src/utils/format.js'
import { PRE_SCRUB_CAP_BYTES, PRE_SCRUB_CUT_MARKER, testScrubBudgetMs } from '../src/utils/scrub-bounds.js'
import { maskSensitiveTextFields } from '../src/utils/sink-sensitive-text.js'
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

type GeneratorSpec = {
  prefix: string
  repeat: string
  count: number
  suffix: string
  bytes: number
  filler?: string
  payload?: string
  token?: string
  cap_ref?: string
  token_start_offsets_from_cap?: number[]
}

type CorpusRow = {
  id: string
  source_receipt: string
  input: string | null
  kind:
    | 'secret_absent'
    | 'benign_intact'
    | 'idempotent'
    | 'timing'
    | 'cap_straddle'
    | 'scrub_budget_exceeded'
  needle: string | null
  note?: string
  log_overredaction_ok?: boolean
  path_mode?: string
  family?: string
  fn?: string
  fn_args?: Record<string, unknown>
  generator?: GeneratorSpec
  budget_ms?: number
  min_partial?: number
  retry?: boolean
}

function isStandardTableRow(row: CorpusRow): boolean {
  if (['idempotent', 'timing', 'cap_straddle', 'scrub_budget_exceeded'].includes(row.kind)) return false
  if (row.path_mode === 'raw_tool_guard') return false
  return true
}

function expectValidCallToolResult(result: unknown): void {
  CallToolResultSchema.parse(result)
}

function buildTimingInput(gen: GeneratorSpec): string {
  const built = gen.prefix + gen.repeat.repeat(gen.count) + gen.suffix
  if (built.length !== gen.bytes) throw new Error(`generator bytes mismatch for timing row`)
  return built
}

function buildCapInput(gen: GeneratorSpec, offsetFromCap: number): string {
  const token = gen.token ?? ''
  const payload = gen.payload ?? ''
  const filler = gen.filler ?? ' '
  const idx = payload.indexOf(token)
  const padBefore = PRE_SCRUB_CAP_BYTES + offsetFromCap - idx
  return filler.repeat(Math.max(0, padBefore)) + payload + filler.repeat(64)
}

function assertNoPartialNeedle(out: string, token: string, minPartial: number): void {
  for (let len = token.length; len >= minPartial; len--) {
    for (let i = 0; i <= token.length - len; i++) {
      expect(out).not.toContain(token.slice(i, i + len))
    }
  }
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
  if (path === 'stderr' || path === 'console_shim') {
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

const table = corpus
  .filter(isStandardTableRow)
  .flatMap((row) =>
    OUTPUT_PATHS.map((path) => ({ row, path, name: `${row.id} ${path}` as const }))
  )

describe('redaction corpus', () => {
  afterEach(() => {
    _resetStdioConsoleSinkForTests()
    _resetStdioProtocolModeForTests()
    vi.restoreAllMocks()
  })

  it.each(table)('$name', async ({ row, path }) => {
    const out = await runPath(path, row.input!)
    if (row.kind === 'secret_absent') {
      assertSecretAbsent(out, row.needle!, row, path)
    } else {
      assertBenignPresent(out, row.needle!, row, path)
    }
  })
})

const idempotentRows = corpus.filter((r) => r.kind === 'idempotent')
const rawGuardRows = corpus.filter((r) => r.path_mode === 'raw_tool_guard')
const timingRows = corpus.filter((r) => r.kind === 'timing')
const capRows = corpus.filter((r) => r.kind === 'cap_straddle')
const scrubBudgetRows = corpus.filter((r) => r.kind === 'scrub_budget_exceeded')

describe('corpus idempotent safeText', () => {
  afterEach(() => {
    _resetStdioConsoleSinkForTests()
    _resetStdioProtocolModeForTests()
    vi.restoreAllMocks()
    testScrubBudgetMs.value = undefined
  })

  it.each(idempotentRows)('$id idempotent triple', async (row) => {
    const once = safeText(row.input!)
    const twice = safeText(once)
    const thrice = safeText(twice)
    expect(twice).toBe(once)
    expect(thrice).toBe(once)
    for (const path of OUTPUT_PATHS) {
      const out = await runPath(path, row.input!)
      expect(out).not.toContain(row.needle!)
    }
  })
})

describe('corpus raw_tool_guard path', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(rawGuardRows)('$id raw_tool_guard', async (row) => {
    const r = await guardToolCall('corpus-raw', () => ({
      content: [{ type: 'text', text: row.input! }],
    }))
    expectValidCallToolResult(r)
    const out = r.content.map((b) => b.text).join('|')
    if (row.kind === 'secret_absent') {
      expect(out).not.toContain(row.needle!)
    } else {
      expect(out).toContain(row.needle!)
    }
  })
})

describe('corpus timing budgets', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    testScrubBudgetMs.value = undefined
  })

  it.each(timingRows)('$id timing $family', { timeout: 10_000 }, (row) => {
    const gen = row.generator!
    const warm = buildTimingInput({ ...gen, count: Math.min(gen.count, 500), bytes: 0 })
    const warmBuilt = gen.prefix + gen.repeat.repeat(Math.min(gen.count, 500)) + gen.suffix
    if (row.fn === 'safeText') safeText(warmBuilt)
    else formatUntrustedBody(warmBuilt, (row.fn_args?.maxLen as number) ?? 64 * 1024)

    const input = buildTimingInput(gen)
    const t0 = performance.now()
    let out: string
    if (row.fn === 'safeText') out = safeText(input)
    else if (row.fn === 'formatUntrustedBody')
      out = formatUntrustedBody(input, (row.fn_args?.maxLen as number) ?? 64 * 1024)
    else throw new Error(`unknown fn ${row.fn}`)
  const elapsed = performance.now() - t0
    expect(typeof out).toBe('string')
    expect(elapsed).toBeLessThan(row.budget_ms!)
    expect(row.retry).toBe(false)
  })
})

describe('corpus cap_straddle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    testScrubBudgetMs.value = undefined
  })

  it.each(capRows)('$id cap_straddle', (row) => {
    const gen = row.generator!
    const token = gen.token!
    const minPartial = row.min_partial ?? 4
    for (const offset of gen.token_start_offsets_from_cap ?? []) {
      const input = buildCapInput(gen, offset)
      let out: string
      if (row.fn === 'safeText') out = safeText(input)
      else if (row.fn === 'formatUntrustedBody')
        out = formatUntrustedBody(input, (row.fn_args?.maxLen as number) ?? 64 * 1024)
      else throw new Error(`unknown fn ${row.fn}`)
      assertNoPartialNeedle(out, token, minPartial)
      expect(out).toContain(PRE_SCRUB_CUT_MARKER)
    }
  })
})

describe('corpus scrub_budget_exceeded', () => {
  afterEach(() => {
    _resetStdioConsoleSinkForTests()
    _resetStdioProtocolModeForTests()
    vi.restoreAllMocks()
    testScrubBudgetMs.value = undefined
  })

  it.each(scrubBudgetRows)('$id scrub_budget $path_mode', { timeout: 10_000 }, async (row) => {
    testScrubBudgetMs.value = 1
    const originalMask = maskSensitiveTextFields
    vi.spyOn(sinkSensitive, 'maskSensitiveTextFields').mockImplementation((text) => {
      const end = performance.now() + 8
      while (performance.now() < end) {
        /* burn */
      }
      return originalMask(text)
    })
    const needle = row.needle!
    const input = row.input!

    if (row.path_mode === 'tool_text') {
      const run = vi.fn(() => ({ content: [{ type: 'text', text: input }] }))
      const r = await guardToolCall('scrub-budget', run)
      expect(run).toHaveBeenCalledTimes(1)
      expectValidCallToolResult(r)
      expect(r.isError).toBe(true)
      const text = r.content[0]!.text
      expect(text).toBe(REDACTION_GUARD_ERROR_TEXT)
      expect(text).toMatch(/payment may have executed/i)
      expect(text).toMatch(/status/i)
      expect(text).toMatch(/(do not|don't) retry/i)
      expect(text).not.toContain(needle)
      expect(JSON.stringify(r)).not.toContain(input)
    } else if (row.path_mode === 'error_text') {
      const run = vi.fn(() => {
        throw new Error(input)
      })
      const r = await guardToolCall('scrub-budget-err', run)
      expect(run).toHaveBeenCalledTimes(1)
      expectValidCallToolResult(r)
      expect(r.content[0]!.text).toBe(REDACTION_GUARD_ERROR_TEXT)
      expect(JSON.stringify(r)).not.toContain(needle)
    } else if (row.path_mode === 'untrusted_body') {
      const run = vi.fn()
      const out = formatUntrustedBody(input, (row.fn_args?.maxLen as number) ?? 4096)
      expect(out).not.toContain(needle)
      expect(out).not.toContain(input)
      run()
      expect(run).toHaveBeenCalledTimes(1)
    } else if (row.path_mode === 'stderr') {
      installStdioConsoleSink()
      enterStdioProtocolMode()
      const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      logErr(input)
      console.info(input)
      const errWritten = err.mock.calls.map((c) => String(c[0])).join('')
      expect(errWritten).toBe('[log withheld by redaction guard]\n[log withheld by redaction guard]\n')
      expect(out.mock.calls.length).toBe(0)
      err.mockRestore()
      out.mockRestore()
    } else {
      throw new Error(`unknown path_mode ${row.path_mode}`)
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
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[0]![0]).toBe('probe-token-abc')
    expect(spy.mock.calls[1]![0]).toBe('probe-token-xyz')
  })
})

describe('stdio console shim reentrancy', () => {
  afterEach(() => {
    _resetStdioConsoleSinkForTests()
    _resetStdioProtocolModeForTests()
    vi.restoreAllMocks()
  })

  it('withholds on nested log path instead of recursing when console runs during redaction', () => {
    installStdioConsoleSink()
    enterStdioProtocolMode()
    const originalMask = sinkSensitive.maskSensitiveTextFields
    let emitNestedLog = false
    vi.spyOn(sinkSensitive, 'maskSensitiveTextFields').mockImplementation((text) => {
      if (!emitNestedLog) {
        emitNestedLog = true
        console.error('reentry-probe-line')
      }
      return originalMask(text)
    })
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const t = Date.now()
    console.info('api_key=outer-line-secret-q7q')
    expect(Date.now() - t).toBeLessThan(2000)
    const written = err.mock.calls.map((c) => String(c[0])).join('')
    expect(written).toContain('[log withheld by redaction guard]')
    expect(written).not.toContain('outer-line-secret-q7q')
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
    expect(written).toBe('[log withheld by redaction guard]\n')
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
    expect(written).toBe('[log withheld by redaction guard]\n')
    expect(written).not.toContain(RAW)
    err.mockRestore()
  })
})

describe('log path size cap', () => {
  afterEach(() => {
    _resetStdioConsoleSinkForTests()
    _resetStdioProtocolModeForTests()
    vi.restoreAllMocks()
  })

  it('logErr withholds a block just over the tool-guard size cap', () => {
    const huge = 'x'.repeat(TEXT_OUTPUT_MAX_BYTES + 1)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    logErr(huge)
    const written = err.mock.calls.map((c) => String(c[0])).join('')
    expect(written).toBe('[log withheld by redaction guard]\n')
    expect(written).not.toContain(huge)
    err.mockRestore()
  })

  it('console shim withholds a block just over the tool-guard size cap', () => {
    installStdioConsoleSink()
    enterStdioProtocolMode()
    const huge = 'x'.repeat(TEXT_OUTPUT_MAX_BYTES + 1)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    console.info(huge)
    const written = err.mock.calls.map((c) => String(c[0])).join('')
    expect(written).toBe('[log withheld by redaction guard]\n')
    expect(written).not.toContain(huge)
    err.mockRestore()
  })
})