import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/paid-provider-health-proof.md', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../docs/paid-provider-health-proof.schema.json', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('../docs/fixtures/paid-provider-health-proof-voidly-2026-05-02.json', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/utils/paid-provider-health-proof.ts', import.meta.url), 'utf8');

describe('paid-provider health proof docs', () => {
  it('documents the buyer proof gates and Voidly reliability signal', () => {
    for (const required of [
      'Voidly Pay',
      'success_rate: 0.4',
      'stale failure streaks of 207, 207, and 312',
      'receipt_state',
      'x402_payment',
      'network',
      'asset',
      'payTo',
      'fail_closed',
      'verifyPaidProviderHealthProof',
    ]) {
      expect(doc).toContain(required);
    }
  });

  it('ships schema, fixture, source helper, and README link', () => {
    expect(schema).toContain('agentpay-paid-provider-health-proof/v1');
    expect(fixture).toContain('providers_probed');
    expect(fixture).toContain('success_rate');
    expect(source).toContain('PaidProviderHealthProofSchema');
    expect(source).toContain('verifyPaidProviderHealthProof');
    expect(readme).toContain('docs/paid-provider-health-proof.md');
  });
});
