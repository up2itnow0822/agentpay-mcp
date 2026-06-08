import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/directory-introspection-readiness.md', import.meta.url), 'utf8');
const proxyDoc = readFileSync(new URL('../docs/x402-native-vs-stripe-proxy.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const smithery = readFileSync(new URL('../smithery.yaml', import.meta.url), 'utf8');
const glama = readFileSync(new URL('../glama.json', import.meta.url), 'utf8');
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const cliEntry = fileURLToPath(new URL('../dist/index.js', import.meta.url));

describe('directory introspection readiness docs', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [tscBin], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
  });

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
    const version = spawnSync(process.execPath, [cliEntry, '--version'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    const help = spawnSync(process.execPath, [cliEntry, '--help'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    expect(version.status).toBe(0);
    expect(help.status).toBe(0);
    expect(version.stdout.trim()).toBe(packageJson.version);
    expect(help.stdout).toContain('Usage:');
    expect(help.stdout).toContain('--version');
    expect(`${version.stdout}\n${help.stdout}`).not.toContain('started.');
    expect(`${version.stderr}\n${help.stderr}`).not.toContain('started.');
  });
});
