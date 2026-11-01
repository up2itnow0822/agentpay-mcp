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
  /** GraphQL comment-edit query throws (edit provenance unprovable). */
  commentGraphqlError?: boolean
}) {
  const waived = opts.waived ?? true
  const runs: Run[] = [...opts.priorRuns]
  let nextId = 5000
  const issueComments = (opts.comments ?? []).map((raw, i) => {
    const c = { ...(raw as Record<string, unknown>) }
    if (typeof c.id !== 'number') c.id = 8000 + i
    if (typeof c.node_id !== 'string') c.node_id = `IC_kw_test_${c.id}`
    return c
  })
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
      if (fn === list.comments) return issueComments
      if (fn === list.commits) return (opts.prCommits ?? [H]).map((sha) => ({ sha }))
      if (fn === list.checks) return runs.filter((r) => r.head_sha === params.ref && r.name === params.check_name)
      throw new Error('unexpected paginate target')
    },
    graphql: async (query?: string) => {
      if (opts.graphqlError) throw new Error('GraphQL unavailable')
      if (typeof query === 'string' && (query.includes('lastEditedAt') || query.includes('userContentEdits'))) {
        if (opts.commentGraphqlError) throw new Error('comment edits unavailable')
        return {
          repository: {
            pullRequest: {
              comments: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: issueComments
                  .filter((c) => {
                    const edits = c.edits as { missing?: boolean } | undefined
                    return !edits || edits.missing !== true
                  })
                  .map((c) => {
                    const edits = (c.edits && typeof c.edits === 'object' ? c.edits : {}) as {
                      lastEditedAt?: string | null
                      editor?: { login: string; __typename: string } | null
                      userContentEdits?: Array<{ login: string; __typename: string } | null>
                      editsHasNextPage?: boolean
                    }
                    return {
                      databaseId: c.id,
                      lastEditedAt: edits.lastEditedAt ?? null,
                      editor: edits.editor ?? null,
                      userContentEdits: {
                        pageInfo: { hasNextPage: edits.editsHasNextPage ?? false, endCursor: null },
                        nodes: (edits.userContentEdits ?? []).map((e) => ({
                          editor: e,
                        })),
                      },
                    }
                  }),
              },
            },
          },
        }
      }
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

