/**
 * Operator reconciliation CLI for journaled spend-intent locks (F14).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSpendIntentsCli } from '../src/cli/spend-intents.js'
import {
  STATE_DIR_ENV,
  _resetSpendIntentStore,
  withSpendIntent,
  UnresolvedSpendIntentError,
} from '../src/utils/spend-intent.js'

describe('agentpay-mcp spend-intents', () => {
  beforeEach(() => {
    process.env[STATE_DIR_ENV] = mkdtempSync(join(tmpdir(), 'agentpay-cli-'))
    _resetSpendIntentStore()
  })
  afterEach(() => {
    delete process.env[STATE_DIR_ENV]
    _resetSpendIntentStore()
  })

  function run(args: string[]) {
    const out: string[] = []
    const err: string[] = []
    const code = runSpendIntentsCli(args, (l) => out.push(l), (l) => err.push(l))
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  it('refuses to run without a journal', () => {
    delete process.env[STATE_DIR_ENV]
    expect(run(['list']).code).toBe(2)
  })

  it('lists a lock that survived a restart and resolves it durably', async () => {
    await expect(
      withSpendIntent('send_payment:8453:0x0:0xabc:1', async () => {
        throw new Error('receipt timeout')
      })
    ).rejects.toThrow()
    _resetSpendIntentStore() // the server process is gone; the journal remains

    const listed = run(['list'])
    expect(listed.code).toBe(0)
    expect(listed.out).toContain('send_payment:8453:0x0:0xabc:1')

    expect(run(['resolve', 'send_payment:8453:0x0:0xabc:1', 'unsettled']).code).toBe(0)
    expect(run(['resolve', 'nope', 'unsettled']).code).toBe(1)

    _resetSpendIntentStore() // next server start
    expect(run(['list']).out).toContain('No locked spend intents')
    await expect(
      withSpendIntent('send_payment:8453:0x0:0xabc:1', async () => 'ok')
    ).resolves.toEqual({ value: 'ok', replayed: false })
  })

  it('a lock is still enforced if nobody reconciles it', async () => {
    await expect(
      withSpendIntent('k', async () => {
        throw new Error('receipt timeout')
      })
    ).rejects.toThrow()
    _resetSpendIntentStore()
    await expect(withSpendIntent('k', async () => 'x')).rejects.toBeInstanceOf(
      UnresolvedSpendIntentError
    )
  })
})
