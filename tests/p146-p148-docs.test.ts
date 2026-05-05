import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readDoc(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('P-146/P-147/P-148 docs', () => {
  it('documents multi-ledger receipt normalization fields and unsupported-ledger refusal copy', () => {
    const doc = readDoc('../docs/x402-multi-ledger-receipt-normalization.md');
    expect(doc).toContain('ledger label');
    expect(doc).toContain('settlement target');
    expect(doc).toContain('Payment-Signature');
    expect(doc).toContain('payment-response');
    expect(doc).toContain('unsupported-ledger refusal');
  });

  it('documents simulate-first wallet-action controls', () => {
    const doc = readDoc('../docs/wallet-action-preflight-profile.md');
    expect(doc).toContain('simulate-first');
    expect(doc).toContain('chain/resource caps');
    expect(doc).toContain('recipient and amount confirmation');
    expect(doc).toContain('approval copy');
  });

  it('creates an AgentPay machine-payment directory listing pack', () => {
    const doc = readDoc('../docs/agentpay-machine-payment-directory-listing-pack.md');
    const listing = readDoc('../docs/agentpay-machine-payment-directory-listing.json');
    expect(doc).toContain('agentpay-mcp');
    expect(doc).toContain('x402-only settlement wording');
    expect(doc).toContain('npm install agentpay-mcp');
    expect(listing).toContain('non-custodial');
    expect(listing).toContain('x402');
  });
});
