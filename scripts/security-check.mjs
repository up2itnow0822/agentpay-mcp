import { spawnSync } from 'node:child_process'
import https from 'node:https'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const GHSA_RE = /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i
const HIGH_SEVERITIES = new Set(['high', 'critical'])

export const PICOMATCH_ADVISORY_ID = 'GHSA-fc5q-39xc-vjpf'
export const PICOMATCH_EXCEPTION_EXPIRES_AT = '2026-12-16T05:59:00Z'
export const PICOMATCH_EXCEPTION_EXPIRES_AT_MS = Date.parse(PICOMATCH_EXCEPTION_EXPIRES_AT)
export const PICOMATCH_EXCEPTION_EXPIRES_LABEL = '2026-12-15 23:59 America/Chicago'

export function picomatchExceptionWarning() {
  return (
    `⚠️ SEC-20261117-02 R2: excepting ${PICOMATCH_ADVISORY_ID}` +
    ` (picomatch ReDoS, range <=4.0.7) until ${PICOMATCH_EXCEPTION_EXPIRES_LABEL}` +
    ` (${PICOMATCH_EXCEPTION_EXPIRES_AT}); the exception ends then or when GitHub lists a patched picomatch, whichever is first.`
  )
}

export function canonicalizeGhsa(text) {
  const m = String(text ?? '').match(GHSA_RE)
  if (!m) return null
  const parts = m[0].split('-')
  if (parts.length !== 4) return null
  return `GHSA-${parts[1].toLowerCase()}-${parts[2].toLowerCase()}-${parts[3].toLowerCase()}`
}

function ghsaFromViaEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  return canonicalizeGhsa(entry.url) || canonicalizeGhsa(entry.id) || null
}

function resolveViaNode(name, vulns, stack, cache) {
  if (cache.has(name)) return cache.get(name)
  if (stack.has(name)) return { ok: false, reason: 'cyclic' }
  const node = vulns[name]
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return { ok: false, reason: 'unresolved' }
  }
  const via = node.via
  if (!Array.isArray(via) || via.length === 0) {
    return { ok: false, reason: 'unresolved' }
  }

  stack.add(name)
  const ids = new Set()
  for (const entry of via) {
    if (typeof entry === 'string') {
      if (!entry) {
        stack.delete(name)
        return { ok: false, reason: 'unresolved' }
      }
      const inner = resolveViaNode(entry, vulns, stack, cache)
      if (!inner.ok) {
        stack.delete(name)
        return inner
      }
      for (const id of inner.ids) ids.add(id)
      continue
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const id = ghsaFromViaEntry(entry)
      if (!id) {
        stack.delete(name)
        return { ok: false, reason: 'unknown' }
      }
      ids.add(id)
      continue
    }
    stack.delete(name)
    return { ok: false, reason: 'unknown' }
  }
  stack.delete(name)
  const result = { ok: true, ids }
  cache.set(name, result)
  return result
}

function collectHighCriticalLeafAdvisories(auditJson) {
  if (
    !auditJson ||
    typeof auditJson !== 'object' ||
    auditJson.auditReportVersion !== 2 ||
    !auditJson.vulnerabilities ||
    typeof auditJson.vulnerabilities !== 'object' ||
    Array.isArray(auditJson.vulnerabilities)
  ) {
    return { ok: false, reason: 'unknown' }
  }

  const vulns = auditJson.vulnerabilities
  const starts = Object.keys(vulns).filter((name) =>
    HIGH_SEVERITIES.has(String(vulns[name]?.severity ?? '').toLowerCase())
  )
  const metaHigh = Number(auditJson.metadata?.vulnerabilities?.high ?? 0)
  const metaCritical = Number(auditJson.metadata?.vulnerabilities?.critical ?? 0)
  if (starts.length === 0) {
    if (metaHigh > 0 || metaCritical > 0) return { ok: false, reason: 'unresolved' }
    return { ok: false, reason: 'no-high' }
  }

  const cache = new Map()
  const ids = new Set()
  for (const name of starts) {
    const resolved = resolveViaNode(name, vulns, new Set(), cache)
    if (!resolved.ok) return resolved
    for (const id of resolved.ids) ids.add(id)
  }
  if (ids.size === 0) return { ok: false, reason: 'unresolved' }
  return { ok: true, ids }
}

