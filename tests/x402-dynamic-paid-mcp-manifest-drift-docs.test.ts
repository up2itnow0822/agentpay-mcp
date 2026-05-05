import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const docs = readFileSync(new URL('../docs/x402-dynamic-paid-mcp-manifest-drift.md', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../docs/x402-dynamic-paid-mcp-manifest-drift.schema.json', import.meta.url), 'utf8');
const latestFixture = readFileSync(new URL('../docs/fixtures/dynamic-paid-mcp-manifest-rugmunch-2026-05-04.json', import.meta.url), 'utf8');
const baselineFixture = readFileSync(new URL('../docs/fixtures/dynamic-paid-mcp-manifest-rugmunch-2026-05-04-baseline.json', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/utils/x402-dynamic-paid-mcp-manifest-drift.ts', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('dynamic paid MCP manifest drift docs', () => {
  it('documents the buyer-safety fields that can drift after launch', () => {
    expect(docs).toContain('Snapshot age');
    expect(docs).toContain('Tool and service counts');
    expect(docs).toContain('Trial policy');
    expect(docs).toContain('Pricing fields');
    expect(docs).toContain('Supported networks');
    expect(docs).toContain('Directory endpoints');
  });

  it('packages schema and Rug Munch fixtures', () => {
    expect(schema).toContain('dynamic paid MCP manifest snapshot');
    expect(latestFixture).toContain('184');
    expect(latestFixture).toContain('No free trials - pay per call from $0.01 USDC');
    expect(baselineFixture).toContain('175');
    expect(baselineFixture).toContain('One trial call available before paid calls');
  });

  it('links the proof from README and source catches static assumptions', () => {
    expect(readme).toContain('docs/x402-dynamic-paid-mcp-manifest-drift.md');
    expect(source).toContain('assertNoStaticPaidMcpManifestAssumptions');
    expect(source).toContain('mcp.totalTools');
    expect(source).toContain('trial.enabled');
  });
});
