#!/usr/bin/env node
/**
 * Runs T0–T10, SO probes, path-spec cases, HTTPS/shrinkwrap/unchecked-lock
 * probes, and the 79592d6 picomatch-override replay against
 * scripts/check-dependency-sources.mjs using Node built-ins only.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const checker = join(repoRoot, 'scripts', 'check-dependency-sources.mjs')

export const CASES = [
  {
    id: 'T0',
    root: repoRoot,
    expectExit: 0,
    mustMatch: [/dependency-source check: PASS/],
  },
  {
    id: 'T1',
    root: join(here, 'T1-npm-override'),
    expectExit: 1,
    mustMatch: [/F1 /, /package\.json:overrides\.picomatch/, /npm: alias/],
  },
  {
    id: 'T2',
    root: join(here, 'T2-nested-override'),
    expectExit: 1,
    mustMatch: [/F1 /, /package\.json:overrides\.vitest\.picomatch/, /npm: alias/],
  },
  {
    id: 'T3',
    root: join(here, 'T3-devdep-npm-alias'),
    expectExit: 1,
    mustMatch: [/F1 /, /package\.json:devDependencies\.foo/, /npm: alias/],
  },
  {
    id: 'T4-git-https',
    root: join(here, 'T4-git-https'),
    expectExit: 1,
    mustMatch: [/F2 /, /package\.json:dependencies\.foo/, /non-registry spec/],
  },
  {
    id: 'T4-github',
    root: join(here, 'T4-github'),
    expectExit: 1,
    mustMatch: [/F2 /, /package\.json:dependencies\.foo/, /non-registry spec/],
  },
  {
    id: 'T4-https-tarball',
    root: join(here, 'T4-https-tarball'),
    expectExit: 1,
    mustMatch: [/F2 /, /package\.json:dependencies\.foo/, /non-registry spec/],
  },
  {
    id: 'T4-file',
    root: join(here, 'T4-file'),
    expectExit: 1,
    mustMatch: [/F2 /, /package\.json:dependencies\.foo/, /non-registry spec/],
  },
  {
    id: 'T5',
    root: join(here, 'T5-lock-non-npmjs-resolved'),
    expectExit: 1,
    mustMatch: [
      /F3 /,
      /package-lock\.json:packages\["node_modules\/foo"\]\.resolved/,
      /resolved is not https:\/\/registry\.npmjs\.org\//,
    ],
  },
  {
    id: 'T6',
    root: join(here, 'T6-lock-name-mismatch'),
    expectExit: 1,
    mustMatch: [
      /F4 /,
      /package-lock\.json:packages\["node_modules\/picomatch"\]\.name/,
      /@ryotsu\/picomatch/,
    ],
  },
  {
    id: 'T7',
    root: join(here, 'T7-lock-missing-integrity'),
    expectExit: 1,
    mustMatch: [
      /F5 /,
      /package-lock\.json:packages\["node_modules\/foo"\]\.integrity/,
      /missing integrity/,
    ],
  },
  {
    id: 'T8',
    root: join(here, 'T8-npmrc-evil-registry'),
    expectExit: 1,
    mustMatch: [/F6 /, /\.npmrc:registry/, /registry is not registry\.npmjs\.org/],
  },
  {
    id: 'T9-malformed-lock',
    root: join(here, 'T9-malformed-lock'),
    expectExit: 1,
    mustMatch: [/F7 /, /package-lock\.json/, /parse error/],
  },
  {
    id: 'T9-missing-lock',
    root: join(here, 'T9-missing-lock'),
    expectExit: 1,
    mustMatch: [/F7 /, /package-lock\.json is missing/],
  },
  {
    id: 'T10',
    root: join(here, 'T10-allowlisted'),
    expectExit: 0,
    mustMatch: [
      /allowlist \(1 entries\)/,
      /package\.json:overrides\.picomatch/,
      /dependency-source check: PASS/,
    ],
  },
  {
    id: 'p1',
    root: join(here, 'p1-lockfile-only-alias'),
    expectExit: 1,
    mustMatch: [
      /F4 /,
      /package-lock\.json:packages\["node_modules\/picomatch"\]\.resolved/,
    ],
  },
  {
    id: 'p5',
    root: join(here, 'p5-root-lock-npm-alias'),
    expectExit: 1,
    mustMatch: [
      /F1 /,
      /package-lock\.json:packages\[""\]\.dependencies\.picomatch/,
      /npm: alias/,
    ],
  },
  {
    id: 'p7',
    root: join(here, 'p7'),
    expectExit: 1,
    mustMatch: [/F2 /, /package\.json:dependencies\.foo/, /non-registry spec/],
  },
  {
    id: 'dot-path',
    root: join(here, 'dot-path'),
    expectExit: 1,
    mustMatch: [/F2 /, /package\.json:dependencies\.foo/, /non-registry spec/],
  },
  {
    id: 'abs-path',
    root: join(here, 'abs-path'),
    expectExit: 1,
    mustMatch: [/F2 /, /package\.json:dependencies\.foo/, /non-registry spec/],
  },
  {
    id: 'http-npmrc',
    root: join(here, 'http-npmrc'),
    expectExit: 1,
    mustMatch: [/F6 /, /\.npmrc:registry/, /registry is not registry\.npmjs\.org/],
  },
  {
    id: 'http-npmrc-scope',
    root: join(here, 'http-npmrc-scope'),
    expectExit: 1,
    mustMatch: [/F6 /, /\.npmrc:@foo:registry/, /registry is not registry\.npmjs\.org/],
  },
  {
    id: 'http-publishconfig',
    root: join(here, 'http-publishconfig'),
    expectExit: 1,
    mustMatch: [/F6 /, /package\.json:publishConfig\.registry/, /registry is not registry\.npmjs\.org/],
  },
  {
    id: 'http-resolved',
    root: join(here, 'http-resolved'),
    expectExit: 1,
    mustMatch: [
      /F3 /,
      /package-lock\.json:packages\["node_modules\/foo"\]\.resolved/,
      /resolved is not https:\/\/registry\.npmjs\.org\//,
    ],
  },
  {
    id: 'shrinkwrap-evil',
    root: join(here, 'shrinkwrap-evil'),
    expectExit: 1,
    mustMatch: [
      /F7 /,
      /npm-shrinkwrap\.json/,
      /differs from package-lock\.json/,
      /F1 /,
      /npm-shrinkwrap\.json:packages\[""\]\.dependencies\.foo/,
      /npm: alias/,
    ],
  },
  {
    id: 'shrinkwrap-differ',
    root: join(here, 'shrinkwrap-differ'),
    expectExit: 1,
    mustMatch: [/F7 /, /npm-shrinkwrap\.json/, /differs from package-lock\.json/],
  },
  {
    id: 'shrinkwrap-ok',
    root: join(here, 'shrinkwrap-ok'),
    expectExit: 0,
    mustMatch: [/dependency-source check: PASS/],
  },
  {
    id: 'pnpm-lock',
    root: join(here, 'pnpm-lock'),
    expectExit: 1,
    mustMatch: [/F7 /, /pnpm-lock\.yaml/, /present and not validated/],
  },
  {
    id: 'yarn-lock',
    root: join(here, 'yarn-lock'),
    expectExit: 1,
    mustMatch: [/F7 /, /yarn\.lock/, /present and not validated/],
  },
  {
    id: 'replay-79592d6',
    root: join(here, 'replay-79592d6'),
    expectExit: 1,
    mustMatch: [
      /F1 /,
      /package\.json:overrides\.picomatch/,
      /F4 /,
      /package-lock\.json:packages\["node_modules\/picomatch"\]\.name/,
    ],
  },
]

export function runChecker(root, extraArgs = []) {
  const result = spawnSync(process.execPath, [checker, root, ...extraArgs], {
    encoding: 'utf8',
    cwd: repoRoot,
  })
  return {
    status: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

function runCases() {
  let failed = 0
  for (const testCase of CASES) {
    const result = runChecker(testCase.root)
    const problems = []
    if (result.status !== testCase.expectExit) {
      problems.push(`exit ${result.status}, expected ${testCase.expectExit}`)
    }
    for (const pattern of testCase.mustMatch) {
      if (!pattern.test(result.output)) {
        problems.push(`missing /${pattern.source}/`)
      }
    }
    const verdict = problems.length === 0 ? 'ok' : 'NOT OK'
    if (problems.length > 0) failed += 1
    process.stdout.write(`\n===== ${testCase.id} (${verdict}) =====\n`)
    process.stdout.write(result.output)
    if (!result.output.endsWith('\n')) process.stdout.write('\n')
    if (problems.length > 0) {
      process.stdout.write(`fixture problems: ${problems.join('; ')}\n`)
    }
  }
  process.stdout.write(`\n${CASES.length - failed}/${CASES.length} fixture cases matched expectations\n`)
  process.exit(failed === 0 ? 0 : 1)
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (invoked === import.meta.url) {
  runCases()
}
