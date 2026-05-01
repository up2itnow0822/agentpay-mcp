import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/directory-introspection-readiness.md', import.meta.url), 'utf8');
const smithery = readFileSync(new URL('../smithery.yaml', import.meta.url), 'utf8');
const glama = readFileSync(new URL('../glama.json', import.meta.url), 'utf8');

describe('directory introspection readiness docs', () => {
  it('documents the catalog install paths and MCP identity', () => {
    for (const required of [
      'agentpay-mcp',
      'io.github.up2itnow0822/agentpay',
      'npx',
      'docker build -t agentpay-mcp:glama-introspection .',
      'tools/list',
      'x402_pay',
      'glama.json',
      'https://glama.ai/mcp/servers/up2itnow0822/claw-pay-mcp',
    ]) {
      expect(doc).toContain(required);
    }
  });

  it('preserves non-custodial defaults for directory metadata', () => {
    for (const required of [
      'does not create or manage a hot wallet by default',
      'does not ask a catalog to custody keys',
      'AGENT_PRIVATE_KEY stays local',
      'do not claim a live Smithery listing until Smithery verifies it',
    ]) {
      expect(doc).toContain(required);
    }
  });

  it('declares Glama catalog metadata', () => {
    expect(glama).toContain('https://glama.ai/mcp/schemas/server.json');
    expect(glama).toContain('up2itnow0822');
    expect(doc).toContain('Glama metadata');
  });

  it('marks sensitive Smithery config as operator supplied', () => {
    expect(smithery).toContain('format: password');
    expect(smithery).toContain('AGENT_PRIVATE_KEY');
    expect(smithery).toContain('AGENT_WALLET_ADDRESS');
    expect(smithery).toContain('enum: ["8453", "84532"]');
    expect(smithery).toContain('AgentPay MCP remains non-custodial');
  });
});
