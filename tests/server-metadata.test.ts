/**
 * Codex review of PR #90 (P1): the MCP registry descriptor must declare every
 * environment variable the server reads — above all the v5 policy settings,
 * without which every value-moving tool refuses to run — so a
 * descriptor-driven install is configurable and usable.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const server = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const declared = new Map<string, { isRequired: boolean; isSecret: boolean }>(
  server.packages[0].environmentVariables.map((v: { name: string; isRequired: boolean; isSecret: boolean }) => [v.name, v])
)

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : []
  })
}

const read = new Set<string>()
for (const file of sources(join(root, 'src'))) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/process\.env(?:\.|\[\s*['"])([A-Z][A-Z0-9_]*)/g)) read.add(m[1]!)
  for (const m of text.matchAll(/['"`](AGENTPAY_[A-Z0-9_]*[A-Z0-9])['"`]/g)) read.add(m[1]!)
}

describe('server.json environment variables', () => {
  it('finds the variables the server reads (guards against a vacuous pass)', () => {
    expect(read).toContain('AGENT_PRIVATE_KEY')
    expect(read).toContain('AGENTPAY_ALLOW_UNPOLICED_SPEND')
    expect(read).toContain('AGENTPAY_POLICY_DAILY_LIMIT_ETH')
  })

  it('declares every variable the server reads', () => {
    const missing = [...read].filter((name) => !declared.has(name)).sort()
    expect(missing).toEqual([])
  })

  it('declares nothing the server does not read', () => {
    const unused = [...declared.keys()].filter((name) => !read.has(name)).sort()
    expect(unused).toEqual([])
  })

  it('marks the signing key secret and the two wallet settings required', () => {
    expect(declared.get('AGENT_PRIVATE_KEY')).toMatchObject({ isRequired: true, isSecret: true })
    expect(declared.get('AGENT_WALLET_ADDRESS')).toMatchObject({ isRequired: true })
    for (const [name, v] of declared) if (name !== 'AGENT_PRIVATE_KEY') expect(v.isSecret, name).toBe(false)
  })

  it('keeps the descriptor version in step with package.json', () => {
    expect(server.version).toBe(pkg.version)
    expect(server.packages[0].version).toBe(pkg.version)
  })
})
