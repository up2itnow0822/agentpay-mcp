import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/hosted-x402-proxy-verification.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/utils/hosted-proxy-verification.ts', import.meta.url), 'utf8');

describe('hosted x402 proxy verification docs', () => {
  it('documents the buyer-side checklist for hosted x402 MCP gateways', () => {
    for (const required of [
      'payment-required',
      'non-zero',
      'payTo',
      'Network is allowlisted',
      'Asset is allowlisted',
      'Amount is under the spend cap',
      'Approval gate is satisfied',
      'Audit log is ready',
      'Pooled-token lock-in is explicit',
    ]) {
      expect(doc).toContain(required);
    }
  });

  it('keeps Toolstem claims bounded to verified live HTTP and public code signals', () => {
    expect(doc).toContain('Toolstem moved from a minimal proxy README to public Cloudflare Worker code');
    expect(doc).toContain('returned HTTP 200');
    expect(doc).toContain('returned HTTP 402');
    expect(doc).toContain('zero address');
    expect(doc).toContain('preflight evidence, not a broad verdict on Toolstem');
    expect(doc).toContain('It is not a claim about production maturity');
  });

  it('links the checklist from the README and backs it with a testable helper', () => {
    expect(readme).toContain('docs/hosted-x402-proxy-verification.md');
    expect(source).toContain('verifyHostedProxyPaymentRequirement');
    expect(source).toContain('upstreamCredentialMode');
    expect(source).toContain('pooled-token lock-in');
  });
});
