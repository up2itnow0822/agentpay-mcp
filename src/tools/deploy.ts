/**
 * deploy_wallet tool — Deploy a new AgentAccountV2 wallet via the factory.
 * Requires FACTORY_ADDRESS and NFT_CONTRACT_ADDRESS env vars.
 */
import { z } from 'zod';
import { type Address, createPublicClient, createWalletClient, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { deployWallet } from 'agentwallet-sdk';
import { loadSignerConfig } from '../utils/client.js';
import { textContent, explorerAddressUrl, explorerTxUrl, chainName, formatError } from '../utils/format.js';

// ─── Schema ────────────────────────────────────────────────────────────────

export const DeployWalletSchema = z.object({
  token_id: z
    .string()
    .describe('NFT token ID that will own the deployed wallet (e.g. "1")'),
  nft_contract_address: z
    .string()
    .optional()
    .describe(
      'NFT contract address that owns this wallet. ' +
      'Defaults to NFT_CONTRACT_ADDRESS env var.'
    ),
  factory_address: z
    .string()
    .optional()
    .describe(
      'AgentAccountFactoryV2 address. ' +
      'Defaults to FACTORY_ADDRESS env var.'
    ),
});

export type DeployWalletInput = z.infer<typeof DeployWalletSchema>;

// ─── Tool definition ───────────────────────────────────────────────────────

export const deployWalletTool = {
  name: 'deploy_wallet',
  description:
    'Deploy a new AgentAccountV2 wallet via the factory contract. ' +
    'The wallet is deterministically addressed (CREATE2) and owned by an NFT. ' +
    'Returns the wallet address and deployment transaction hash. ' +
    'Requires FACTORY_ADDRESS and NFT_CONTRACT_ADDRESS env vars (or pass them as arguments).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      token_id: {
        type: 'string',
        description: 'NFT token ID that will own this wallet (e.g. "1")',
      },
      nft_contract_address: {
        type: 'string',
        description: 'NFT contract address. Defaults to NFT_CONTRACT_ADDRESS env var.',
      },
      factory_address: {
        type: 'string',
        description: 'Factory contract address. Defaults to FACTORY_ADDRESS env var.',
      },
    },
    required: ['token_id'],
  },
};

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleDeployWallet(
  input: DeployWalletInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    // deploy_wallet creates the identity, so it must not require one yet.
    const config = loadSignerConfig();

    const factoryAddress = (input.factory_address ?? config.factoryAddress) as Address | undefined;
    if (!factoryAddress) {
      throw new Error(
        'Factory address required. Pass factory_address argument or set FACTORY_ADDRESS env var.'
      );
    }

    const nftContractAddress = (input.nft_contract_address ?? config.nftContractAddress) as Address | undefined;
    if (!nftContractAddress) {
      throw new Error(
        'NFT contract address required. Pass nft_contract_address argument or set NFT_CONTRACT_ADDRESS env var.'
      );
    }

    const tokenId = BigInt(input.token_id);

    const chainMap: Record<number, typeof base | typeof baseSepolia> = {
      8453: base,
      84532: baseSepolia,
    };
    const chainNameMap: Record<number, 'base' | 'base-sepolia'> = {
      8453: 'base',
      84532: 'base-sepolia',
    };

    const chain = chainMap[config.chainId];
    if (!chain) {
      throw new Error(`Unsupported chain for deployment: ${config.chainId}`);
    }

    const account = privateKeyToAccount(config.agentPrivateKey);
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(config.rpcUrl, { timeout: 30_000 }),
    });

    const result = await deployWallet({
      factoryAddress,
      tokenContract: nftContractAddress,
      tokenId,
      chain: chainNameMap[config.chainId] ?? 'base',
      rpcUrl: config.rpcUrl,
      walletClient,
    });

    // Runtime code hash for AGENT_WALLET_CODE_HASH (best effort, read-only).
    let codeHashLine = '(could not read yet; set it to keccak256 of the wallet runtime code)';
    try {
      const code = await createPublicClient({ chain, transport: http(config.rpcUrl, { timeout: 30_000 }) })
        .getCode({ address: result.walletAddress });
      if (code && code !== '0x') codeHashLine = keccak256(code);
    } catch {
      // Keep the placeholder; never echo the RPC error (it may name the RPC URL).
    }

    const explorerAddr = explorerAddressUrl(result.walletAddress, config.chainId);
    const explorerTx = explorerTxUrl(result.txHash, config.chainId);
    const cname = chainName(config.chainId);

    return {
      content: [
        textContent(
          `✅ Agent Wallet deployed successfully!\n\n` +
          `📍 Wallet Address: ${result.walletAddress}\n` +
          `🔗 Explorer: ${explorerAddr}\n\n` +
          `📋 Transaction: ${result.txHash}\n` +
          `🔗 Explorer: ${explorerTx}\n\n` +
          `🔑 Owner NFT: ${nftContractAddress} #${input.token_id}\n` +
          `🌐 Chain: ${cname}\n\n` +
          `ℹ️  Next steps:\n` +
          `  1. Set the wallet and its deployment identity in your .env (public values, not secrets):\n` +
          `     AGENT_WALLET_ADDRESS=${result.walletAddress}\n` +
          `     AGENT_WALLET_FACTORY=${factoryAddress}\n` +
          `     AGENT_WALLET_TOKEN_CONTRACT=${nftContractAddress}\n` +
          `     AGENT_WALLET_TOKEN_ID=${tokenId.toString()}\n` +
          `     AGENT_WALLET_CODE_HASH=${codeHashLine}   (strongly recommended)\n` +
          `  2. Use set_spend_policy (via SDK) to configure autonomous spending limits\n` +
          `  3. Fund the wallet with ETH or USDC for agent payments`
        ),
      ],
    };
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'deploy_wallet'))],
      isError: true,
    };
  }
}
