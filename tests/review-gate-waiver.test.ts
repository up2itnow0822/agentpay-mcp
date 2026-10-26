/**
 * Codex review of PR #90 (P1, review body on 1138030): a `codex-waived`
 * attestation must be bound to the LIVE base tip, like ordinary review
 * evidence. Otherwise, after a push to the base branch while the PR API's
 * `base.sha` still lags, the old waiver (recorded for the old base) is found
 * again and success is published for a base nobody waived.
 *
 * Runs the REAL "Evaluate and publish review-gate" script from
 * review-gate.yml against an in-memory GitHub.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const text = readFileSync(new URL('../.github/workflows/review-gate.yml', import.meta.url), 'utf8')

function gateScript(): string {
  const lines = text.split('\n')
  const step = lines.findIndex((l) => l.includes('name: Evaluate and publish review-gate'))
  const at = lines.findIndex((l, i) => i > step && /^\s*script:\s*\|\s*$/.test(l))
  const keyIndent = lines[at]!.length - lines[at]!.trimStart().length
  const body: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= keyIndent) break
    body.push(line)
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length))
  return body.map((l) => l.slice(indent)).join('\n')
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ..._args: string[]
) => (..._a: unknown[]) => Promise<unknown>
const run = new AsyncFunction('github', 'context', 'core', gateScript())

const H = 'a'.repeat(40)
const X = 'b'.repeat(40) // the base the waiver was given for
const Y = 'c'.repeat(40) // the base after a later push to main
const T = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, day, hour)).toISOString()

const WAIVER = (base: string, labelId: string, labeledAt: string) =>
  '<!-- review-gate-waiver:' +
  JSON.stringify({ pr: 90, head: H, base, base_ref: 'main', label_event_id: labelId, labeled_at: labeledAt, actor: 'up2itnow0822' }) +
  ' -->'
const BINDING = (base: string, observedAt: string) =>
  '<!-- review-gate-binding:' +
  JSON.stringify({ pr: 90, head: H, base_ref: 'main', base, pr_base: base, review_not_before: observedAt, observed_at: observedAt }) +
  ' -->'

interface Run {
  id: number
  name: string
  head_sha: string
  status: string
  conclusion: string | null
  started_at: string
  completed_at: string | null
  app: { slug: string }
  output: { title: string; summary: string }
}

function world(opts: {
  tip: string
  tipAt: string
  prBase: string
  labelId: string
  labeledAt: string
  activity: Array<{ after: string; timestamp: string }>
  priorRuns: Run[]
}) {
  const runs: Run[] = [...opts.priorRuns]
  let nextId = 5000
  const pr = {
    number: 90,
    draft: false,
    state: 'open',
    labels: [{ name: 'codex-waived' }],
    head: { sha: H, ref: 'security/x' },
    base: { sha: opts.prBase, ref: 'main' },
  }
  const timeline = [
    {
      id: Number(opts.labelId),
      event: 'labeled',
      label: { name: 'codex-waived' },
      actor: { login: 'up2itnow0822' },
      created_at: opts.labeledAt,
    },
  ]
  const list = {
    pulls: async () => ({ data: [pr] }),
    reviews: async () => ({ data: [] }),
    timeline: async () => ({ data: timeline }),
    comments: async () => ({ data: [] }),
    checks: async () => ({ data: [] }),
  }
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pr }), list: list.pulls, listReviews: list.reviews },
      issues: { listEventsForTimeline: list.timeline, listComments: list.comments },
      repos: {
        getBranch: async () => ({
          data: { commit: { sha: opts.tip, commit: { committer: { date: opts.tipAt }, author: { date: opts.tipAt } } } },
        }),
      },
      checks: {
        listForRef: list.checks,
        create: async (p: { name: string; head_sha: string; status: string; output: Run['output'] }) => {
          const r: Run = {
            id: nextId++,
            name: p.name,
            head_sha: p.head_sha,
            status: p.status,
            conclusion: null,
            started_at: new Date().toISOString(),
            completed_at: null,
            app: { slug: 'github-actions' },
            output: p.output,
          }
          runs.push(r)
          return { data: r }
        },
        update: async (p: { check_run_id: number; status: string; conclusion: string; output: Run['output'] }) => {
          const r = runs.find((x) => x.id === p.check_run_id)!
          Object.assign(r, { status: p.status, conclusion: p.conclusion, output: p.output, completed_at: new Date().toISOString() })
          return { data: r }
        },
        get: async (p: { check_run_id: number }) => ({ data: runs.find((x) => x.id === p.check_run_id) }),
      },
    },
    paginate: async (fn: unknown, params: { ref?: string; check_name?: string }) => {
      if (fn === list.pulls) return [pr]
      if (fn === list.reviews) return []
      if (fn === list.timeline) return timeline
      if (fn === list.comments) return []
      if (fn === list.checks) return runs.filter((r) => r.head_sha === params.ref && r.name === params.check_name)
      throw new Error('unexpected paginate target')
    },
    request: async () => ({ data: opts.activity }),
  }
  const warnings: string[] = []
  const core = {
    info: () => {},
    warning: (m: string) => warnings.push(m),
    error: () => {},
    setOutput: () => {},
  }
  return { github, core, runs, warnings }
}

const published = (runs: Run[]) => runs.filter((r) => r.id >= 5000 && r.status === 'completed').at(-1)

// The waiver was recorded while X was the base (day 21); main then moved to Y
// (day 22). The PR API still reports base X.
const STALE_WAIVER_RUN: Run = {
  id: 1,
  name: 'review-gate',
  head_sha: H,
  status: 'completed',
  conclusion: 'success',
  started_at: T(21, 1),
  completed_at: T(21, 2),
  app: { slug: 'github-actions' },
  output: { title: 'Codex waived', summary: `waived\n\n${WAIVER(X, '555', T(21))}\n${BINDING(X, T(21, 1))}` },
}
const ACTIVITY = [
  { after: X, timestamp: T(20) },
  { after: Y, timestamp: T(22) },
]
const PUSH = { repo: { owner: 'o', repo: 'r' }, eventName: 'push', payload: { ref: 'refs/heads/main' } }

describe('review-gate waivers bind to the live base tip', () => {
  it('a waiver recorded for the old base never passes the advanced base', async () => {
    const w = world({ tip: Y, tipAt: T(22), prBase: X, labelId: '555', labeledAt: T(21), activity: ACTIVITY, priorRuns: [STALE_WAIVER_RUN] })
    await run(w.github, PUSH, w.core)
    const verdict = published(w.runs)!
    expect(verdict.conclusion).toBe('failure')
    expect(verdict.output.title).not.toBe('Codex waived')
  })

  it('a waiver given after the live tip became current, and recorded for it, still passes', async () => {
    const fresh: Run = {
      ...STALE_WAIVER_RUN,
      id: 2,
      started_at: T(23, 1),
      completed_at: T(23, 2),
      output: { title: 'Codex waived', summary: `waived\n\n${WAIVER(Y, '777', T(23))}\n${BINDING(Y, T(23, 1))}` },
    }
    const w = world({ tip: Y, tipAt: T(22), prBase: X, labelId: '777', labeledAt: T(23), activity: ACTIVITY, priorRuns: [STALE_WAIVER_RUN, fresh] })
    await run(w.github, PUSH, w.core)
    const verdict = published(w.runs)!
    expect(verdict.conclusion).toBe('success')
    expect(verdict.output.title).toBe('Codex waived')
  })

  it('a fresh label is attested against the live tip, and only if it post-dates it', async () => {
    const labeledEvent = (labeledAt: string) => ({
      repo: { owner: 'o', repo: 'r' },
      eventName: 'pull_request_target',
      payload: {
        action: 'labeled',
        label: { name: 'codex-waived' },
        sender: { login: 'up2itnow0822' },
        pull_request: { number: 90, head: { sha: H }, base: { sha: X, ref: 'main' } },
        _labeledAt: labeledAt,
      },
    })

    // Label applied after Y became current: waived, and attested for Y.
    const ok = world({ tip: Y, tipAt: T(22), prBase: X, labelId: '901', labeledAt: T(23), activity: ACTIVITY, priorRuns: [] })
    await run(ok.github, labeledEvent(T(23)), ok.core)
    const verdict = published(ok.runs)!
    expect(verdict.output.title).toBe('Codex waived')
    expect(verdict.output.summary).toContain(`"base":"${Y}"`)
    expect(verdict.output.summary).not.toContain(`"base":"${X}","base_ref"`)

    // Label applied while X was current, evaluated after Y landed: not waived.
    const late = world({ tip: Y, tipAt: T(22), prBase: X, labelId: '902', labeledAt: T(21), activity: ACTIVITY, priorRuns: [] })
    await run(late.github, labeledEvent(T(21)), late.core)
    expect(published(late.runs)!.output.title).not.toBe('Codex waived')
  })
})
