import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CASES, runChecker } from '../test/fixtures/dep-sources/run.mjs'

const root = new URL('..', import.meta.url).pathname
const checkerSource = readFileSync(join(root, 'scripts/check-dependency-sources.mjs'), 'utf8')
const allowlist = JSON.parse(
  readFileSync(join(root, 'scripts/dependency-sources-allowlist.json'), 'utf8'),
)
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')
const build = readFileSync(join(root, '.github/workflows/build.yml'), 'utf8')

function namedStep(workflow: string, name: string): string {
  const lines = workflow.split(/\r?\n/)
  const start = lines.findIndex((line) => line.includes(`- name: ${name}`))
  expect(start, `missing step ${name}`).toBeGreaterThanOrEqual(0)
  const indent = lines[start].length - lines[start].trimStart().length
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent && /^\s+-\s+/.test(line)) {
      break
    }
    body.push(line)
  }
  return [lines[start], ...body].join('\n')
}

describe('dependency-source check', () => {
  it('ships an empty allowlist and no skip/bypass in the checker', () => {
    expect(allowlist).toEqual({ entries: [] })
    expect(pkg.scripts.security).toBe(
      'node scripts/check-dependency-sources.mjs && node scripts/security-check.mjs',
    )
    expect(checkerSource).not.toMatch(/process\.env/)
    expect(checkerSource).not.toMatch(/--skip|continue-on-error/)
    expect(checkerSource).toMatch(/unknown flag/)
  })

  it('rejects --skip and other flags', () => {
    const skipped = runChecker(root, ['--skip'])
    expect(skipped.status).toBe(1)
    expect(skipped.output).toMatch(/unknown flag --skip/)
    expect(skipped.output).not.toMatch(/dependency-source check: PASS/)
  })

  it.each(CASES)('$id exits $expectExit with the printed reason', (testCase) => {
    const result = runChecker(testCase.root)
    expect(result.status, result.output).toBe(testCase.expectExit)
    for (const pattern of testCase.mustMatch) {
      expect(result.output, result.output).toMatch(pattern)
    }
  })

  it('places the check before npm ci in CI and build, with no skip', () => {
    const ciCheck = namedStep(ci, 'Check dependency sources')
    const ciFixtures = namedStep(ci, 'Dependency source fixtures')
    const ciInstall = namedStep(ci, 'Install dependencies')
    expect(ciCheck).toContain('node scripts/check-dependency-sources.mjs')
    expect(ciCheck).not.toMatch(/continue-on-error/)
    expect(ciCheck).not.toMatch(/^\s+if:/m)
    expect(ciFixtures).toContain('node test/fixtures/dep-sources/run.mjs')
    expect(ciFixtures).not.toMatch(/continue-on-error/)
    expect(ciFixtures).not.toMatch(/^\s+if:/m)
    expect(ciInstall).toMatch(/run:\s*npm ci/)
    expect(ci.indexOf('Check dependency sources')).toBeLessThan(ci.indexOf('Install dependencies'))
    expect(ci.indexOf('node scripts/check-dependency-sources.mjs')).toBeLessThan(
      ci.indexOf('run: npm ci'),
    )

    const buildCheck = namedStep(build, 'Check dependency sources')
    const buildFixtures = namedStep(build, 'Dependency source fixtures')
    expect(buildCheck).toContain('node scripts/check-dependency-sources.mjs')
    expect(buildCheck).not.toMatch(/continue-on-error/)
    expect(buildCheck).not.toMatch(/^\s+if:/m)
    expect(buildFixtures).toContain('node test/fixtures/dep-sources/run.mjs')
    expect(buildFixtures).not.toMatch(/continue-on-error/)
    expect(buildFixtures).not.toMatch(/^\s+if:/m)
    expect(build.indexOf('Check dependency sources')).toBeLessThan(
      build.indexOf('Detect toolchain and build'),
    )
    expect(build.indexOf('node scripts/check-dependency-sources.mjs')).toBeLessThan(
      build.indexOf('npm ci'),
    )
  })

  it('rejects http registries, shrinkwrap drift, and unvalidated lockfiles', () => {
    const ciInstall = namedStep(ci, 'Install dependencies')
    expect(checkerSource).toMatch(/publishConfig/)
    expect(checkerSource).toMatch(/npm-shrinkwrap\.json/)
    expect(checkerSource).toMatch(/pnpm-lock\.yaml/)
    expect(checkerSource).toMatch(/yarn\.lock/)
    expect(ciInstall).toMatch(/run:\s*npm ci/)
    expect(ciInstall).not.toMatch(/\|\| npm install/)
    expect(build).not.toMatch(/\|\| pnpm install/)
    expect(build).not.toMatch(/\|\| yarn install/)
    expect(build).not.toMatch(/\|\| npm install/)
    expect(build).toMatch(/pnpm-lock\.yaml is present and not validated/)
    expect(build).toMatch(/yarn\.lock is present and not validated/)
  })
})
