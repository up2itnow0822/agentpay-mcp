/**
 * State-directory ownership on filesystems without hard links (some FUSE /
 * SMB mounts): the atomic link step fails with EPERM/ENOTSUP, and the lock
 * falls back to an exclusive create — still one owner, never a hard failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    linkSync: () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    },
  }
})

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SPEND_STATE_LOCK_FILE,
  STATE_DIR_ENV,
  SpendStateDirBusyError,
  _resetSpendIntentStore,
  withSpendIntent,
} from '../src/utils/spend-intent.js'

let stateDir: string
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'agentpay-nolink-'))
  process.env[STATE_DIR_ENV] = stateDir
  _resetSpendIntentStore()
})
afterEach(() => {
  delete process.env[STATE_DIR_ENV]
  _resetSpendIntentStore()
})

describe('state-directory lock without hard links', () => {
  it('acquires by exclusive create, still refuses a live owner, and releases', async () => {
    const lock = join(stateDir, SPEND_STATE_LOCK_FILE)
    await expect(withSpendIntent('send_token:a', async () => 'x')).resolves.toEqual({ value: 'x', replayed: false })
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid)
    _resetSpendIntentStore()
    expect(existsSync(lock)).toBe(false)

    writeFileSync(lock, JSON.stringify({ pid: process.ppid, host: hostname(), nonce: 'other', at: Date.now() }))
    await expect(withSpendIntent('send_token:b', async () => 'y')).rejects.toBeInstanceOf(SpendStateDirBusyError)
  })
})
