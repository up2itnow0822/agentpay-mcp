import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/x402-tvm-readiness.md', import.meta.url), 'utf8');

describe('x402 TVM readiness docs', () => {
  it('documents TVM as watch-only and fail-closed', () => {
    expect(doc).toContain('network: "tvm:-3"');
    expect(doc).toContain('fails closed');
    expect(doc).toContain('Unsupported x402 Payment Requirement - Failed Closed');
    expect(doc).toContain('No TVM signing, account deployment, faucet, gas, jetton, or facilitator settlement path is enabled');
  });

  it('includes a multi-rail support matrix and implementation proof', () => {
    for (const required of [
      'Base EVM exact payment',
      'Solana x402',
      'x402 batch settlement',
      'TVM/TON exact payment',
      'CHAIN_ID=8453',
      'CHAIN_ID=84532',
    ]) {
      expect(doc).toContain(required);
    }
  });
});
