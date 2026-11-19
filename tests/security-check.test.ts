import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  PICOMATCH_ADVISORY_ID,
  PICOMATCH_EXCEPTION_EXPIRES_AT,
  PICOMATCH_EXCEPTION_EXPIRES_AT_MS,
  PICOMATCH_EXCEPTION_EXPIRES_LABEL,
  evaluatePicomatchR2,
  picomatchExceptionWarning,
} from '../scripts/security-check.mjs'

const fixtures = new URL('./fixtures/security-check/', import.meta.url)

function load(name: string) {
  return JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'))
}

const BEFORE_EXPIRY_MS = Date.parse('2026-11-18T22:36:00Z')
const picomatchOnly = load('audit-picomatch-only.json')
const mixedChain = load('audit-mixed-chain.json')
const unrelatedHigh = load('audit-unrelated-high.json')
const cyclic = load('audit-cyclic.json')
const unresolved = load('audit-unresolved.json')
const unknownVia = load('audit-unknown-via.json')
const prodAuditClean = load('prod-audit-clean.json')
const prodAuditHigh = load('prod-audit-high.json')
const prodLsEmpty = load('prod-ls-empty.json')
const prodLsPicomatch = load('prod-ls-picomatch.json')
const advisoryUnpatched = load('advisory-unpatched.json')
const advisoryPatched = load('advisory-patched.json')

function passing(overrides: Record<string, unknown> = {}) {
  return {
    nowMs: BEFORE_EXPIRY_MS,
    auditJson: picomatchOnly,
    prodAuditJson: prodAuditClean,
    prodLsJson: prodLsEmpty,
    advisoryLookup: { ok: true, advisory: advisoryUnpatched },
    ...overrides,
  }
}

describe('SEC-20261117-02 R2 picomatch exception', () => {
  it('a: picomatch-only via chains pass with the warning', () => {
    const result = evaluatePicomatchR2(passing())
    expect(result.apply).toBe(true)
    expect(result.warning).toBe(picomatchExceptionWarning())
    expect(result.warning).toContain(PICOMATCH_ADVISORY_ID)
    expect(result.warning).toContain(PICOMATCH_EXCEPTION_EXPIRES_LABEL)
    expect(result.warning).toContain(PICOMATCH_EXCEPTION_EXPIRES_AT)
    expect(result.warning).not.toContain('GHSA-rmxm-3fg6-px4f')
  })

  it('b: a mixed via chain (picomatch plus another high) fails', () => {
    const result = evaluatePicomatchR2(passing({ auditJson: mixedChain }))
    expect(result.apply).toBe(false)
    expect(result.reason).toBe('mixed')
  })

  it('c: an unrelated high fails', () => {
    const result = evaluatePicomatchR2(passing({ auditJson: unrelatedHigh }))
    expect(result.apply).toBe(false)
    expect(result.reason).toBe('mixed')
  })

  it('d: after expiry fails', () => {
    const atExpiry = evaluatePicomatchR2(passing({ nowMs: PICOMATCH_EXCEPTION_EXPIRES_AT_MS }))
    expect(atExpiry.apply).toBe(false)
    expect(atExpiry.reason).toBe('expired')

    const afterExpiry = evaluatePicomatchR2(
      passing({ nowMs: PICOMATCH_EXCEPTION_EXPIRES_AT_MS + 1 })
    )
    expect(afterExpiry.apply).toBe(false)
    expect(afterExpiry.reason).toBe('expired')
  })

  it('e: patched-version-listed fails', () => {
    const result = evaluatePicomatchR2(
      passing({ advisoryLookup: { ok: true, advisory: advisoryPatched } })
    )
    expect(result.apply).toBe(false)
    expect(result.reason).toBe('patched')
  })

  it('f: advisory lookup failure fails closed', () => {
    const missing = evaluatePicomatchR2(passing({ advisoryLookup: { ok: false } }))
    expect(missing.apply).toBe(false)
    expect(missing.reason).toBe('advisory-lookup-failed')

    const malformed = evaluatePicomatchR2(
      passing({ advisoryLookup: { ok: true, advisory: { ghsa_id: PICOMATCH_ADVISORY_ID } } })
    )
    expect(malformed.apply).toBe(false)
    expect(malformed.reason).toBe('advisory-lookup-failed')
  })

  it('g: picomatch in the prod tree fails', () => {
    const result = evaluatePicomatchR2(passing({ prodLsJson: prodLsPicomatch }))
    expect(result.apply).toBe(false)
    expect(result.reason).toBe('prod-picomatch')
  })

  it('h: a cyclic or unresolved via chain fails', () => {
    const cyclicResult = evaluatePicomatchR2(passing({ auditJson: cyclic }))
    expect(cyclicResult.apply).toBe(false)
    expect(cyclicResult.reason).toBe('cyclic')

    const unresolvedResult = evaluatePicomatchR2(passing({ auditJson: unresolved }))
    expect(unresolvedResult.apply).toBe(false)
    expect(unresolvedResult.reason).toBe('unresolved')

    const unknownResult = evaluatePicomatchR2(passing({ auditJson: unknownVia }))
    expect(unknownResult.apply).toBe(false)
    expect(unknownResult.reason).toBe('unknown')
  })

  it('does not apply when omit=dev audit still has high/critical', () => {
    const result = evaluatePicomatchR2(passing({ prodAuditJson: prodAuditHigh }))
    expect(result.apply).toBe(false)
    expect(result.reason).toBe('prod-audit')
  })

  it('does not suppress a parent package by name', () => {
    const parentOnly = {
      auditReportVersion: 2,
      vulnerabilities: {
        vitest: {
          name: 'vitest',
          severity: 'high',
          via: ['vite'],
        },
      },
      metadata: { vulnerabilities: { high: 1, critical: 0 } },
    }
    const result = evaluatePicomatchR2(passing({ auditJson: parentOnly }))
    expect(result.apply).toBe(false)
    expect(result.reason).toBe('unresolved')
  })
})
