/**
 * Codex review of PR #90 (head 71d7dc3), three findings on operator
 * reconciliation of locked spend intents:
 *
 * - P1: an operator who confirms a keyed intent SETTLED must retire its
 *   idempotency key for good; a retry with it is refused, never paid again.
 * - P2: intent keys are caller-influenced; they are escaped before they reach
 *   a terminal, and idempotency keys with control / invisible / line-separator
 *   characters are rejected at input.
 * - P1: one process owns a state directory at a time, so the CLI and a live
 *   server can never both append to (and compact) the same journal.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readlinkSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSpendIntentsCli } from '../src/cli/spend-intents.js'
import {
  IDEMPOTENCY_KEY_JSON_SCHEMA,
  IdempotencyKeyZodSchema,
  SPEND_STATE_LOCK_FILE,
  SPEND_STATE_LOCK_STALE_MS,
  STATE_DIR_ENV,
  SettledIntentTombstoneError,
  SpendIntentConflictError,
  SpendStateDirBusyError,
  UnresolvedSpendIntentError,
  _heartbeatSpendStateLockForTests,
  _resetSpendIntentStore,
  displaySpendIntentKey,
  listUnresolvedSpendIntents,
  resolveSpendIntent,
  spendIntentHandle,
  spendIntentKeyFromSelector,
  spendJournalPath,
  withSpendIntent,
} from '../src/utils/spend-intent.js'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

let stateDir: string
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'agentpay-reconcile-'))
  process.env[STATE_DIR_ENV] = stateDir
  _resetSpendIntentStore()
})
afterEach(() => {
  delete process.env[STATE_DIR_ENV]
  _resetSpendIntentStore()
})

function cli(args: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = runSpendIntentsCli(args, (l) => out.push(l), (l) => err.push(l))
  return { code, out, err }
}

async function lockIntent(key: string, options: { durable?: boolean; fingerprint?: string } = {}) {
  await expect(
    withSpendIntent(key, async () => {
      throw new Error('receipt timeout after broadcast')
    }, options)
  ).rejects.toThrow()
}

function lockPath() {
  return join(stateDir, SPEND_STATE_LOCK_FILE)
}

const LINUX = process.platform === 'linux'

/** What a process in THIS host / boot / PID namespace writes into its lock. */
function localScope(pid: number): Record<string, string> {
  if (!LINUX) return { host: hostname() }
  let start: string | undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
  } catch {
    // dead pid: no start time
  }
  return {
    host: hostname(),
    boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    pidns: readlinkSync('/proc/self/ns/pid'),
    ...(start ? { start } : {}),
  }
}

function writeForeignLock(holder: { pid: number } & Record<string, unknown>) {
  writeFileSync(
    lockPath(),
    JSON.stringify({ ...localScope(holder.pid), ...holder, nonce: 'foreign-nonce', at: Date.now() })
  )
}

function age(path: string, ms: number) {
  const old = new Date(Date.now() - ms)
  utimesSync(path, old, old)
}

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
  return Number(child.stdout.toString())
}

