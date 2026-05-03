import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lockJson = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../docs/dependency-pin-policy.md', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../scripts/clean-install-x402-smoke.mjs', import.meta.url), 'utf8');

const expectedViem = '2.48.7';

describe('payment-critical dependency pin policy', () => {
  it('pins viem exactly in package metadata and lockfile', () => {
    expect(packageJson.dependencies.viem).toBe(expectedViem);
    expect(packageJson.overrides.viem).toBe(expectedViem);
    expect(packageJson.dependencies.viem).not.toMatch(/^[~^><=*]|latest|workspace|file:/);
    expect(lockJson.packages[''].dependencies.viem).toBe(expectedViem);
    expect(packageJson.overrides.viem).toBe(expectedViem);
    expect(lockJson.packages['node_modules/viem'].version).toBe(expectedViem);
  });

  it('documents the release gate for payment-critical crypto libraries', () => {
    for (const required of [
      'Payment-critical dependency pin policy',
      '`viem`: pinned exactly to `2.48.7`',
      'x402 payment-required parsing',
      'receipt, transaction, or payment envelope validation',
      'npm run smoke:clean-install',
      'clean-install smoke',
      'Do not relax this policy',
    ]) {
      expect(policy).toContain(required);
    }

    expect(readme).toContain('docs/dependency-pin-policy.md');
    expect(readme).toContain('AgentPay pins `viem` exactly at `2.48.7`');
  });

  it('smoke script imports the x402 verifier path from a fresh packed install', () => {
    for (const required of [
      "run('npm', ['pack'",
      "run('npm', ['install'",
      "require('viem/package.json')",
      "require('viem/accounts')",
      "require('viem/chains')",
      "require('agentpay-mcp/dist/tools/x402.js')",
      "require('agentpay-mcp/dist/utils/client.js')",
      'createAgentWallet',
      'X402PaySchema.safeParse',
    ]) {
      expect(smoke).toContain(required);
    }
  });
});
