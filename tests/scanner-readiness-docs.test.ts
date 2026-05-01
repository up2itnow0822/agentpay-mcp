import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const scannerDocs = readFileSync('docs/x402-scanner-readiness.md', 'utf8');
const demoServer = readFileSync('examples/x402-clean-demo/server.mjs', 'utf8');

describe('x402 scanner readiness docs', () => {
  it('requires the dedicated clean 402 demo endpoint as the primary scanner target', () => {
    expect(scannerDocs).toContain('/api/x402/demo');
    expect(scannerDocs).toContain('Do not rely on headers, sitemap entries, or Link headers alone');
    expect(scannerDocs).toContain('curl -si https://agentpay.example.com/api/x402/demo');
  });

  it('keeps the minimal demo route aligned with the documented scanner contract', () => {
    expect(demoServer).toContain('request.url === "/api/x402/demo"');
    expect(demoServer).toContain('PAYMENT-REQUIRED');
    expect(demoServer).toContain('"X-X402-Supported": "true"');
    expect(demoServer).toContain('402');
  });
});