describe('settled vs unsettled reconciliation (Codex P1)', () => {
  it('requires an explicit outcome; a bare resolve changes nothing', async () => {
    await lockIntent('send_payment#invoice-7', { durable: true, fingerprint: 'fp-7' })
    _resetSpendIntentStore() // server stopped; operator runs the CLI
    for (const args of [['resolve', 'send_payment#invoice-7'], ['resolve', 'send_payment#invoice-7', 'done']]) {
      const result = cli(args)
      expect(result.code).toBe(2)
      expect(result.err.join('\n')).toMatch(/settled .*unsettled/)
    }
    expect(listUnresolvedSpendIntents().map((e) => e.key)).toEqual(['send_payment#invoice-7'])
    expect(() => resolveSpendIntent('send_payment#invoice-7', 'maybe' as never)).toThrow(TypeError)
  })

  it('settled retires a keyed intent: the same key is refused, in process and after restart', async () => {
    await lockIntent('send_payment#invoice-1', { durable: true, fingerprint: 'fp-1' })
    _resetSpendIntentStore()
    const listed = cli(['list'])
    expect(listed.out.join('\n')).toContain('send_payment#invoice-1  [idempotency key]')

    const resolved = cli(['resolve', 'send_payment#invoice-1', 'settled'])
    expect(resolved.code).toBe(0)
    expect(resolved.out.join('\n')).toMatch(/retired: a retry with it is refused, never paid again/)

    const pay = vi.fn(async () => '0xsecond')
    await expect(
      withSpendIntent('send_payment#invoice-1', pay, { durable: true, fingerprint: 'fp-1' })
    ).rejects.toBeInstanceOf(SettledIntentTombstoneError)
    await expect(
      withSpendIntent('send_payment#invoice-1', pay, { durable: true, fingerprint: 'fp-other' })
    ).rejects.toBeInstanceOf(SpendIntentConflictError)

    _resetSpendIntentStore() // the server restarts and replays the journal
    await expect(
      withSpendIntent('send_payment#invoice-1', pay, { durable: true, fingerprint: 'fp-1' })
    ).rejects.toBeInstanceOf(SettledIntentTombstoneError)
    expect(pay).not.toHaveBeenCalled()
  })

  it('unsettled frees a keyed intent: the retry pays exactly once', async () => {
    await lockIntent('send_payment#invoice-2', { durable: true, fingerprint: 'fp-2' })
    _resetSpendIntentStore()
    const resolved = cli(['resolve', 'send_payment#invoice-2', 'unsettled'])
    expect(resolved.code).toBe(0)
    expect(resolved.out.join('\n')).toMatch(/a retry may pay/)
    _resetSpendIntentStore()
    const pay = vi.fn(async () => '0xretry')
    await expect(
      withSpendIntent('send_payment#invoice-2', pay, { durable: true, fingerprint: 'fp-2' })
    ).resolves.toEqual({ value: '0xretry', replayed: false })
    await expect(
      withSpendIntent('send_payment#invoice-2', pay, { durable: true, fingerprint: 'fp-2' })
    ).resolves.toEqual({ value: '0xretry', replayed: true })
    expect(pay).toHaveBeenCalledTimes(1)
  })

  it('settled on a keyless intent clears the lock without retiring the payload forever', async () => {
    await lockIntent('send_payment:8453:0x0:0xabc:1')
    expect(resolveSpendIntent('send_payment:8453:0x0:0xabc:1', 'settled')).toEqual({
      key: 'send_payment:8453:0x0:0xabc:1',
      outcome: 'settled',
      keyRetired: false,
    })
    _resetSpendIntentStore()
    await expect(
      withSpendIntent('send_payment:8453:0x0:0xabc:1', async () => 'later-payment')
    ).resolves.toEqual({ value: 'later-payment', replayed: false })
  })

  it('a keyed lock journaled without the durable flag still retires its key when settled', async () => {
    // Journal written before the flag existed: fall back to the `tool#key` shape.
    writeFileSync(
      spendJournalPath()!,
      JSON.stringify({ v: 1, at: 1, op: 'lock', key: 'x402_pay#legacy', fp: 'fp-legacy' }) + '\n'
    )
    expect(resolveSpendIntent('x402_pay#legacy', 'settled')).toMatchObject({ keyRetired: true })
    _resetSpendIntentStore()
    await expect(
      withSpendIntent('x402_pay#legacy', async () => 'again', { durable: true, fingerprint: 'fp-legacy' })
    ).rejects.toBeInstanceOf(SettledIntentTombstoneError)
  })
})

