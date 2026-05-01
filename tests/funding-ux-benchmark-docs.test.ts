import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/x402-mcp-funding-ux-benchmark.md', import.meta.url), 'utf8');

describe('x402 MCP funding UX benchmark docs', () => {
  it('does not claim agent-marketplace-mcp is live on npm', () => {
    expect(doc).toContain('npm view agent-marketplace-mcp` returned 404');
    expect(doc).toContain('public repo signal, not as a live npm package');
  });

  it('compares funding UX against AgentPay governance controls', () => {
    for (const required of [
      'approval gates',
      'daily caps',
      'auditability',
      'non-custodial',
      'hosted fund link',
      'optional Coinbase-managed mode',
      'Fail closed for unsupported networks',
    ]) {
      expect(doc).toContain(required);
    }
  });
});
