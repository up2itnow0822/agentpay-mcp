import { describe, expect, it } from 'vitest';
import { buildPostQuantumSpendEnvelopeCompatibilityReport } from '../src/utils/post-quantum-spend-envelope-compatibility.js';

describe('post-quantum spend-envelope compatibility report', () => {
  it('maps AgentPay controls without claiming unverified ML-DSA implementation', () => {
    const report = buildPostQuantumSpendEnvelopeCompatibilityReport();

    expect(report.status).toBe('assessment_only');
    expect(report.controls.map((control) => control.name)).toEqual([
      'spend_limit',
      'allowlist',
      'x402_receipt',
      'approval_gate',
      'audit_metadata',
    ]);
    expect(report.unsupportedClaims).toEqual(
      expect.arrayContaining([
        'ML-DSA-65 signing',
        'AP2 envelope conformance',
        'ACP envelope conformance',
        'Arbitrum audit-ledger publication',
      ])
    );
    expect(report.controls.every((control) => control.nonClaim.includes('AgentPay'))).toBe(true);
  });
});
