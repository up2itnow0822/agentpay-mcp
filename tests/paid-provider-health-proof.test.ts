import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PaidProviderHealthProofSchema,
  verifyPaidProviderHealthProof,
  type PaidProviderHealthPolicy,
} from '../src/utils/paid-provider-health-proof.js';

const fixture = JSON.parse(
  readFileSync(new URL('../docs/fixtures/paid-provider-health-proof-voidly-2026-05-02.json', import.meta.url), 'utf8')
);

const strictPolicy: PaidProviderHealthPolicy = {
  minimumSuccessRate: 0.95,
  maxProofAgeMs: 15 * 60 * 1000,
  maxProviderStaleStreak: 2,
  allowedNetworks: ['base-sepolia'],
  allowedAssets: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
  allowedPayTo: ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'],
  requireVerifiedReceipt: true,
  requireX402PaymentMetadata: true,
};

describe('paid-provider health proof verification', () => {
  it('validates the shipped Voidly-derived fixture schema', () => {
    const parsed = PaidProviderHealthProofSchema.safeParse(fixture);

    expect(parsed.success).toBe(true);
    expect(fixture.summary).toMatchObject({
      providers_probed: 5,
      providers_ok: 2,
      providers_failing: 3,
      success_rate: 0.4,
    });
  });

  it('fails closed for low success rate, stale providers, top-level not-ok state, and missing x402 metadata on failed providers', () => {
    const result = verifyPaidProviderHealthProof(fixture, strictPolicy, new Date('2026-05-02T21:30:00.000Z'));

    expect(result.ok).toBe(false);
    expect(result.eligibleProviders).toEqual([
      'did:voidly:AsAVzZ2dtMrntgGRco8KkW',
      'did:voidly:Eg8JvTNrBLcpbX3r461jJB',
    ]);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'Top-level provider health flag is false.',
        'Provider success_rate 0.4 is below required 0.95.',
        'did:voidly:Ck56rQkhsBe3bJa62bg81t: status=failed; stale_streak=207; receipt_state=missing; missing x402_payment metadata.',
        'did:voidly:mkt-b-1776622972: status=failed; stale_streak=312; receipt_state=missing; missing x402_payment metadata.',
      ])
    );
  });

  it('allows a healthy proof only when receipts, stale streaks, and x402 network asset payTo checks pass', () => {
    const healthy = {
      ...fixture,
      ok: true,
      summary: {
        providers_probed: 2,
        providers_ok: 2,
        providers_failing: 0,
        success_rate: 1,
      },
      providers: fixture.providers.slice(2, 4),
      routing: { fail_closed: true, decision: 'allow', reason: ['All selected providers are fresh and verified.'] },
    };

    const result = verifyPaidProviderHealthProof(healthy, strictPolicy, new Date('2026-05-02T21:30:00.000Z'));

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.eligibleProviders).toEqual([
      'did:voidly:AsAVzZ2dtMrntgGRco8KkW',
      'did:voidly:Eg8JvTNrBLcpbX3r461jJB',
    ]);
  });

  it('rejects otherwise healthy providers when x402 network, asset, or payTo are not buyer-allowlisted', () => {
    const tampered = {
      ...fixture,
      ok: true,
      summary: {
        providers_probed: 1,
        providers_ok: 1,
        providers_failing: 0,
        success_rate: 1,
      },
      providers: [
        {
          ...fixture.providers[2],
          x402_payment: {
            ...fixture.providers[2].x402_payment,
            network: 'base',
            asset: '0x0000000000000000000000000000000000000001',
            payTo: '0x3333333333333333333333333333333333333333',
          },
        },
      ],
      routing: { fail_closed: true, decision: 'allow', reason: ['Tampered proof for test.'] },
    };

    const result = verifyPaidProviderHealthProof(tampered, strictPolicy, new Date('2026-05-02T21:30:00.000Z'));

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'did:voidly:AsAVzZ2dtMrntgGRco8KkW: network=base is not allowed; asset=0x0000000000000000000000000000000000000001 is not allowed; payTo=0x3333333333333333333333333333333333333333 is not allowed.',
        'No provider passed status, stale streak, receipt, and x402 payment metadata checks.',
      ])
    );
  });
});
