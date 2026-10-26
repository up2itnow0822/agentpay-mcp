/**
 * SO F3: Daily Repair cannot be redirected onto a self-hosted runner,
 * and the REPAIR_TOKEN checkout must not persist credentials in .git/config.
 *
 * Parses the workflow YAML with the same line-based helpers as
 * workflow-security-policy.test.ts (no YAML parser in this repo).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const text = readFileSync(new URL('../.github/workflows/daily-repair.yml', import.meta.url), 'utf8')
const indentOf = (line: string): number => line.length - line.trimStart().length

function jobBlocks(src: string): Map<string, string[]> {
  const lines = src.split(/\r?\n/)
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  const jobs = new Map<string, string[]>()
  if (jobsAt < 0) return jobs
  let current: string | null = null
  for (const line of lines.slice(jobsAt + 1)) {
    if (/^\S/.test(line)) break
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (key) {
      current = key[1]
      jobs.set(current, [])
      continue
    }
    if (current) jobs.get(current)!.push(line)
  }
  return jobs
}

function nestedBlock(lines: string[], key: string, indent: number): string[] | null {
  const at = lines.findIndex((line) => indentOf(line) === indent && line.trim().startsWith(`${key}:`))
  if (at < 0) return null
  const inline = lines[at].trim().slice(key.length + 1).trim()
  if (inline && !inline.startsWith('#')) return [inline]
  const out: string[] = []
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (indentOf(line) <= indent) break
    out.push(line.replace(/\s+#.*$/, '').trim())
  }
  return out
}

function checkoutWith(lines: string[], needle: string): string[] | null {
  const at = lines.findIndex((line) => line.includes(needle))
  if (at < 0) return null
  let start = at
  while (start > 0 && !/^\s+-\s+name:/.test(lines[start])) start--
  const stepIndent = indentOf(lines[start])
  const step: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && indentOf(line) <= stepIndent && /^\s+-\s+/.test(line)) break
    step.push(line)
  }
  return nestedBlock(step, 'with', stepIndent + 2)
}

describe('daily-repair runner and REPAIR_TOKEN checkout (SO F3)', () => {
  const jobs = jobBlocks(text)
  const expectedJobs = ['preflight', 'plan', 'publish', 'audit']

  it('hard-codes ubuntu-latest on all four jobs and never interpolates MAINTAINER_RUNNER', () => {
    expect([...jobs.keys()]).toEqual(expectedJobs)
    for (const id of expectedJobs) {
      const runsOn = nestedBlock(jobs.get(id)!, 'runs-on', 4)
      expect(runsOn, `${id} runs-on`).toEqual(['ubuntu-latest'])
    }
    expect(text).not.toMatch(/MAINTAINER_RUNNER/)
    expect(text).not.toMatch(/vars\./)
  })

  it('sets persist-credentials: false on the checkout that uses REPAIR_TOKEN', () => {
    const publish = jobs.get('publish')!
    const withBlock = checkoutWith(publish, 'secrets.REPAIR_TOKEN')
    expect(withBlock, 'publish checkout with REPAIR_TOKEN').not.toBeNull()
    expect(withBlock).toEqual(expect.arrayContaining([
      'token: ${{ secrets.REPAIR_TOKEN }}',
      'persist-credentials: false',
    ]))
    expect(withBlock!.some((line) => line.includes('inputs.dry_run'))).toBe(false)
  })
})