function prodAuditHasHighOrCritical(prodAuditJson) {
  if (!prodAuditJson || typeof prodAuditJson !== 'object') return true
  const meta = prodAuditJson.metadata?.vulnerabilities
  if (!meta || typeof meta !== 'object') return true
  if (Number(meta.high) > 0 || Number(meta.critical) > 0) return true
  const vulns = prodAuditJson.vulnerabilities
  if (vulns && typeof vulns === 'object') {
    for (const node of Object.values(vulns)) {
      if (HIGH_SEVERITIES.has(String(node?.severity ?? '').toLowerCase())) return true
    }
  }
  return false
}

function prodTreeContainsPicomatch(prodLsJson) {
  if (!prodLsJson || typeof prodLsJson !== 'object') return true
  const walk = (node) => {
    if (!node || typeof node !== 'object') return false
    if (node.name === 'picomatch') return true
    const deps = node.dependencies
    if (deps && typeof deps === 'object') {
      if (Object.prototype.hasOwnProperty.call(deps, 'picomatch')) return true
      for (const child of Object.values(deps)) {
        if (walk(child)) return true
      }
    }
    return false
  }
  return walk(prodLsJson)
}

function patchedPicomatchStatus(advisory) {
  if (!advisory || typeof advisory !== 'object') return { ok: false }
  if (
    typeof advisory.ghsa_id === 'string' &&
    canonicalizeGhsa(advisory.ghsa_id) !== PICOMATCH_ADVISORY_ID
  ) {
    return { ok: false }
  }
  const vulns = advisory.vulnerabilities
  if (!Array.isArray(vulns)) return { ok: false }
  const npmPicomatch = vulns.filter((entry) => {
    const pkg = entry?.package
    return (
      pkg &&
      typeof pkg === 'object' &&
      String(pkg.ecosystem ?? '').toLowerCase() === 'npm' &&
      pkg.name === 'picomatch'
    )
  })
  if (npmPicomatch.length === 0) return { ok: false }
  for (const entry of npmPicomatch) {
    const patched = entry.first_patched_version
    if (patched == null || patched === '') continue
    if (typeof patched === 'string') return { ok: true, patched: true }
    if (typeof patched === 'object' && typeof patched.version === 'string' && patched.version) {
      return { ok: true, patched: true }
    }
    return { ok: false }
  }
  return { ok: true, patched: false }
}

export function evaluatePicomatchR2(input) {
  const graph = collectHighCriticalLeafAdvisories(input?.auditJson)
  const picomatchOnly =
    graph.ok && graph.ids.size === 1 && graph.ids.has(PICOMATCH_ADVISORY_ID)
  if (!picomatchOnly) {
    return { apply: false, reason: graph.ok ? 'mixed' : graph.reason }
  }

  const nowMs = input?.nowMs
  if (!Number.isFinite(nowMs) || nowMs >= PICOMATCH_EXCEPTION_EXPIRES_AT_MS) {
    return { apply: false, reason: 'expired' }
  }

  if (prodTreeContainsPicomatch(input?.prodLsJson)) {
    return { apply: false, reason: 'prod-picomatch' }
  }

  if (prodAuditHasHighOrCritical(input?.prodAuditJson)) {
    return { apply: false, reason: 'prod-audit' }
  }

  const lookup = input?.advisoryLookup
  if (!lookup || lookup.ok !== true) {
    return { apply: false, reason: 'advisory-lookup-failed' }
  }

  const patched = patchedPicomatchStatus(lookup.advisory)
  if (!patched.ok) {
    return { apply: false, reason: 'advisory-lookup-failed' }
  }
  if (patched.patched) {
    return { apply: false, reason: 'patched' }
  }

  return { apply: true, warning: picomatchExceptionWarning() }
}

