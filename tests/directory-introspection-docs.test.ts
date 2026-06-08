import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/directory-introspection-readiness.md', import.meta.url), 'utf8');
const proxyDoc = readFileSync(new URL('../docs/x402-native-vs-stripe-proxy.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
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

  it('documents x402-native proxy positioning and stable Glama proof', () => {
    for (const required of [
      'x402-native AgentPay MCP vs Stripe-proxy MCP patterns',
      'policy approval can be required before signing',
      'https://glama.ai/mcp/servers/up2itnow0822/claw-pay-mcp',
      '27 MCP tools',
      'Lightning Wallet MCP comparison',
      'Glama MCP Server',
      'docs/x402-native-vs-stripe-proxy.md',
      'agentpay-mcp@4.1.9',
    ]) {
      expect(`${proxyDoc}\n${readme}`).toContain(required);
    }
  });

  it('keeps runtime MCP version aligned with package metadata', () => {
    expect(indexSource).toContain('const PACKAGE_VERSION = packageJson.version;');
    expect(indexSource).toContain('version: PACKAGE_VERSION');
    expect(indexSource).toContain('AgentPay MCP v${PACKAGE_VERSION} started.');
  });

  it('prints CLI metadata without starting the MCP server', () => {
    const version = execFileSync('node', ['dist/index.js', '--version'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });
    const help = execFileSync('node', ['dist/index.js', '--help'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });

    expect(version.trim()).toBe(packageJson.version);
    expect(help).toContain('Usage:');
    expect(help).toContain('--version');
    expect(`${version}\n${help}`).not.toContain('started.');
  });
});
