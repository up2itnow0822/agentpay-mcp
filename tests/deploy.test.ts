/**
 * Tests for deploy_wallet tool.
 * All SDK calls are mocked — no real network required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

vi.mock('agentwallet-sdk', () => ({
  deployWallet: vi.fn(),
  createWallet: vi.fn(),
}));

// ─── Mock viem ─────────────────────────────────────────────────────────────

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createWalletClient: vi.fn(() => ({ account: { address: '0xagent' } })),
    http: vi.fn(() => 'mock-transport'),
    createPublicClient: vi.fn(() => ({ getCode: vi.fn(async () => '0x6080604052') })),
  };
});

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({ address: '0xagent', type: 'local' })),
}));

vi.mock('viem/chains', () => ({
  base: { id: 8453, name: 'Base' },
  baseSepolia: { id: 84532, name: 'Base Sepolia' },
}));

// ─── Mock client utils ─────────────────────────────────────────────────────

vi.mock('../src/utils/client.js', () => ({
  loadSignerConfig: vi.fn(() => ({
    agentPrivateKey: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    walletAddress: '0x1234567890123456789012345678901234567890',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    factoryAddress: undefined,
    nftContractAddress: undefined,
  })),
  getWallet: vi.fn(() => ({
    address: '0x1234567890123456789012345678901234567890',
    publicClient: {},
    walletClient: {},
  })),
  _resetSingletons: vi.fn(),
}));

import { handleDeployWallet } from '../src/tools/deploy.js';
import { deployWallet } from 'agentwallet-sdk';

const mockDeployWallet = vi.mocked(deployWallet);

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('deploy_wallet tool', () => {
  const MOCK_FACTORY = '0xfactory000000000000000000000000000000000';
  const MOCK_NFT = '0xnftcontract0000000000000000000000000000';
  const MOCK_WALLET = '0xdeployed000000000000000000000000000000';
  const MOCK_TX = '0xdeploymenttx0000000000000000000000000000000000000000000000000000';

  beforeEach(() => {
    vi.clearAllMocks();
    mockDeployWallet.mockResolvedValue({
      walletAddress: MOCK_WALLET as `0x${string}`,
      txHash: MOCK_TX as `0x${string}`,
    });
  });

  // ─── Happy path ────────────────────────────────────────────────────────

  it('deploys wallet and returns address + tx hash', async () => {
    const result = await handleDeployWallet({
      token_id: '1',
      factory_address: MOCK_FACTORY,
      nft_contract_address: MOCK_NFT,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.text).toContain('deployed successfully');
    expect(result.content[0]!.text).toContain(MOCK_WALLET);
    expect(result.content[0]!.text).toContain(MOCK_TX);
  });

  it('calls deployWallet SDK with correct parameters', async () => {
    await handleDeployWallet({
      token_id: '42',
      factory_address: MOCK_FACTORY,
      nft_contract_address: MOCK_NFT,
    });

    expect(mockDeployWallet).toHaveBeenCalledOnce();
    const callArgs = mockDeployWallet.mock.calls[0]![0];
    expect(callArgs.tokenId).toBe(42n);
    expect(callArgs.factoryAddress).toBe(MOCK_FACTORY);
    expect(callArgs.tokenContract).toBe(MOCK_NFT);
  });

  it('includes explorer URL in success response', async () => {
    const result = await handleDeployWallet({
      token_id: '1',
      factory_address: MOCK_FACTORY,
      nft_contract_address: MOCK_NFT,
    });

    expect(result.content[0]!.text).toContain('basescan.org');
  });

  it('includes next steps in response', async () => {
    const result = await handleDeployWallet({
      token_id: '1',
      factory_address: MOCK_FACTORY,
      nft_contract_address: MOCK_NFT,
    });

    expect(result.content[0]!.text).toContain('AGENT_WALLET_ADDRESS');
  });

  it('prints all four deployment-identity values so the user can pin them (SO C2)', async () => {
    const result = await handleDeployWallet({
      token_id: '7',
      factory_address: MOCK_FACTORY,
      nft_contract_address: MOCK_NFT,
    });
    const text = result.content[0]!.text;
    expect(text).toContain(`AGENT_WALLET_FACTORY=${MOCK_FACTORY}`);
    expect(text).toContain(`AGENT_WALLET_TOKEN_CONTRACT=${MOCK_NFT}`);
    expect(text).toContain('AGENT_WALLET_TOKEN_ID=7');
    expect(text).toMatch(/AGENT_WALLET_CODE_HASH=0x[0-9a-f]{64}/);
    expect(text).not.toContain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(text).not.toContain('mainnet.base.org');
  });

  // ─── Error paths ───────────────────────────────────────────────────────

  it('returns error when factory_address is missing', async () => {
    const result = await handleDeployWallet({
      token_id: '1',
      // no factory_address, no env var
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('❌');
    expect(result.content[0]!.text).toMatch(/[Ff]actory/);
  });

  it('returns error when nft_contract_address is missing', async () => {
    const result = await handleDeployWallet({
      token_id: '1',
      factory_address: MOCK_FACTORY,
      // no nft_contract_address
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('❌');
    expect(result.content[0]!.text).toMatch(/[Nn][Ff][Tt]/);
  });

  it('handles SDK errors gracefully', async () => {
    mockDeployWallet.mockRejectedValueOnce(new Error('RPC connection refused'));

    const result = await handleDeployWallet({
      token_id: '1',
      factory_address: MOCK_FACTORY,
      nft_contract_address: MOCK_NFT,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('RPC connection refused');
    expect(result.content[0]!.text).toContain('❌');
  });

  it('handles invalid token_id gracefully', async () => {
    // BigInt('not-a-number') will throw
    const result = await handleDeployWallet({
      token_id: 'not-a-number',
      factory_address: MOCK_FACTORY,
      nft_contract_address: MOCK_NFT,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('❌');
  });
});

// ─── Config validation unit tests ─────────────────────────────────────────

describe('deploy_wallet input validation', () => {
  it('returns error with helpful message when factory_address is missing', async () => {
    const result = await handleDeployWallet({
      token_id: '1',
      // no factory_address, no env var configured in mock
    });

    expect(result.isError).toBe(true);
    // Should mention what's missing
    expect(result.content[0]!.text.toLowerCase()).toMatch(/factory/);
  });

  it('returns error with helpful message when nft_contract missing', async () => {
    const result = await handleDeployWallet({
      token_id: '1',
      factory_address: '0xfactory000000000000000000000000000000000',
      // no nft_contract_address, no env var configured in mock
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toMatch(/nft|token/i);
  });
});
