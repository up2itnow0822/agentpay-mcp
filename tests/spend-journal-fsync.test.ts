/**
 * Codex P1: a journal file fsync failure must abort the spend before any
 * wallet callback runs (only directory fsync is best-effort).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fsyncFails = vi.hoisted(() => ({ on: false }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const fsyncSync = (fd: number) => {
    if (fsyncFails.on) {
      throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' })
    }
    return actual.fsyncSync(fd)
  }
  return { ...actual, fsyncSync, default: { ...actual, fsyncSync } }
})

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STATE_DIR_ENV, _resetSpendIntentStore, withSpendIntent } from '../src/utils/spend-intent.js'

describe('journal fsync failures', () => {
  beforeEach(() => {
    process.env[STATE_DIR_ENV] = mkdtempSync(join(tmpdir(), 'agentpay-fsync-'))
    _resetSpendIntentStore()
  })
  afterEach(() => {
    fsyncFails.on = false
    delete process.env[STATE_DIR_ENV]
    _resetSpendIntentStore()
  })

  it('aborts before the spend callback when the begin record cannot be made durable', async () => {
    fsyncFails.on = true
    const run = vi.fn()
    await expect(withSpendIntent('fsync#fail', run)).rejects.toThrow(/EIO/)
    expect(run).not.toHaveBeenCalled()
  })

  it('proceeds normally when fsync works', async () => {
    await expect(withSpendIntent('fsync#ok', async () => 'done')).resolves.toEqual({
      value: 'done',
      replayed: false,
    })
  })
})