describe('intent keys are escaped for operators and validated at input (Codex P2)', () => {
  const hostile = 'x402_pay#inv\u001b[2J\u001b]0;pwned\u0007\nRESOLVED all\r‮evil\u0085'

  it('list prints hostile keys escaped on one line, and resolve selects them by handle', async () => {
    await lockIntent(hostile, { durable: true, fingerprint: 'fp-h' })
    _resetSpendIntentStore()
    const listed = cli(['list'])
    expect(listed.code).toBe(0)
    const text = listed.out.join('\n')
    expect(listed.out).toHaveLength(1)
    // Nothing outside printable ASCII reaches the terminal.
    expect(text).toMatch(/^[\x20-\x7e]*$/)
    expect(text).toContain('\\u001b[2J')
    expect(text).toContain('\\u000a')
    expect(text).toContain(spendIntentHandle(hostile))
    expect(text).toContain(displaySpendIntentKey(hostile))

    // The printed key text is not a selector: it may not survive a shell.
    expect(cli(['resolve', displaySpendIntentKey(hostile), 'unsettled']).code).toBe(2)
    const resolved = cli(['resolve', spendIntentHandle(hostile), 'unsettled'])
    expect(resolved.code).toBe(0)
    expect(resolved.out.join('\n')).toMatch(/^[\x20-\x7e]*$/)
    expect(listUnresolvedSpendIntents()).toEqual([])
  })

  it('a decoy key whose text matches another key after shell quoting can never be selected by mistake', async () => {
    // Reviewer repro: the agent picks both keys. The escaped rendering of one,
    // pasted through a shell, must never select the other.
    const real = 'send_payment#inv-é'
    const decoy = 'send_payment#inv-\\u00e9'
    await lockIntent(real, { durable: true, fingerprint: 'fp-real' })
    await lockIntent(decoy, { durable: true, fingerprint: 'fp-decoy' })
    for (const key of [real, decoy]) {
      const shown = displaySpendIntentKey(key)
      const viaShell = spawnSync('sh', ['-c', `printf '%s' ${shown}`], { encoding: 'utf8' }).stdout
      expect(cli(['resolve', viaShell, 'unsettled']).code).toBe(2)
      expect(cli(['resolve', shown, 'unsettled']).code).toBe(2)
    }
    expect(listUnresolvedSpendIntents()).toHaveLength(2)
    expect(cli(['resolve', spendIntentHandle(real), 'settled']).code).toBe(0)
    expect(listUnresolvedSpendIntents().map((e) => e.key)).toEqual([decoy])
  })

  it('printed keys are inert when pasted into a shell', async () => {
    const marker = join(stateDir, 'PWNED')
    for (const key of [`x402_pay#a$(touch ${marker})`, 'x402_pay#a`touch x`', "x402_pay#it's", 'x402_pay#a;b|c&d']) {
      const shown = displaySpendIntentKey(key)
      expect(shown.startsWith("'") && shown.endsWith("'")).toBe(true)
      const echoed = spawnSync('sh', ['-c', `printf '%s' ${shown}`], { encoding: 'utf8' })
      expect(echoed.status).toBe(0)
      expect(echoed.stdout).toBe(shown.slice(1, -1)) // nothing expanded or executed
    }
    expect(existsSync(marker)).toBe(false)
  })

  it('selectors: id handles and shell-plain keys only', () => {
    const keys = ['send_payment#invoice-1', 'x402_pay#a b']
    expect(spendIntentKeyFromSelector('send_payment#invoice-1', keys)).toEqual({ key: 'send_payment#invoice-1' })
    expect(spendIntentKeyFromSelector(spendIntentHandle('x402_pay#a b'), keys)).toEqual({ key: 'x402_pay#a b' })
    expect(spendIntentKeyFromSelector('x402_pay#a b', keys)).toEqual({ error: 'not-plain' })
    expect(spendIntentKeyFromSelector('id:unknown', keys)).toEqual({ error: 'not-found' })
    expect(spendIntentHandle('a')).toMatch(/^id:[A-Za-z0-9_-]{22}$/)
    for (const plain of ['send_payment#invoice-1', 'x402_pay:abc', 'send_payment:8453:0x0:0xabc:1']) {
      expect(displaySpendIntentKey(plain)).toBe(plain)
    }
    const unknown = cli(['resolve', 'id:nope\u001b[31m', 'unsettled'])
    expect(unknown.code).toBe(1)
    expect(unknown.err.join('\n')).toMatch(/^[\x20-\x7e]*$/)
  })

  it('rejects idempotency keys with control, invisible, or line-separator characters', () => {
    const pattern = new RegExp(IDEMPOTENCY_KEY_JSON_SCHEMA.pattern)
    const patternU = new RegExp(IDEMPOTENCY_KEY_JSON_SCHEMA.pattern, 'u')
    const rejected = [
      'inv\u001b[2J',
      'line\nbreak',
      'tab\there',
      'nul\u0000',
      'del\u007f',
      'c1\u0085',
      'csi\u009b',
      'bidi‮',
      'iso⁦',
      'ls ',
      'zw​',
      'bom﻿',
      '   ',
      ' ',
    ]
    for (const key of rejected) {
      expect(IdempotencyKeyZodSchema.safeParse(key).success, JSON.stringify(key)).toBe(false)
      expect(pattern.test(key), JSON.stringify(key)).toBe(false)
      expect(patternU.test(key), JSON.stringify(key)).toBe(false)
    }
    expect(IdempotencyKeyZodSchema.safeParse('lone\ud800').success).toBe(false)
    const accepted = ['invoice-1', ' padded ', 'émoji 😀', '請求書-42', 'a b c', 'x'.repeat(128)]
    for (const key of accepted) {
      expect(IdempotencyKeyZodSchema.safeParse(key).success, JSON.stringify(key)).toBe(true)
      expect(pattern.test(key), JSON.stringify(key)).toBe(true)
      expect(patternU.test(key), JSON.stringify(key)).toBe(true)
    }
  })

  it('validates oversized adversarial keys in linear time', () => {
    const started = Date.now()
    for (const huge of [' '.repeat(2_000_000), 'a'.repeat(2_000_000) + '\u0000', ' '.repeat(2_000_000) + 'a\u0000']) {
      expect(IdempotencyKeyZodSchema.safeParse(huge).success).toBe(false)
      new RegExp(IDEMPOTENCY_KEY_JSON_SCHEMA.pattern).test(huge)
    }
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('one process owns a state directory (Codex P1)', () => {
  it('a live process on this host keeps ownership: no spend, no resolve, list is read-only', async () => {
    await lockIntent('x402_pay#held', { durable: true, fingerprint: 'fp-held' })
    _resetSpendIntentStore() // releases our lock
    writeForeignLock({ pid: process.ppid }) // the server is running

    const before = readFileSync(spendJournalPath()!, 'utf8')
    const pay = vi.fn(async () => '0xpaid')
    await expect(withSpendIntent('send_token:other', pay)).rejects.toBeInstanceOf(SpendStateDirBusyError)
    expect(pay).not.toHaveBeenCalled()

    const resolved = cli(['resolve', 'x402_pay#held', 'unsettled'])
    expect(resolved.code).toBe(1)
    expect(resolved.err.join('\n')).toContain(`owned by process ${process.ppid} on this host`)

    const listed = cli(['list'])
    expect(listed.code).toBe(0)
    expect(listed.out[0]).toMatch(/^Read-only snapshot\./)
    expect(listed.out.join('\n')).toContain('x402_pay#held  [idempotency key]')

    // Nothing was written behind the owner's back.
    expect(readFileSync(spendJournalPath()!, 'utf8')).toBe(before)
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).nonce).toBe('foreign-nonce')
  })

  it('takes over a lock whose holder on this host is dead, keeping every journaled lock', async () => {
    await lockIntent('x402_pay#crashed', { durable: true, fingerprint: 'fp-c' })
    _resetSpendIntentStore()
    writeForeignLock({ pid: deadPid() }) // the previous server crashed

    expect(listUnresolvedSpendIntents().map((e) => e.key)).toEqual(['x402_pay#crashed'])
    const lock = JSON.parse(readFileSync(lockPath(), 'utf8'))
    expect(lock.pid).toBe(process.pid)
    await expect(
      withSpendIntent('x402_pay#crashed', async () => 'again', { durable: true, fingerprint: 'fp-c' })
    ).rejects.toBeInstanceOf(UnresolvedSpendIntentError)
  })

  it('a lock from another host is honoured while its heartbeat is fresh, then presumed abandoned', async () => {
    writeForeignLock({ pid: 4242, host: 'other-host.example' })
    await expect(withSpendIntent('send_token:a', async () => 'x')).rejects.toThrow(
      /owned by process 4242 on host "other-host.example"/
    )
    age(lockPath(), SPEND_STATE_LOCK_STALE_MS + 5000)
    await expect(withSpendIntent('send_token:a', async () => 'x')).resolves.toEqual({
      value: 'x',
      replayed: false,
    })
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).host).toBe(hostname())
  })

  it('an unreadable lock fails closed until it has been abandoned', async () => {
    writeFileSync(lockPath(), '{torn')
    await expect(withSpendIntent('send_token:b', async () => 'x')).rejects.toThrow(/unreadable/)
    age(lockPath(), SPEND_STATE_LOCK_STALE_MS + 5000)
    await expect(withSpendIntent('send_token:b', async () => 'x')).resolves.toBeTruthy()
  })

  it.skipIf(!LINUX)('pid liveness is trusted only inside the same PID namespace (reviewer repro)', async () => {
    // Same hostname, another PID namespace (a sidecar or `docker compose run`
    // container on the shared volume). Its pid means nothing here — even one
    // that is dead in OUR namespace, or equal to ours — so only its heartbeat
    // counts.
    for (const pid of [deadPid(), process.pid]) {
      writeForeignLock({ pid, pidns: 'pid:[1]', start: '1' })
      const pay = vi.fn(async () => 'x')
      await expect(withSpendIntent('send_token:ns', pay)).rejects.toThrow(
        `owned by process ${pid} in another PID namespace on host ${JSON.stringify(hostname())}`
      )
      expect(pay).not.toHaveBeenCalled()
      expect(cli(['resolve', 'send_token:ns', 'unsettled']).code).toBe(1)
      expect(cli(['list']).out[0]).toMatch(/^Read-only snapshot\./)
      expect(JSON.parse(readFileSync(lockPath(), 'utf8')).nonce).toBe('foreign-nonce')
    }
    age(lockPath(), SPEND_STATE_LOCK_STALE_MS + 5000)
    await expect(withSpendIntent('send_token:ns', async () => 'x')).resolves.toBeTruthy()
  })

  it.skipIf(!LINUX)('a reused pid (same pid, different start time) does not keep a dead owner alive', async () => {
    writeForeignLock({ pid: process.ppid, start: '1' }) // ppid is alive, but it is not the lock's process
    await expect(withSpendIntent('send_token:reuse', async () => 'x')).resolves.toBeTruthy()
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid)
  })

  it('the heartbeat refreshes only this process\'s own lock, through its own descriptor', async () => {
    await expect(withSpendIntent('send_token:hb', async () => 'x')).resolves.toBeTruthy()
    const content = readFileSync(lockPath(), 'utf8')
    age(lockPath(), 60_000)
    const before = statSync(lockPath()).mtimeMs
    _heartbeatSpendStateLockForTests()
    expect(statSync(lockPath()).mtimeMs).toBeGreaterThan(before + 30_000)
    expect(readFileSync(lockPath(), 'utf8')).toBe(content)

    // Another process now holds the lock: the heartbeat must not keep it fresh.
    writeForeignLock({ pid: 4242, host: 'other-host.example' })
    age(lockPath(), SPEND_STATE_LOCK_STALE_MS + 5000)
    const foreign = statSync(lockPath()).mtimeMs
    _heartbeatSpendStateLockForTests()
    expect(statSync(lockPath()).mtimeMs).toBe(foreign)
    await expect(withSpendIntent('send_token:hb2', async () => 'y')).rejects.toThrow(/lost ownership/)
  })

  it('takeovers are serialised: a live takeover blocks, an abandoned one is cleared', async () => {
    writeForeignLock({ pid: deadPid() })
    const mutex = lockPath() + '.takeover'
    writeFileSync(mutex, '') // another process is mid-takeover right now
    const started = Date.now()
    await expect(withSpendIntent('send_token:t', async () => 'x')).rejects.toThrow(/contending/)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).nonce).toBe('foreign-nonce')

    age(mutex, 60_000) // that takeover crashed long ago
    await expect(withSpendIntent('send_token:t', async () => 'x')).resolves.toBeTruthy()
    expect(existsSync(mutex)).toBe(false)
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid)
  })

  it('a process that loses ownership stops writing for good', async () => {
    await expect(withSpendIntent('send_token:c', async () => 'x')).resolves.toBeTruthy()
    const journalBefore = readFileSync(spendJournalPath()!, 'utf8')
    writeForeignLock({ pid: process.ppid }) // another process took the directory over

    const pay = vi.fn(async () => 'y')
    await expect(withSpendIntent('send_token:d', pay)).rejects.toThrow(/lost ownership/)
    writeFileSync(lockPath(), '') // even if that owner goes away, stay stopped until restart
    await expect(withSpendIntent('send_token:e', pay)).rejects.toThrow(/lost ownership/)
    expect(pay).not.toHaveBeenCalled()
    expect(readFileSync(spendJournalPath()!, 'utf8')).toBe(journalBefore)
  })

  it('releases the lock when the owner stops', async () => {
    await expect(withSpendIntent('send_token:f', async () => 'x')).resolves.toBeTruthy()
    expect(existsSync(lockPath())).toBe(true)
    _resetSpendIntentStore()
    expect(existsSync(lockPath())).toBe(false)
  })

})

