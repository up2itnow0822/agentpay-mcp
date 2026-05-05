import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const docs = readFileSync(new URL('../docs/x402-chain-neutral-gateway-profile.md', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../docs/x402-chain-neutral-gateway-profile.schema.json', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('../docs/fixtures/chain-neutral-gateway-profile-rugmunch-2026-05-03.json', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/utils/x402-chain-neutral-gateway-profile.ts', import.meta.url), 'utf8');

describe('chain-neutral x402 gateway profile docs', () => {
  it('documents network, facilitator, trial, refund, and manifest proof requirements', () => {
    for (const required of [
      'CAIP-2-style names',
      '`eip155:8453`',
      '`solana:<cluster>`',
      '`Payment-Signature`',
      '`payment-response`',
      'facilitator',
      'trial',
      'refund',
      'Glama',
      'Smithery',
      '.well-known/x402',
      'Base-only assumption',
    ]) {
      expect(docs).toContain(required);
    }
  });

  it('packages schema and fixture artifacts for directory crawlers and buyer agents', () => {
    expect(packageJson.files).toContain('docs/*.json');
    expect(packageJson.files).toContain('docs/fixtures/*.json');
    expect(readme).toContain('docs/x402-chain-neutral-gateway-profile.md');
    expect(schema).toContain('x402 chain-neutral gateway profile');
    expect(fixture).toContain('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');
    expect(fixture).toContain('https://facilitator.payai.network');
  });

  it('keeps non-EVM support explicit instead of silently falling back to Base', () => {
    expect(source).toContain("network: 'solana:extension-point'");
    expect(source).toContain('fail-closed until Solana signing');
    expect(docs).toContain('must not advertise signing support');
    expect(docs).toContain('unsupported Solana terms do not fall back to Base silently');
  });
});
