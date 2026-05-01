/**
 * x402 chain-drift smoke coverage.
 *
 * x402 Foundation paywall templates track viem chain definitions. AgentPay MCP
 * must stay on a viem baseline that can see newly emitted chains, while still
 * failing closed until AgentPay explicitly maps and funds those chains.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { megaeth, mezo, radius, stable } from 'viem/chains';
import { _resetSingletons, loadConfig } from '../src/utils/client.js';

const REQUIRED_ENV = {
  AGENT_PRIVATE_KEY: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  AGENT_WALLET_ADDRESS: '0x1234567890123456789012345678901234567890',
};

const watchedX402Chains = [
  { label: 'Mezo', chain: mezo, chainId: 31612 },
  { label: 'MegaETH', chain: megaeth, chainId: 4326 },
  { label: 'Stable', chain: stable, chainId: 988 },
  { label: 'Radius', chain: radius, chainId: 723487 },
] as const;

describe('x402 chain-drift compatibility', () => {
  afterEach(() => {
    delete process.env['AGENT_PRIVATE_KEY'];
    delete process.env['AGENT_WALLET_ADDRESS'];
    delete process.env['CHAIN_ID'];
    delete process.env['RPC_URL'];
    _resetSingletons();
  });

  it('uses a viem baseline that exposes the x402 Foundation watched chain definitions', () => {
    expect(watchedX402Chains).toEqual([
      expect.objectContaining({ label: 'Mezo', chainId: 31612 }),
      expect.objectContaining({ label: 'MegaETH', chainId: 4326 }),
      expect.objectContaining({ label: 'Stable', chainId: 988 }),
      expect.objectContaining({ label: 'Radius', chainId: 723487 }),
    ]);

    for (const { chain, chainId, label } of watchedX402Chains) {
      expect(chain.id, label).toBe(chainId);
      expect(chain.name, label).toEqual(expect.any(String));
      expect(chain.nativeCurrency, label).toBeDefined();
      expect(chain.rpcUrls.default.http.length, label).toBeGreaterThan(0);
    }
  });

  it('fails closed instead of coercing watched x402 chains to Base', () => {
    for (const { chainId, label } of watchedX402Chains) {
      Object.assign(process.env, REQUIRED_ENV, { CHAIN_ID: String(chainId) });
      _resetSingletons();

      expect(() => loadConfig(), label).toThrow(
        `Unsupported CHAIN_ID: ${chainId}. Supported values: 8453 (Base Mainnet), 84532 (Base Sepolia).`
      );
    }
  });

  it('rejects TVM chain identifiers with explicit fail-closed guidance', () => {
    Object.assign(process.env, REQUIRED_ENV, { CHAIN_ID: 'tvm:-3' });
    _resetSingletons();

    expect(() => loadConfig()).toThrow(
      'Unsupported CHAIN_ID: "tvm:-3". AgentPay MCP currently supports 8453 (Base Mainnet) and 84532 (Base Sepolia) for x402 exact payments.'
    );
  });
});
