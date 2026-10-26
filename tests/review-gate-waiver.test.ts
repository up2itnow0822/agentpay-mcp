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
  /** Default: the codex-waived label is on the PR. */
  waived?: boolean
  reviews?: unknown[]
  /** Every activity-feed request fails (e.g. a transient API error). */
  activityError?: boolean
  /** Review threads: author of the first comment and resolution. */
  threads?: Array<{ login: string; isResolved: boolean }>
  graphqlError?: boolean
  prCommits?: string[]
  comments?: unknown[]
  extraTimeline?: unknown[]
}) {
  const waived = opts.waived ?? true
  const runs: Run[] = [...opts.priorRuns]
  let nextId = 5000
  const pr = {
    number: 90,
    draft: false,
    state: 'open',
    labels: waived ? [{ name: 'codex-waived' }] : [],
    head: { sha: H, ref: 'security/x' },
    base: { sha: opts.prBase, ref: 'main' },
  }
  const timeline = [...(opts.extraTimeline ?? []), ...(!waived ? [] : [
    {
      id: Number(opts.labelId),
      event: 'labeled',
      label: { name: 'codex-waived' },
      actor: { login: 'up2itnow0822' },
      created_at: opts.labeledAt,
    },
  ])]
  const list = {
    pulls: async () => ({ data: [pr] }),
    reviews: async () => ({ data: [] }),
    timeline: async () => ({ data: timeline }),
    comments: async () => ({ data: [] }),
    checks: async () => ({ data: [] }),
    commits: async () => ({ data: [] }),
  }
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pr }), list: list.pulls, listReviews: list.reviews, listCommits: list.commits },
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
      if (fn === list.reviews) return opts.reviews ?? []
      if (fn === list.timeline) return timeline
      if (fn === list.comments) return opts.comments ?? []
      if (fn === list.commits) return (opts.prCommits ?? [H]).map((sha) => ({ sha }))
      if (fn === list.checks) return runs.filter((r) => r.head_sha === params.ref && r.name === params.check_name)
      throw new Error('unexpected paginate target')
    },
    graphql: async () => {
      if (opts.graphqlError) throw new Error('GraphQL unavailable')
      return {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: (opts.threads ?? []).map((t) => ({
                isResolved: t.isResolved,
                comments: { nodes: [{ author: { login: t.login } }] },
              })),
            },
          },
        },
      }
    },
    request: async () => {
      if (opts.activityError) throw new Error('HTTP 502 from the activity API')
      return { data: opts.activity }
    },
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

describe('review-gate fails closed without the server-side base timestamp (Codex pass 4, P1)', () => {
  // main advanced to Y on day 22, but Y's (caller-controlled) commit date
  // claims day 19. A Codex review from day 21 predates the advance.
  const EARLY_REVIEW = {
    user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' },
    commit_id: H,
    state: 'COMMENTED',
    submitted_at: T(21),
  }

  it('an unavailable activity feed is not replaced by the forgeable commit date', async () => {
    const w = world({
      tip: Y, tipAt: T(19), prBase: Y, labelId: '0', labeledAt: T(1),
      activity: ACTIVITY, priorRuns: [], waived: false, reviews: [EARLY_REVIEW], activityError: true,
    })
    await expect(run(w.github, PUSH, w.core)).rejects.toThrow(/activity/)
    const verdict = published(w.runs)!
    expect(verdict.conclusion).toBe('failure')
    expect(verdict.output.title).toBe('Evaluation failed')
  })

  it('with the feed available, a review from before a base advance still counts (no second Codex pass)', async () => {
    const w = world({
      tip: Y, tipAt: T(19), prBase: Y, labelId: '0', labeledAt: T(1),
      activity: ACTIVITY, priorRuns: [], waived: false, reviews: [EARLY_REVIEW],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.output.title).toBe('Codex reviewed PR')
  })

  it('a review after the advance passes', async () => {
    const w = world({
      tip: Y, tipAt: T(19), prBase: Y, labelId: '0', labeledAt: T(1),
      activity: ACTIVITY, priorRuns: [], waived: false, reviews: [{ ...EARLY_REVIEW, submitted_at: T(23) }],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.output.title).toBe('Codex reviewed PR')
  })
})

describe('review-gate: Codex reviews the PR once; every Codex thread must be resolved (maintainer policy)', () => {
  const P1 = 'd'.repeat(40) // an earlier commit of the PR
  const REVIEW = (commit: string, at: string, state = 'COMMENTED') => ({
    user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' },
    commit_id: commit,
    state,
    submitted_at: at,
  })
  const base = { tip: Y, tipAt: T(22), prBase: Y, labelId: '0', labeledAt: T(1), activity: ACTIVITY, priorRuns: [], waived: false }

  it('a review of an earlier commit passes after later pushes — no re-review', async () => {
    const w = world({ ...base, prCommits: [P1, H], reviews: [REVIEW(P1, T(23))] })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('success')
    expect(published(w.runs)!.output.title).toBe('Codex reviewed PR')
  })

  it('an unresolved Codex thread blocks; other reviewers\' threads are left to the ruleset', async () => {
    const blocked = world({
      ...base,
      reviews: [REVIEW(H, T(23))],
      threads: [{ login: 'chatgpt-codex-connector', isResolved: false }, { login: 'cursor', isResolved: false }],
    })
    await run(blocked.github, PUSH, blocked.core)
    expect(published(blocked.runs)!.output.title).toBe('Codex threads unresolved')
    expect(published(blocked.runs)!.output.summary).toMatch(/^1 review thread/)

    const clear = world({
      ...base,
      reviews: [REVIEW(H, T(23))],
      threads: [{ login: 'chatgpt-codex-connector', isResolved: true }, { login: 'cursor', isResolved: false }],
    })
    await run(clear.github, PUSH, clear.core)
    expect(published(clear.runs)!.conclusion).toBe('success')
  })

  it('fails closed when review threads cannot be read', async () => {
    const w = world({ ...base, reviews: [REVIEW(H, T(23))], graphqlError: true })
    await expect(run(w.github, PUSH, w.core)).rejects.toThrow(/GraphQL/)
    expect(published(w.runs)!.output.title).toBe('Evaluation failed')
  })

  it('a review from before a retarget does not count; a dismissed review never counts', async () => {
    const retargeted = world({
      ...base,
      reviews: [REVIEW(H, T(23))],
      extraTimeline: [{ event: 'base_ref_changed', created_at: T(24) }],
    })
    await run(retargeted.github, PUSH, retargeted.core)
    expect(published(retargeted.runs)!.output.title).toBe('Waiting for Codex review')

    const dismissed = world({ ...base, reviews: [REVIEW(H, T(23), 'DISMISSED')] })
    await run(dismissed.github, PUSH, dismissed.core)
    expect(published(dismissed.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('a clean-pass summary counts only for a commit of this PR', async () => {
    const summary = (sha: string) => ({
      user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' },
      body: `<!-- codex-pull-request-review-summary -->\n| Review | Status | Commit | Trigger |\n| --- | --- | --- | --- |\n| Code Review | Completed | \`${sha}\` | Manual |`,
      created_at: T(23),
      updated_at: T(23),
    })
    const ok = world({ ...base, prCommits: [P1, H], comments: [summary(P1)] })
    await run(ok.github, PUSH, ok.core)
    expect(published(ok.runs)!.output.title).toBe('Codex reviewed PR')

    const foreign = world({ ...base, prCommits: [P1, H], comments: [summary('e'.repeat(40))] })
    await run(foreign.github, PUSH, foreign.core)
    expect(published(foreign.runs)!.output.title).toBe('Waiting for Codex review')
  })
})
