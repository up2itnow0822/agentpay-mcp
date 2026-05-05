import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AuthorizedCyberScanProfileSchema,
  evaluateAuthorizedCyberScanProfile,
  type AuthorizedCyberScanPolicy,
} from '../src/utils/authorized-cybersecurity-scan-profile.js';

const fixture = JSON.parse(
  readFileSync(new URL('../docs/fixtures/authorized-cybersecurity-scan-profile-agentaegis-2026-05-04.json', import.meta.url), 'utf8')
);

const policy: AuthorizedCyberScanPolicy = {
  now: new Date('2026-05-04T21:30:00.000Z'),
  allowedDomains: ['example.com'],
  maxRequestedCostUsd: 5,
  minReceiptRetentionDays: 180,
};

describe('authorized cybersecurity-scan payment profile', () => {
  it('validates the AgentAegis-style profile fixture', () => {
    const parsed = AuthorizedCyberScanProfileSchema.safeParse(fixture);

    expect(parsed.success).toBe(true);
    expect(fixture.scan).toMatchObject({ target_domain: 'example.com', category: 'vulnerability_scan' });
  });

  it('allows paid scan signing only after target authorization, spend cap, rate limit, approval, and receipt checks pass', () => {
    const result = evaluateAuthorizedCyberScanProfile(fixture, policy);

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('rejects unauthorized targets and scan categories before payment', () => {
    const tampered = {
      ...fixture,
      scan: { ...fixture.scan, target: 'https://not-example.test', target_domain: 'not-example.test', category: 'security_audit' },
    };

    const result = evaluateAuthorizedCyberScanProfile(tampered, policy);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'Target domain not-example.test is not listed in the authorization attestation.',
        'Target domain not-example.test is not allowed by buyer policy.',
        'Scan category security_audit is not authorized for target not-example.test.',
      ])
    );
  });

  it('rejects expired authorization, cap overrun, exhausted rate limits, and missing human approval', () => {
    const tampered = {
      ...fixture,
      authorization: { ...fixture.authorization, expires_at: '2026-05-04T21:10:00.000Z' },
      spend_policy: { ...fixture.spend_policy, spent_for_target_usd: 23, requested_cost_usd: 4 },
      rate_limit: { ...fixture.rate_limit, scans_used_in_window: 3 },
      approval_gate: { ...fixture.approval_gate, approved: false },
    };

    const result = evaluateAuthorizedCyberScanProfile(tampered, policy);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'Target authorization is expired.',
        'Requested scan would exceed the per-target spend cap.',
        'Scan rate limit is exhausted for this target window.',
        'Human approval has not been granted for this paid cybersecurity scan.',
      ])
    );
  });

  it('requires audit receipts to say target authorization, spend cap, and x402 receipt were retained', () => {
    const tampered = {
      ...fixture,
      audit_receipt: {
        ...fixture.audit_receipt,
        retention_days: 30,
        language: 'Scan complete. Evidence stored for operations review only.',
      },
    };

    const result = evaluateAuthorizedCyberScanProfile(tampered, policy);

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'Audit receipt retention 30 days is below required 180.',
        'Audit receipt language must include "authorized target".',
        'Audit receipt language must include "spend cap".',
        'Audit receipt language must include "x402 receipt".',
      ])
    );
  });
});