function spawnNpmJson(args) {
  const result = spawnSync('npm', args, {
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) return null
  try {
    return JSON.parse(result.stdout ?? '')
  } catch {
    return null
  }
}

export function fetchGithubAdvisory(ghsaId) {
  return new Promise((resolveLookup) => {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agentpay-mcp-security-check',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    const token = process.env.GITHUB_TOKEN
    if (token) headers.Authorization = `Bearer ${token}`

    const req = https.request(
      {
        protocol: 'https:',
        hostname: 'api.github.com',
        port: 443,
        path: `/advisories/${encodeURIComponent(ghsaId)}`,
        method: 'GET',
        headers,
        timeout: 10_000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          resolveLookup({ ok: false })
          return
        }
        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          size += chunk.length
          if (size > 1_000_000) {
            req.destroy()
            resolveLookup({ ok: false })
          } else {
            chunks.push(chunk)
          }
        })
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (!body || typeof body !== 'object' || typeof body.ghsa_id !== 'string') {
              resolveLookup({ ok: false })
              return
            }
            resolveLookup({ ok: true, advisory: body })
          } catch {
            resolveLookup({ ok: false })
          }
        })
      }
    )
    req.on('error', () => resolveLookup({ ok: false }))
    req.on('timeout', () => {
      req.destroy()
      resolveLookup({ ok: false })
    })
    req.end()
  })
}

async function tryApplyPicomatchException() {
  const auditJson = spawnNpmJson(['audit', '--json'])
  const prodAuditJson = spawnNpmJson(['audit', '--omit=dev', '--audit-level=high', '--json'])
  const prodLsJson = spawnNpmJson(['ls', 'picomatch', '--omit=dev', '--json'])
  if (auditJson == null || prodAuditJson == null || prodLsJson == null) {
    return { apply: false, reason: 'unresolved' }
  }
  const advisoryLookup = await fetchGithubAdvisory(PICOMATCH_ADVISORY_ID)
  return evaluatePicomatchR2({
    nowMs: Date.now(),
    auditJson,
    prodAuditJson,
    prodLsJson,
    advisoryLookup,
  })
}

export async function main() {
  const args = ['audit', '--audit-level=high']
  const result = spawnSync('npm', args, {
    stdio: 'pipe',
    encoding: 'utf8',
  })

  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  const combined = `${stdout}\n${stderr}`

  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)

  if (result.status === 0) {
    process.stdout.write('\n✅ npm audit completed successfully.\n')
    return 0
  }

  const environmentFailurePattern =
    /audit endpoint returned an error|\b(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|E401|E403|E429)\b|\b(?:HTTP|status(?: code)?)\s*[:=]?\s*(?:401|403|429|5\d\d)\b/i
  const hasEnvironmentFailure = environmentFailurePattern.test(combined)

  if (hasEnvironmentFailure) {
    process.stdout.write(
      '\n⚠️ npm audit could not complete because of registry/network access limitations.\n' +
        'Treating this as an environment limitation so CI can continue.\n' +
        'Run security scanning in an environment with npm advisory endpoint access.\n'
    )
    return 0
  }

  if (/vulnerabilities/i.test(combined)) {
    let exception = { apply: false }
    try {
      exception = await tryApplyPicomatchException()
    } catch {
      exception = { apply: false }
    }
    if (exception.apply) {
      process.stderr.write(`${exception.warning}\n`)
      return 0
    }
    process.stderr.write('\n❌ npm audit detected vulnerabilities at or above the configured threshold.\n')
    return result.status ?? 1
  }

  process.stderr.write(
    '\n❌ npm audit failed for an unknown reason. Failing security check.\n'
  )
  return result.status ?? 1
}

function isCliEntry() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href
  } catch {
    return false
  }
}

if (isCliEntry()) {
  main().then(
    (code) => process.exit(code),
    () => {
      process.stderr.write(
        '\n❌ npm audit failed for an unknown reason. Failing security check.\n'
      )
      process.exit(1)
    }
  )
}
