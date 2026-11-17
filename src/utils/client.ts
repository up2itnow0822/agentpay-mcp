/**
 * AgentWalletClient setup for AgentPay MCP.
 * Reads config from environment variables and creates a configured wallet instance.
 */
import { createWalletClient, http, type Address, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { createWallet } from 'agentwallet-sdk';

// ─── Supported chains ──────────────────────────────────────────────────────

const CHAIN_MAP: Record<number, Chain> = {
  8453: base,
  84532: baseSepolia,
};

const CHAIN_NAME_MAP: Record<number, 'base' | 'base-sepolia'> = {
  8453: 'base',
  84532: 'base-sepolia',
};

const DEFAULT_RPC: Record<number, string> = {
  8453: 'https://mainnet.base.org',
  84532: 'https://sepolia.base.org',
};

// ─── Config types ──────────────────────────────────────────────────────────

export interface AgentPayConfig {
  /** Agent hot wallet private key (0x-prefixed hex) */
  agentPrivateKey: `0x${string}`;
  /** Deployed AgentAccountV2 address */
  walletAddress: Address;
  /** Chain ID (default: 8453 Base Mainnet) */
  chainId: number;
  /** RPC URL (falls back to public Base RPC) */
  rpcUrl: string;
  /** Factory address (for deploy_wallet tool only) */
  factoryAddress?: Address;
  /** NFT contract address (for deploy_wallet tool only) */
  nftContractAddress?: Address;
}

// ─── Config loader ─────────────────────────────────────────────────────────

/**
 * Load configuration from environment variables.
 * Only AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS are required to get started.
 */
export function loadConfig(): AgentPayConfig {
  const agentPrivateKey = process.env['AGENT_PRIVATE_KEY'];
  const walletAddress = process.env['AGENT_WALLET_ADDRESS'];

  if (!agentPrivateKey) {
    throw new Error(
      'AGENT_PRIVATE_KEY environment variable is required. ' +
      'Set it to the agent hot wallet private key (0x-prefixed hex).'
    );
  }

  if (!walletAddress) {
    throw new Error(
      'AGENT_WALLET_ADDRESS environment variable is required. ' +
      'Set it to the deployed AgentAccountV2 contract address.'
    );
  }

  if (!agentPrivateKey.startsWith('0x') || agentPrivateKey.length !== 66) {
    throw new Error(
      'AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string (66 chars total).'
    );
  }

  if (!walletAddress.startsWith('0x') || walletAddress.length !== 42) {
    throw new Error(
      'AGENT_WALLET_ADDRESS must be a 0x-prefixed 20-byte hex string (42 chars total).'
    );
  }

  const chainIdRaw = process.env['CHAIN_ID'] ?? '8453';
  if (!/^\d+$/.test(chainIdRaw)) {
    throw new Error(
      `Unsupported CHAIN_ID: "${chainIdRaw}". AgentPay MCP currently supports ` +
      '8453 (Base Mainnet) and 84532 (Base Sepolia) for x402 exact payments. ' +
      'TVM/TON values such as "tvm:-3" are watch-only and fail closed until ' +
      'AgentPay adds deliberate TVM signing, gas, jetton, wallet deployment, and settlement support.'
    );
  }

  const chainId = parseInt(chainIdRaw, 10);
  if (!CHAIN_MAP[chainId]) {
    throw new Error(
      `Unsupported CHAIN_ID: ${chainId}. Supported values: 8453 (Base Mainnet), 84532 (Base Sepolia).`
    );
  }

  const rpcUrl = process.env['RPC_URL'] ?? DEFAULT_RPC[chainId] ?? 'https://mainnet.base.org';
  const factoryAddress = process.env['FACTORY_ADDRESS'] as Address | undefined;
  const nftContractAddress = process.env['NFT_CONTRACT_ADDRESS'] as Address | undefined;

  return {
    agentPrivateKey: agentPrivateKey as `0x${string}`,
    walletAddress: walletAddress as Address,
    chainId,
    rpcUrl,
    factoryAddress,
    nftContractAddress,
  };
}

// ─── Wallet factory ────────────────────────────────────────────────────────

export type AgentWalletInstance = ReturnType<typeof createWallet>;

/**
 * Create an AgentWallet instance from config.
 * Returns the wallet bound to the configured chain + RPC.
 */
export function createAgentWallet(config: AgentPayConfig): AgentWalletInstance {
  const chain = CHAIN_MAP[config.chainId];
  if (!chain) {
    throw new Error(`Unsupported chain ID: ${config.chainId}`);
  }

  const chainName = CHAIN_NAME_MAP[config.chainId];
  if (!chainName) {
    throw new Error(`No chain name mapping for chain ID: ${config.chainId}`);
  }

  const account = privateKeyToAccount(config.agentPrivateKey);

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl),
  });

  return createWallet({
    accountAddress: config.walletAddress,
    chain: chainName,
    rpcUrl: config.rpcUrl,
    walletClient,
  });
}

// ─── Singleton accessor ────────────────────────────────────────────────────

let _config: AgentPayConfig | null = null;
let _wallet: AgentWalletInstance | null = null;

/**
 * Get the singleton AgentPay config (loaded once from env).
 * Throws a descriptive error if env vars are missing.
 */
export function getConfig(): AgentPayConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}

/**
 * Get the singleton AgentWallet instance.
 * Lazily initialized on first call.
 */
export function getWallet(): AgentWalletInstance {
  if (!_wallet) {
    _wallet = createAgentWallet(getConfig());
  }
  return _wallet;
}

/**
 * Reset singletons (for testing only).
 */
export function _resetSingletons(): void {
  _config = null;
  _wallet = null;
}
