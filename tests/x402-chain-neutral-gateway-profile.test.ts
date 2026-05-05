import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildAgentPayChainNeutralGatewayProfile,
  inferX402NetworkNamespace,
  validateX402ChainNeutralGatewayProfile,
  type X402ChainNeutralGatewayProfile,
} from '../src/utils/x402-chain-neutral-gateway-profile.js';

const rugMunchFixture = JSON.parse(
  readFileSync(new URL('../docs/fixtures/chain-neutral-gateway-profile-rugmunch-2026-05-03.json', import.meta.url), 'utf8')
) as X402ChainNeutralGatewayProfile;

describe('x402 chain-neutral gateway profile', () => {
  it('infers EVM and non-EVM network namespaces without Base-only assumptions', () => {
    expect(inferX402NetworkNamespace('eip155:8453')).toBe('eip155');
    expect(inferX402NetworkNamespace('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe('solana');
    expect(inferX402NetworkNamespace('tvm:-239')).toBe('tvm');
    expect(inferX402NetworkNamespace('ton:mainnet')).toBe('ton');
    expect(inferX402NetworkNamespace('base')).toBe('other');
  });

  it('validates the AgentPay profile as chain-neutral but fail-closed for Solana extension points', () => {
    const report = validateX402ChainNeutralGatewayProfile(buildAgentPayChainNeutralGatewayProfile());
    expect(report.issues).toEqual([]);
    expect(report.hasEvmNetwork).toBe(true);
    expect(report.hasNonEvmNetwork).toBe(true);
    expect(report.networkNamespaces).toContain('eip155');
    expect(report.networkNamespaces).toContain('solana');
    expect(report.hasSettlementMetadata).toBe(true);
    expect(report.hasDirectoryManifests).toBe(true);
  });

  it('validates the Rug Munch fixture as a multi-network signal with manifest proof', () => {
    const report = validateX402ChainNeutralGatewayProfile(rugMunchFixture);
    expect(report.issues).toEqual([]);
    expect(report.hasEvmNetwork).toBe(true);
    expect(report.hasNonEvmNetwork).toBe(true);
    expect(report.networkNamespaces).toEqual(['eip155', 'solana']);
    expect(report.hasExplicitTrialPolicy).toBe(true);
    expect(report.hasExplicitRefundPolicy).toBe(true);
  });

  it('rejects profiles that hide payment headers, settlement, trial, refund, or directory metadata', () => {
    const broken = {
      ...buildAgentPayChainNeutralGatewayProfile(),
      paymentHeader: 'X-Payment',
      receiptHeader: 'x-payment-response',
      facilitator: undefined,
      settlement: { custody: 'unknown', description: '' },
      trial: { enabled: false, description: '' },
      refund: { supported: false, mode: 'none', description: '' },
      manifests: { wellKnownX402: 'http://example.com/.well-known/x402' },
      networks: [
        {
          network: 'base',
          name: 'Base',
          gateway: 'http://localhost:3000',
        },
      ],
    } as X402ChainNeutralGatewayProfile;

    const report = validateX402ChainNeutralGatewayProfile(broken);
    expect(report.issues).toContain('paymentHeader must be Payment-Signature');
    expect(report.issues).toContain('receiptHeader must be payment-response');
    expect(report.issues).toContain('networks[0].network should use a known CAIP-2 namespace');
    expect(report.issues).toContain('networks[0].gateway must be an https URL');
    expect(report.issues).toContain('manifests.wellKnownX402 must be an https URL');
    expect(report.issues).toContain('profile must include .well-known/x402 plus Glama, Smithery, or MCP catalog metadata');
    expect(report.issues).toContain('trial policy must be explicit, including no-trial cases');
    expect(report.issues).toContain('refund policy must be explicit, including no-refund cases');
    expect(report.issues).toContain('settlement metadata must identify custody or facilitator boundary');
  });
});
