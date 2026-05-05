import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readDoc(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('P-149/P-150/P-151 market-intel docs', () => {
  it('maps the five-tool x402 grammar to AgentPay controls', () => {
    const doc = readDoc('../docs/agentpay-five-tool-parity-proof.md');
    const proof = readDoc('../docs/agentpay-five-tool-parity-proof.json');
    for (const tool of ['x402_search', 'x402_check', 'x402_fetch', 'x402_wallet', 'x402_pay']) {
      expect(doc).toContain(tool);
      expect(proof).toContain(tool);
    }
    expect(doc).toContain('local signer');
    expect(doc).toContain('fail closed');
  });

  it('keeps x402 payment authorization separate from task escrow and reputation', () => {
    const doc = readDoc('../docs/agentpay-escrow-reputation-boundary.md');
    expect(doc).toContain('Payment authorization does not prove');
    expect(doc).toContain('create_escrow');
    expect(doc).toContain('Work proof');
    expect(doc).toContain('Integration rule');
  });

  it('ships a paid proxy and discovery readiness listing pack', () => {
    const doc = readDoc('../docs/paid-mcp-proxy-discovery-readiness.md');
    const listing = readDoc('../docs/agentpay-paid-proxy-discovery-listing.json');
    expect(doc).toContain('Toolstem');
    expect(doc).toContain('Cinderwright');
    expect(doc).toContain('Discovery insertion checklist');
    expect(listing).toContain('buyer-side x402 payment-control layer');
    expect(listing).toContain('automatic non-EVM signing');
  });

  it('links the new proof docs from README and llms.txt', () => {
    const readme = readDoc('../README.md');
    const llms = readDoc('../llms.txt');
    for (const path of [
      'docs/agentpay-five-tool-parity-proof.md',
      'docs/agentpay-escrow-reputation-boundary.md',
      'docs/paid-mcp-proxy-discovery-readiness.md',
    ]) {
      expect(readme).toContain(path);
      expect(llms).toContain(path);
    }
  });
});