describe('review-gate: only a non-dismissed Codex review of the current head SHA passes (SO F2)', () => {
  const P1 = 'd'.repeat(40) // an earlier commit of the PR
  const REVIEW = (commit: string, at: string, state = 'COMMENTED') => ({
    user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' },
    commit_id: commit,
    state,
    submitted_at: at,
  })
  const base = { tip: Y, tipAt: T(22), prBase: Y, labelId: '0', labeledAt: T(1), activity: ACTIVITY, priorRuns: [], waived: false }

  it('a review on an old commit fails', async () => {
    const w = world({ ...base, prCommits: [P1, H], reviews: [REVIEW(P1, T(23))] })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('a dismissed review on the head fails', async () => {
    const w = world({ ...base, prCommits: [P1, H], reviews: [REVIEW(H, T(23), 'DISMISSED')] })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('a non-dismissed review on the head passes', async () => {
    const w = world({ ...base, prCommits: [P1, H], reviews: [REVIEW(H, T(23))] })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('success')
    expect(published(w.runs)!.output.title).toBe('Codex reviewed PR')
  })

  it('a review of a commit that is not part of the PR does not count (e.g. after a force-push)', async () => {
    const foreign = 'f'.repeat(40)
    const w = world({ ...base, prCommits: [P1, H], reviews: [REVIEW(foreign, T(23))] })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
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

  it('a clean-pass summary counts only for the current head SHA', async () => {
    const summary = (sha: string) => ({
      user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' },
      body: `<!-- codex-pull-request-review-summary -->\n| Review | Status | Commit | Trigger |\n| --- | --- | --- | --- |\n| Code Review | Completed | \`${sha}\` | Manual |`,
      created_at: T(23),
      updated_at: T(23),
    })
    const onHead = world({ ...base, prCommits: [P1, H], comments: [summary(H)] })
    await run(onHead.github, PUSH, onHead.core)
    expect(published(onHead.runs)!.output.title).toBe('Codex reviewed PR')

    const oldCommit = world({ ...base, prCommits: [P1, H], comments: [summary(P1)] })
    await run(oldCommit.github, PUSH, oldCommit.core)
    expect(published(oldCommit.runs)!.output.title).toBe('Waiting for Codex review')

    const foreign = world({ ...base, prCommits: [P1, H], comments: [summary('e'.repeat(40))] })
    await run(foreign.github, PUSH, foreign.core)
    expect(published(foreign.runs)!.output.title).toBe('Waiting for Codex review')
  })
})

describe('review-gate: clean pass via hidden codex-review-state:v1 block', () => {
  // Codex no longer writes a 40-char SHA in the summary table. The full
  // head SHA lives only in `<!-- codex-review-state:v1 ... -->` inside the
  // SUMMARY comment. Receipt comments carry a short SHA and must stay red.
  const P1 = 'd'.repeat(40)
  const OTHER = 'e'.repeat(40)
  const SHORT = 'e5a915c'
  const base = { tip: Y, tipAt: T(22), prBase: Y, labelId: '0', labeledAt: T(1), activity: ACTIVITY, priorRuns: [], waived: false }
  const CODEX = { login: 'chatgpt-codex-connector[bot]', type: 'Bot' } as const

  const stateBlock = (cr: Record<string, unknown>, sr?: Record<string, unknown>) =>
    '<!-- codex-review-state:v1 ' +
    JSON.stringify({
      code_review: cr,
      security_review: sr ?? { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
    }) +
    ' -->'

  const cleanState = (overrides: Record<string, unknown> = {}) =>
    stateBlock({
      commit_sha: H,
      has_any_findings: false,
      has_unresolved_findings: false,
      status: 'completed',
      ...overrides,
    })

  const summaryComment = (opts: {
    state?: string
    tableSha?: string
    user?: { login: string; type: string }
    at?: string
    created_at?: string
    updated_at?: string
    reviewedAt?: string
    body?: string
    edits?: {
      lastEditedAt?: string | null
      editor?: { login: string; __typename: string } | null
      userContentEdits?: Array<{ login: string; __typename: string } | null>
      editsHasNextPage?: boolean
      missing?: boolean
    }
  } = {}) => ({
    user: opts.user ?? CODEX,
    body:
      opts.body ??
      `<!-- codex-pull-request-review-summary -->\n${opts.state ?? ''}\n` +
        '| Review | Status | Commit | Review trigger |\n| --- | --- | --- |\n' +
        `| Code Review | Completed${
          opts.reviewedAt
            ? ` <relative-time datetime="${opts.reviewedAt}">${opts.reviewedAt}</relative-time>`
            : ''
        } | \`${opts.tableSha ?? SHORT}\` | Manual |\n`,
    created_at: opts.created_at ?? opts.at ?? T(23),
    updated_at: opts.updated_at ?? opts.at ?? T(23),
    ...(opts.edits ? { edits: opts.edits } : {}),
  })

  const CODEX_BOT_EDITOR = { login: 'chatgpt-codex-connector[bot]', __typename: 'Bot' } as const
  const CODEX_ONLY_EDITS = (at: string) => ({
    lastEditedAt: at,
    editor: CODEX_BOT_EDITOR,
    userContentEdits: [CODEX_BOT_EDITOR],
  })

  it('(1) GREEN: state block with full head SHA, completed, no unresolved findings', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({ state: cleanState(), tableSha: SHORT })],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('success')
    expect(published(w.runs)!.output.title).toBe('Codex reviewed PR')
    expect(published(w.runs)!.output.summary).toMatch(/clean review/)
  })

  it('(2) RED: receipt comment with only a short SHA and no state block', async () => {
    const receipt = {
      user: CODEX,
      body:
        '<!-- codex-review-receipt:v1 -->\n\n' +
        "Codex Review: Didn't find any major issues. Keep it up!\n\n" +
        '**Reviewed commit:** `e5a915c723`\n',
      created_at: T(23),
      updated_at: T(23),
    }
    const w = world({ ...base, prCommits: [P1, H], comments: [receipt] })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(3) RED: state block SHA does not match the head', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({ state: cleanState({ commit_sha: OTHER }), tableSha: SHORT })],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(4) RED: has_unresolved_findings is true', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({ state: cleanState({ has_unresolved_findings: true }), tableSha: SHORT })],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(5) RED: malformed JSON in the state block', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({
        state: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"' + H + '","status":"completed" -->',
        tableSha: SHORT,
      })],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(6) RED: non-Codex author with a valid-looking state block', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({
        state: cleanState(),
        tableSha: SHORT,
        user: { login: 'not-codex', type: 'User' },
      })],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(7) RED: dismissed SHA even with a completed state block', async () => {
    const dismissed = {
      user: CODEX,
      commit_id: H,
      state: 'DISMISSED',
      submitted_at: T(23),
    }
    const w = world({
      ...base,
      prCommits: [P1, H],
      reviews: [dismissed],
      comments: [summaryComment({ state: cleanState(), tableSha: SHORT })],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(8) RED: summary comment before the last retarget', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({ state: cleanState(), tableSha: SHORT, at: T(23) })],
      extraTimeline: [{ event: 'base_ref_changed', created_at: T(24) }],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(9) GREEN: existing table-regex path still accepts a full 40-char SHA', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({ tableSha: H })],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('success')
    expect(published(w.runs)!.output.title).toBe('Codex reviewed PR')
  })

  it('(10) RED: an edit by a non-Codex user is not a clean pass', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({
        state: cleanState(),
        tableSha: SHORT,
        edits: {
          lastEditedAt: T(23, 2),
          editor: { login: 'up2itnow0822', __typename: 'User' },
          userContentEdits: [{ login: 'up2itnow0822', __typename: 'User' }],
        },
      })],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(11) RED: a short SHA inside the JSON state block is never accepted', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({ state: cleanState({ commit_sha: SHORT }), tableSha: SHORT })],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(12) RED: a state block without the summary marker is not evidence', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [{
        user: CODEX,
        body: `${cleanState()}\n| Review | Status | Commit |\n| --- | --- | --- |\n| Code Review | Completed | \`${SHORT}\` |\n`,
        created_at: T(23),
        updated_at: T(23),
      }],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(13) RED: the Codex login with a non-Bot account type does not count', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({
        state: cleanState(),
        tableSha: SHORT,
        user: { login: 'chatgpt-codex-connector[bot]', type: 'User' },
      })],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(14) created_at and updated_at varied independently are not freshness proof', async () => {
    // No retarget: independently dated timestamps still pass when the state
    // block itself is a clean review of this head.
    const ok = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({
        state: cleanState(),
        tableSha: SHORT,
        created_at: T(20),
        updated_at: T(25),
      })],
    })
    await run(ok.github, PUSH, ok.core)
    expect(published(ok.runs)!.conclusion).toBe('success')
    expect(published(ok.runs)!.output.title).toBe('Codex reviewed PR')

    // Retarget in between: a later updated_at without a code-review
    // relative-time stays RED (updated_at is not proof of a fresh review).
    const stale = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({
        state: cleanState(),
        tableSha: SHORT,
        created_at: T(20),
        updated_at: T(25),
      })],
      extraTimeline: [{ event: 'base_ref_changed', created_at: T(24) }],
    })
    await run(stale.github, PUSH, stale.core)
    expect(published(stale.runs)!.conclusion).toBe('failure')
    expect(published(stale.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(15) RED: a retarget followed by an edit that only changes security_review', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({
        state: stateBlock(
          { commit_sha: H, has_any_findings: false, has_unresolved_findings: false, status: 'completed' },
          { commit_sha: H, has_any_findings: false, has_unresolved_findings: false, status: 'completed' },
        ),
        tableSha: SHORT,
        created_at: T(23),
        updated_at: T(25),
        reviewedAt: T(23),
        edits: CODEX_ONLY_EDITS(T(25)),
      })],
      extraTimeline: [{ event: 'base_ref_changed', created_at: T(24) }],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('failure')
    expect(published(w.runs)!.output.title).toBe('Waiting for Codex review')
  })

  it('(16) GREEN: a retarget followed by a fresh Codex code review', async () => {
    const w = world({
      ...base,
      prCommits: [P1, H],
      comments: [summaryComment({
        state: cleanState(),
        tableSha: SHORT,
        created_at: T(23),
        updated_at: T(25),
        reviewedAt: T(25),
        edits: CODEX_ONLY_EDITS(T(25)),
      })],
      extraTimeline: [{ event: 'base_ref_changed', created_at: T(24) }],
    })
    await run(w.github, PUSH, w.core)
    expect(published(w.runs)!.conclusion).toBe('success')
    expect(published(w.runs)!.output.title).toBe('Codex reviewed PR')
    expect(published(w.runs)!.output.summary).toMatch(/clean review/)
  })
})
