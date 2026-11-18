#!/usr/bin/env node
/**
 * Blocking dependency-source check.
 *
 * Reads package.json, package-lock.json and .npmrc from disk only (no
 * network, no npm CLI). Fails closed on npm: aliases, non-registry specs,
 * lockfile entries that did not come from registry.npmjs.org, lockfile
 * name/path mismatches, missing integrity, a non-npmjs .npmrc registry,
 * or an unreadable/old lockfile.
 *
 * Unknown flags fail closed. Never prints environment values.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const NPMJS_HOST = 'registry.npmjs.org'
const DEP_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
]

const UNKNOWN_FLAG = /^--?/
const NPM_ALIAS = /^npm:/i
const NON_REGISTRY_PROTOCOL =
  /^(file:|link:|workspace:|portal:|patch:|git\+|git:|github:|gist:|bitbucket:|gitlab:|http:|https:|ssh:|ftp:)/i
const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#|$)/
const OVERRIDE_REF = /^\$[A-Za-z0-9@/_-]+$/
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/
const SCOPED_REGISTRY_KEY = /^@[A-Za-z0-9_.~-]+\:registry$/i
const INTERPOLATION = /\$\{/

function failClosed(message) {
  process.stdout.write(`dependency-source check: FAIL\n  ${message}\n`)
  process.exit(1)
}

function pathKey(parts) {
  let out = ''
  for (const part of parts) {
    if (SAFE_IDENT.test(part)) {
      out += out ? `.${part}` : part
    } else {
      out += `[${JSON.stringify(part)}]`
    }
  }
  return out
}

function readText(filePath) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
    throw new Error(`${filePath} unreadable${code ? ` (${code})` : ''}`)
  }
}

function parseJsonFile(filePath, label) {
  let text
  try {
    text = readText(filePath)
  } catch (err) {
    throw new Error(`${label}: ${err instanceof Error ? err.message : 'unreadable'}`)
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'parse error'
    throw new Error(`${label}: parse error (${detail})`)
  }
}

function resolveAllowlistPath(root) {
  const local = join(root, 'dependency-sources-allowlist.json')
  if (existsSync(local)) return local
  const nested = join(root, 'scripts', 'dependency-sources-allowlist.json')
  if (existsSync(nested)) return nested
  return join(scriptDir, 'dependency-sources-allowlist.json')
}

function loadAllowlist(root) {
  const filePath = resolveAllowlistPath(root)
  if (!existsSync(filePath)) {
    return { entries: [], filePath: null }
  }
  const data = parseJsonFile(filePath, filePath)
  if (Array.isArray(data)) {
    if (!data.every((item) => typeof item === 'string')) {
      throw new Error(`${filePath}: allowlist entries must be strings`)
    }
    return { entries: data, filePath }
  }
  if (data !== null && typeof data === 'object' && Array.isArray(data.entries)) {
    if (!data.entries.every((item) => typeof item === 'string')) {
      throw new Error(`${filePath}: allowlist entries must be strings`)
    }
    return { entries: data.entries, filePath }
  }
  throw new Error(`${filePath}: allowlist must be an array or { "entries": [] }`)
}

function workspacePatterns(pkg) {
  const ws = pkg && pkg.workspaces
  if (Array.isArray(ws)) return ws.filter((p) => typeof p === 'string')
  if (ws && typeof ws === 'object' && Array.isArray(ws.packages)) {
    return ws.packages.filter((p) => typeof p === 'string')
  }
  return []
}

function globToRegExp(glob) {
  let re = '^'
  let i = 0
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?'
      i += 3
      continue
    }
    if (glob.startsWith('**', i)) {
      re += '.*'
      i += 2
      continue
    }
    if (glob[i] === '*') {
      re += '[^/]*'
      i += 1
      continue
    }
    if (glob[i] === '?') {
      re += '[^/]'
      i += 1
      continue
    }
    const ch = glob[i]
    if ('\\^$+{}()|[]'.includes(ch) || ch === '.') {
      re += `\\${ch}`
    } else {
      re += ch
    }
    i += 1
  }
  re += '$'
  return new RegExp(re)
}

function matchesWorkspace(relPath, patterns) {
  if (typeof relPath !== 'string' || relPath.length === 0) return false
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized))
}

function isDeclaredWorkspaceLink(entry, patterns) {
  if (!entry || entry.link !== true) return false
  return matchesWorkspace(entry.resolved, patterns)
}

function isNpmjsHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username || url.password) return false
  if (url.hostname.toLowerCase() !== NPMJS_HOST) return false
  if (url.port && url.port !== '443') return false
  return true
}

function classifySpec(spec) {
  if (typeof spec !== 'string') return { kind: 'invalid' }
  const trimmed = spec.trim()
  if (trimmed.length === 0) return { kind: 'non-registry' }
  if (NPM_ALIAS.test(trimmed)) return { kind: 'npm-alias' }
  if (NON_REGISTRY_PROTOCOL.test(trimmed) || /:\/\//.test(trimmed)) {
    return { kind: 'non-registry' }
  }
  if (GITHUB_SHORTHAND.test(trimmed)) return { kind: 'non-registry' }
  if (OVERRIDE_REF.test(trimmed)) return { kind: 'ok' }
  return { kind: 'ok' }
}

function walkDepTree(value, parts, findings) {
  if (typeof value === 'string') {
    const classified = classifySpec(value)
    const key = `package.json:${pathKey(parts)}`
    if (classified.kind === 'npm-alias') {
      findings.push({ code: 'F1', key, detail: 'npm: alias' })
    } else if (classified.kind === 'non-registry' || classified.kind === 'invalid') {
      findings.push({ code: 'F2', key, detail: 'non-registry spec' })
    }
    return
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [child, nested] of Object.entries(value)) {
      walkDepTree(nested, [...parts, child], findings)
    }
    return
  }
  if (value !== undefined) {
    findings.push({
      code: 'F2',
      key: `package.json:${pathKey(parts)}`,
      detail: 'non-registry spec',
    })
  }
}

function impliedNameFromLockKey(pkgPath) {
  if (typeof pkgPath !== 'string' || pkgPath.length === 0) return null
  const parts = pkgPath.split('/')
  const idx = parts.lastIndexOf('node_modules')
  if (idx < 0) return null
  const rest = parts.slice(idx + 1)
  if (rest.length === 0) return null
  if (rest[0].startsWith('@')) {
    if (rest.length < 2) return null
    return `${rest[0]}/${rest[1]}`
  }
  return rest[0]
}

function checkLockfilePackages(lock, workspaceGlobs, findings) {
  const packages = lock.packages
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) {
    findings.push({
      code: 'F7',
      key: 'package-lock.json:packages',
      detail: 'missing or invalid packages map',
    })
    return
  }

  for (const [pkgPath, entry] of Object.entries(packages)) {
    if (pkgPath === '') continue
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      findings.push({
        code: 'F7',
        key: `package-lock.json:packages[${JSON.stringify(pkgPath)}]`,
        detail: 'invalid lockfile entry',
      })
      continue
    }

    const workspaceLink = isDeclaredWorkspaceLink(entry, workspaceGlobs)
    const lockKey = `package-lock.json:packages[${JSON.stringify(pkgPath)}]`

    if (!workspaceLink) {
      if (!isNpmjsHttpsUrl(entry.resolved)) {
        findings.push({
          code: 'F3',
          key: `${lockKey}.resolved`,
          detail: 'resolved is not https://registry.npmjs.org/',
        })
      }
      if (typeof entry.integrity !== 'string' || entry.integrity.trim() === '') {
        findings.push({
          code: 'F5',
          key: `${lockKey}.integrity`,
          detail: 'missing integrity',
        })
      }
    }

    const implied = impliedNameFromLockKey(pkgPath)
    if (implied && typeof entry.name === 'string' && entry.name !== implied) {
      findings.push({
        code: 'F4',
        key: `${lockKey}.name`,
        detail: `name ${JSON.stringify(entry.name)} differs from path ${JSON.stringify(implied)}`,
      })
    }
  }
}

function checkNpmrc(root, findings) {
  const npmrcPath = join(root, '.npmrc')
  if (!existsSync(npmrcPath)) return

  let text
  try {
    text = readText(npmrcPath)
  } catch (err) {
    findings.push({
      code: 'F7',
      key: '.npmrc',
      detail: err instanceof Error ? err.message : 'unreadable',
    })
    return
  }

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    const isRegistryKey = key.toLowerCase() === 'registry' || SCOPED_REGISTRY_KEY.test(key)
    if (!isRegistryKey) continue

    const named = `.npmrc:${key}`
    if (INTERPOLATION.test(value)) {
      findings.push({
        code: 'F6',
        key: named,
        detail: 'registry value uses interpolation and cannot be verified',
      })
      continue
    }
    if (!isNpmjsHttpsUrl(value)) {
      findings.push({
        code: 'F6',
        key: named,
        detail: 'registry is not registry.npmjs.org',
      })
    }
  }
}

function parseArgs(argv) {
  const flags = argv.filter((arg) => UNKNOWN_FLAG.test(arg))
  if (flags.length > 0) {
    failClosed(`unknown flag ${flags[0]} (flags are not accepted)`)
  }
  if (argv.length > 1) {
    failClosed(`expected at most one root directory, got ${argv.length}`)
  }
  return argv[0] ?? process.cwd()
}

function main() {
  const root = parseArgs(process.argv.slice(2))
  const findings = []

  let allowlist
  try {
    allowlist = loadAllowlist(root)
  } catch (err) {
    failClosed(`F7 ${err instanceof Error ? err.message : 'allowlist parse error'}`)
  }

  process.stdout.write(`allowlist (${allowlist.entries.length} entries)\n`)
  for (const entry of allowlist.entries) {
    process.stdout.write(`  ${entry}\n`)
  }

  const allow = new Set(allowlist.entries)
  const packageJsonPath = join(root, 'package.json')
  const lockPath = join(root, 'package-lock.json')

  if (!existsSync(packageJsonPath)) {
    failClosed(`F7 ${packageJsonPath} is missing`)
  }
  if (!existsSync(lockPath)) {
    failClosed('F7 package-lock.json is missing')
  }

  let pkg
  try {
    pkg = parseJsonFile(packageJsonPath, 'package.json')
  } catch (err) {
    failClosed(`F7 ${err instanceof Error ? err.message : 'package.json parse error'}`)
  }
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) {
    failClosed('F7 package.json is not an object')
  }

  let lock
  try {
    lock = parseJsonFile(lockPath, 'package-lock.json')
  } catch (err) {
    failClosed(`F7 ${err instanceof Error ? err.message : 'package-lock.json parse error'}`)
  }
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) {
    failClosed('F7 package-lock.json is not an object')
  }

  const lockfileVersion = lock.lockfileVersion
  if (typeof lockfileVersion !== 'number' || !Number.isFinite(lockfileVersion) || lockfileVersion < 2) {
    findings.push({
      code: 'F7',
      key: 'package-lock.json:lockfileVersion',
      detail: `lockfileVersion ${JSON.stringify(lockfileVersion)} is missing or < 2`,
    })
  }

  for (const field of DEP_FIELDS) {
    if (field in pkg) {
      walkDepTree(pkg[field], [field], findings)
    }
  }

  checkLockfilePackages(lock, workspacePatterns(pkg), findings)
  checkNpmrc(root, findings)

  const blocking = findings.filter((finding) => !allow.has(finding.key))
  if (blocking.length > 0) {
    process.stdout.write('dependency-source check: FAIL\n')
    for (const finding of blocking) {
      process.stdout.write(`  ${finding.code} ${finding.key} ${finding.detail}\n`)
    }
    process.exit(1)
  }

  process.stdout.write('dependency-source check: PASS\n')
  process.exit(0)
}

main()
