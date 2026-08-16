#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const expectedViem = '2.52.2';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function run(command, args, options = {}) {
  let executable = command;
  let spawnArgs = args;
  let shell = false;
  if (process.platform === 'win32' && command === 'npm') {
    if (process.env['npm_execpath']) {
      executable = process.execPath;
      spawnArgs = [process.env['npm_execpath'], ...args];
    } else {
      executable = 'npm.cmd';
      shell = true;
    }
  }

  const result = spawnSync(executable, spawnArgs, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    maxBuffer: 10 * 1024 * 1024,
    shell,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });

  if (result.error || result.status !== 0) {
    const stdout = result.stdout ? `\nstdout:\n${result.stdout}` : '';
    const stderr = result.stderr ? `\nstderr:\n${result.stderr}` : '';
    const cause = result.error ? `${result.error.name}: ${result.error.message}` : `exit ${result.status}`;
    throw new Error(`${executable} ${spawnArgs.join(' ')} failed with ${cause}.${stdout}${stderr}`);
  }

  return result;
}

assert(packageJson.dependencies?.viem === expectedViem, `dependencies.viem must be exactly ${expectedViem}`);
assert(packageJson.overrides?.viem === expectedViem, `overrides.viem must be exactly ${expectedViem}`);
assert(!/^[~^><=*]|latest|workspace|file:/.test(packageJson.dependencies.viem), 'viem must not use a floating or non-registry range');

const smokeRoot = mkdtempSync(join(tmpdir(), 'agentpay-clean-install-'));
const smokePackDir = join(smokeRoot, 'pack');
const smokeAppDir = join(smokeRoot, 'consumer');

try {
  mkdirSync(smokePackDir, { recursive: true });
  mkdirSync(smokeAppDir, { recursive: true });
  const pack = run('npm', ['pack', '--json', '--pack-destination', smokePackDir], { cwd: repoRoot });
  const packJson = JSON.parse(pack.stdout);
  const tarball = join(smokePackDir, packJson[0].filename);

  writeFileSync(
    join(smokeAppDir, 'package.json'),
    JSON.stringify({ private: true, name: 'agentpay-clean-install-smoke', dependencies: { 'agentpay-mcp': `file:${tarball}` } }, null, 2) + '\n'
  );

  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: smokeAppDir });

  const smoke = `
    const fs = require('fs');
    const viemPkg = require('viem/package.json');
    const agentpayPkg = require('agentpay-mcp/package.json');
    const agentpayDist = fs.readFileSync(require.resolve('agentpay-mcp'), 'utf8');
    if (viemPkg.version !== '${expectedViem}') throw new Error('resolved viem ' + viemPkg.version);
    if (!agentpayDist.includes('AgentPay MCP v' + agentpayPkg.version + ' started.')) throw new Error('packed dist banner does not match package version ' + agentpayPkg.version);
    const { createWalletClient, http, parseEther, formatUnits } = require('viem');
    const { privateKeyToAccount } = require('viem/accounts');
    const { base, baseSepolia } = require('viem/chains');
    const x402 = require('agentpay-mcp/dist/tools/x402.js');
    const clientUtils = require('agentpay-mcp/dist/utils/client.js');
    const privateKey = '0x59c6995e998f97a5a0044966f094538a827fb7fe6bfe7eda4cbaef250f7892f6';
    const account = privateKeyToAccount(privateKey);
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });
    const parsed = x402.X402PaySchema.safeParse({ url: 'https://example.com/paid', max_payment_eth: '0.001', timeout_ms: 1000 });
    if (!parsed.success) throw new Error('x402 schema import failed');
    if (x402.x402PayTool.name !== 'x402_pay') throw new Error('x402 tool import failed');
    if (typeof clientUtils.createAgentWallet !== 'function') throw new Error('wallet client utility import failed');
    if (base.id !== 8453 || baseSepolia.id !== 84532) throw new Error('Base chain imports failed');
    console.log(JSON.stringify({ viem: viemPkg.version, account: account.address, tool: x402.x402PayTool.name, wei: parseEther('0.001').toString(), formatted: formatUnits(1_000_000n, 6), chain: walletClient.chain.id }));
  `;

  const result = run('node', ['-e', smoke], { cwd: smokeAppDir });
  process.stdout.write(result.stdout);
} finally {
  rmSync(smokeRoot, { recursive: true, force: true });
}
