/**
 * The daily-review publisher (deterministic, the only issue writer) must
 * enforce .github/review-schema.json — including optional metrics — so a
 * schema-invalid report becomes a failure issue, never a "valid" report.
 * Runs the REAL script from daily-review.yml with a recording `gh`.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractNodeScript, runWorkflowScript } from './helpers/workflow-script.js'

const script = extractNodeScript('daily-review.yml', 'Validate report and publish exactly one issue')
const today = new Date().toISOString().slice(0, 10)
const REPO = 'up2itnow0822/agentpay-mcp'

function report(extra: Record<string, unknown> = {}) {
  const doc = {
    schema_version: 1,
    repo: REPO,
    date: today,
    status: 'COMPLETE',
    summary: 'All good.',
    health: {
      ci_status: 'success',
      open_pr_count: 1,
      stale_pr_count: 0,
      dependency_alerts: 0,
      secrets_found: false,
      notes: '',
    },
    findings: [],
    skipped: [],
    ...extra,
  }
  return `Summary\n\n\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\`\n`
}

function publish(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'review-pub-'))
  const path = join(dir, 'review-report.md')
  writeFileSync(path, text)
  return runWorkflowScript(script, {
    env: {
      GH_REPO: REPO,
      EXPECTED_REPO: REPO,
      REPORT_PATH: path,
      ANALYZE_RESULT: 'success',
      PREFLIGHT: 'ok',
      HAS_OAUTH_SECRET: 'true',
      RUN_URL: 'https://example.invalid/run/1',
      WORK_DIR: dir,
    },
  })
}

const created = (run: ReturnType<typeof publish>) =>
  run.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'create').map((c) => c.args.join(' '))

describe('daily-review publisher metrics validation (Codex P2)', () => {
  it('publishes a report with schema-valid metrics', () => {
    const run = publish(report({ metrics: { files_scanned: 120, duration_minutes: 4.5 } }))
    expect(run.status, run.stderr).toBe(0)
    expect(created(run).join('\n')).toContain(`Daily Review — ${today}`)
    expect(created(run).join('\n')).not.toContain('daily-review-failed')
  })

  it.each([
    [{ files_scanned: 'unknown' }, /files_scanned/],
    [{ files_scanned: -1 }, /files_scanned/],
    [{ files_scanned: 1.5 }, /files_scanned/],
    [{ duration_minutes: -2 }, /duration_minutes/],
    [{ duration_minutes: 'NaN' }, /duration_minutes/],
  ])('refuses metrics %j and files the failure issue instead', (metrics, reason) => {
    const run = publish(report({ metrics }))
    expect(run.status).toBe(1)
    const issues = created(run).join('\n')
    expect(issues).toContain('daily-review-failed')
    expect(issues).not.toContain(`--title Daily Review — ${today} `)
    const failure = run.calls.find((c) => c.args[0] === 'issue' && c.args[1] === 'create')!
    expect(failure.body).toMatch(reason)
  })
})
