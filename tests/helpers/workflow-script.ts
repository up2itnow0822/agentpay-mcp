/**
 * Run the deterministic Node script embedded in a workflow `run:` block
 * (`node --input-type=module - <<'NODE' … NODE`) against a sandbox, with a
 * fake `gh` on PATH that records every call. Lets the publish logic of the
 * daily-review / daily-repair workflows be tested for real, not by grep.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function extractNodeScript(workflowFile: string, marker: string): string {
  const text = readFileSync(new URL(`../../.github/workflows/${workflowFile}`, import.meta.url), 'utf8')
  const at = text.indexOf(marker)
  if (at < 0) throw new Error(`marker not found in ${workflowFile}: ${marker}`)
  const start = text.indexOf("<<'NODE'\n", at)
  const lines = text.slice(start + "<<'NODE'\n".length).split('\n')
  const end = lines.findIndex((l) => l.trim() === 'NODE')
  const body = lines.slice(0, end)
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length))
  return body.map((l) => l.slice(indent)).join('\n')
}

export interface GhCall {
  args: string[]
  body?: string
}

export interface ScriptRun {
  status: number
  stdout: string
  stderr: string
  calls: GhCall[]
}

/** Ignore the machine's git config (signing, push negotiation, …). */
const HERMETIC_GIT = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const gitEnv = { ...process.env, ...HERMETIC_GIT }

const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const call = { args };
const i = args.indexOf('--body-file');
if (i >= 0) call.body = fs.readFileSync(args[i + 1], 'utf8');
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(call) + '\\n');
const key = args.slice(0, 2).join(' ');
if (key === 'pr list') process.stdout.write(process.env.FAKE_GH_PR_LIST || '[]');
else if (key === 'issue list') process.stdout.write(process.env.FAKE_GH_ISSUE_LIST || '[]');
else if (key === 'pr create') process.stdout.write('https://github.com/o/r/pull/' + (1 + fs.readFileSync(process.env.FAKE_GH_LOG, 'utf8').split('pr","create').length - 1) + '\\n');
`

export function runWorkflowScript(
  script: string,
  options: { env: Record<string, string>; cwd?: string; prList?: unknown[]; issueList?: unknown[] }
): ScriptRun {
  const dir = mkdtempSync(join(tmpdir(), 'wf-script-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  const log = join(dir, 'gh.log')
  writeFileSync(log, '')
  const file = join(dir, 'script.mjs')
  writeFileSync(file, script)
  const res = spawnSync(process.execPath, [file], {
    cwd: options.cwd ?? dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      FAKE_GH_LOG: log,
      FAKE_GH_PR_LIST: JSON.stringify(options.prList ?? []),
      FAKE_GH_ISSUE_LIST: JSON.stringify(options.issueList ?? []),
      ...HERMETIC_GIT,
      ...options.env,
    },
  })
  const calls = readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GhCall)
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr, calls }
}

/** A git work tree at a base commit, with a bare `origin` it can push to. */
export function gitSandbox(files: Record<string, string>): { work: string; origin: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wf-git-'))
  const origin = join(dir, 'origin.git')
  const work = join(dir, 'work')
  const g = (args: string[], cwd = work) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
      cwd,
      encoding: 'utf8',
      env: gitEnv,
    }).trim()
  execFileSync('git', ['init', '--quiet', '--bare', origin], { env: gitEnv })
  mkdirSync(work)
  g(['init', '--quiet'])
  for (const [path, content] of Object.entries(files)) {
    const full = join(work, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  g(['add', '-A'])
  g(['commit', '--quiet', '-m', 'base'])
  g(['remote', 'add', 'origin', origin])
  g(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'])
  return { work, origin, base: g(['rev-parse', 'HEAD']) }
}

/** Edit files in the sandbox, capture the patch the plan job would, reset. */
export function proposePatch(work: string, edit: () => void): string {
  edit()
  execFileSync('git', ['add', '-A'], { cwd: work, env: gitEnv })
  const patch = execFileSync('git', ['diff', '--cached', '--binary', '--full-index', 'HEAD'], { cwd: work, env: gitEnv })
  execFileSync('git', ['reset', '--quiet', '--hard', 'HEAD'], { cwd: work, env: gitEnv })
  execFileSync('git', ['clean', '-qfd'], { cwd: work, env: gitEnv })
  return patch.toString('utf8')
}

export function branchesOn(origin: string): string[] {
  if (!existsSync(origin)) return []
  return execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: origin, encoding: 'utf8', env: gitEnv })
    .split('\n')
    .filter(Boolean)
    .sort()
}
