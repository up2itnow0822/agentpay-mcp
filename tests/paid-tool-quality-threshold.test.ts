import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PaidToolQualityProofSchema,
  evaluatePaidToolQualityThreshold,
  type PaidToolQualityPolicy,
} from '../src/utils/paid-tool-quality-threshold.js';

const fixture = JSON.parse(
  readFileSync(new URL('../docs/fixtures/paid-tool-quality-threshold-strale-2026-05-04.json', import.meta.url), 'utf8')
);

const strictPolicy: PaidToolQualityPolicy = {
  minimumScore: 85,
  maxScoreAgeMs: 15 * 60 * 1000,
  maxProviderStaleStreak: 2,
  minimumSuccessRate24h: 0.95,
  allowedNetworks: ['base'],
  allowedAssets: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
  allowedPayTo: ['0x1111111111111111111111111111111111111111'],
  requireHumanApproval: true,
  requireVerifiedReceipt: true,
};

describe('paid-tool quality threshold evaluation', () => {
  it('validates the Strale-style score proof fixture', () => {
    const parsed = PaidToolQualityProofSchema.safeParse(fixture);

    expect(parsed.success).toBe(true);
    expect(fixture.score).toMatchObject({ current: 92, min_required: 85 });
  });

  it('allows payment only when score, provider health, receipt, allowlist, and approval gate pass', () => {
    const result = evaluatePaidToolQualityThreshold(fixture, strictPolicy, new Date('2026-05-04T21:25:00.000Z'));

    expect(result.ok).toBe(true);
    expect(result.decision).toBe('allow');
    expect(result.failures).toEqual([]);
  });

  it('denies stale scores even when the catalog score itself is high', () => {
    const result = evaluatePaidToolQualityThreshold(fixture, strictPolicy, new Date('2026-05-04T21:50:00.000Z'));

    expect(result.ok).toBe(false);
    expect(result.decision).toBe('deny');
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'Quality proof is stale for buyer policy: age 1920000ms exceeds 900000ms.',
        'Quality score is stale by proof contract: age 1920000ms exceeds 900000ms.',
        'Approval gate cannot allow paid work while quality threshold checks fail.',
      ])
    );
  });

  it('denies below-threshold scores, degraded providers, and unauthorized x402 payment metadata', () => {
    const tampered = {
      ...fixture,
      score: { ...fixture.score, current: 79, dimensions: { ...fixture.score.dimensions, availability: 70 } },
      provider_health: { ...fixture.provider_health, status: 'degraded', success_rate_24h: 0.8, receipt_state: 'missing' },
      x402_payment: {
        ...fixture.x402_payment,
        network: 'base-sepolia',
        payTo: '0x2222222222222222222222222222222222222222',
      },
    };

    const result = evaluatePaidToolQualityThreshold(tampered, strictPolicy, new Date('2026-05-04T21:25:00.000Z'));

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'Quality score 79 is below required 85.',
        'Provider health status is degraded.',
        'Provider success_rate_24h 0.8 is below required 0.95.',
        'Provider receipt_state is missing.',
        'x402 network base-sepolia is not allowed.',
        'x402 payTo 0x2222222222222222222222222222222222222222 is not allowed.',
        'Approval gate cannot allow paid work while quality threshold checks fail.',
      ])
    );
    expect(result.warnings).toContain('Quality dimension availability=70 is below buyer threshold 85.');
  });

  it('fails closed when human approval is missing before signing', () => {
    const withoutApproval = {
      ...fixture,
      approval_gate: {
        ...fixture.approval_gate,
        requires_human_approval: false,
        decision: 'allow',
      },
    };

    const result = evaluatePaidToolQualityThreshold(withoutApproval, strictPolicy, new Date('2026-05-04T21:25:00.000Z'));

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'Human approval is required before signing this paid tool call.',
        'Approval gate cannot allow paid work while quality threshold checks fail.',
      ])
    );
  });
});