describe.sequential('state-directory ownership across real OS processes', () => {
  // The operator CLI and the spend-intent module, compiled and run in child
  // processes exactly as an operator would run them next to a live server.
  let runner: string
  beforeAll(() => {
    const build = mkdtempSync(join(tmpdir(), 'agentpay-cli-build-'))
    symlinkSync(join(projectRoot, 'node_modules'), join(build, 'node_modules'), 'dir')
    execFileSync(
      process.execPath,
      [
        join(projectRoot, 'node_modules/typescript/bin/tsc'),
        join(projectRoot, 'src/cli/spend-intents.ts'),
        '--outDir', build, '--rootDir', join(projectRoot, 'src'),
        '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022',
        '--strict', '--esModuleInterop', '--skipLibCheck', '--resolveJsonModule',
      ],
      { cwd: projectRoot, stdio: 'pipe' }
    )
    runner = join(build, 'run.cjs')
    writeFileSync(
      runner,
      [
        "const { runSpendIntentsCli } = require('./cli/spend-intents.js')",
        "const { ensureJournalLoaded } = require('./utils/spend-intent.js')",
        "if (process.argv[2] === 'hold') {",
        '  ensureJournalLoaded()',
        "  process.stdout.write('ready\\n')",
        '  setInterval(() => {}, 1000)',
        '} else {',
        '  process.exit(runSpendIntentsCli(process.argv.slice(2)))',
        '}',
      ].join('\n')
    )
  }, 120_000)

  function child(args: string[]) {
    return spawnSync(process.execPath, [runner, ...args], {
      env: { ...process.env, [STATE_DIR_ENV]: stateDir },
      encoding: 'utf8',
    })
  }

  it('the CLI is refused while the server owns the directory, and works once it stops', async () => {
    await lockIntent('x402_pay#held', { durable: true, fingerprint: 'fp-held' }) // the "server" (this process) owns it
    const journalBefore = readFileSync(spendJournalPath()!, 'utf8')

    const refused = child(['resolve', 'x402_pay#held', 'unsettled'])
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain(`owned by process ${process.pid} on this host`)
    const snapshot = child(['list'])
    expect(snapshot.status).toBe(0)
    expect(snapshot.stdout).toMatch(/^Read-only snapshot\./)
    expect(snapshot.stdout).toContain('x402_pay#held  [idempotency key]')
    expect(readFileSync(spendJournalPath()!, 'utf8')).toBe(journalBefore)

    _resetSpendIntentStore() // the server stops and releases the directory
    const resolved = child(['resolve', 'x402_pay#held', 'unsettled'])
    expect(resolved.status).toBe(0)
    expect(resolved.stdout).toContain('Resolved as unsettled: x402_pay#held')
    expect(existsSync(lockPath())).toBe(false) // released on exit

    // The restarted server honours the resolution.
    await expect(
      withSpendIntent('x402_pay#held', async () => 'paid', { durable: true, fingerprint: 'fp-held' })
    ).resolves.toEqual({ value: 'paid', replayed: false })
  })

  it('a live child owner blocks this process; once it is killed, its lock is taken over', async () => {
    const owner = spawn(process.execPath, [runner, 'hold'], {
      env: { ...process.env, [STATE_DIR_ENV]: stateDir },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    await new Promise<void>((resolve, reject) => {
      owner.stdout!.on('data', (chunk: Buffer) => chunk.toString().includes('ready') && resolve())
      owner.once('exit', (code) => reject(new Error(`owner exited early (${code})`)))
    })
    try {
      const pay = vi.fn(async () => '0xpaid')
      await expect(withSpendIntent('send_token:z', pay)).rejects.toThrow(`owned by process ${owner.pid} on this host`)
      expect(pay).not.toHaveBeenCalled()
    } finally {
      const exited = new Promise((resolve) => owner.once('exit', resolve))
      owner.kill('SIGKILL') // a crash: no exit hook runs, the lock file stays
      await exited
    }
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(owner.pid)
    await expect(withSpendIntent('send_token:z', async () => '0xpaid')).resolves.toEqual({
      value: '0xpaid',
      replayed: false,
    })
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).pid).toBe(process.pid)
  })
})
