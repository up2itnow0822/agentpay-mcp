/**
 * Codex review of PR #90 (P1): the value packs are installed from their own
 * directory (examples/value-packs/README.md: `npm install` there), so their
 * manifest and lockfile must resolve the same agentwallet-sdk and viem the
 * code is written and tested against — e.g. X402Client.settle402AndRetry
 * exists only from agentwallet-sdk 7.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'))
const root = read('package.json')
const pack = read('examples/value-packs/package.json')
const lock = read('examples/value-packs/package-lock.json')

describe('value-pack dependencies match the root package', () => {
  it.each(['agentwallet-sdk', 'viem'])('%s is pinned to the root version in manifest and lockfile', (name) => {
    const want = root.dependencies[name]
    expect(want).toMatch(/^\d+\.\d+\.\d+$/)
    expect(pack.dependencies[name]).toBe(want)
    expect(lock.packages[''].dependencies[name]).toBe(want)
    expect(lock.packages[`node_modules/${name}`].version).toBe(want)
  })

  it('resolves an agentwallet-sdk that provides settle402AndRetry (>= 7)', () => {
    expect(Number(lock.packages['node_modules/agentwallet-sdk'].version.split('.')[0])).toBeGreaterThanOrEqual(7)
  })
})
