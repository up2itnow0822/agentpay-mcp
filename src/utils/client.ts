/**
 * AgentWalletClient setup for AgentPay MCP.
 * Reads config from environment variables and creates a configured wallet instance.
 */
import { createWalletClient, http, type Address, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { createWallet, readDeploymentIdentitySettings } from 'agentwallet-sdk';

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
  /** agentwallet-sdk 8 deployment identity (trusted factory + token binding). Required. */
  deployment: DeploymentIdentity;
  /** Optional approved AgentAccountV2 runtime code hash (strongly recommended). */
  expectedCodeHash?: `0x${string}`;
}

/** Signer/chain config without the deployment identity (deploy_wallet only). */
export type SignerConfig = Omit<AgentPayConfig, 'deployment' | 'expectedCodeHash'>;

export interface DeploymentIdentity {
  factoryAddress: Address;
  tokenContract: Address;
  tokenId: bigint;
}

export const DEPLOYMENT_IDENTITY_ENV = [
  'AGENT_WALLET_FACTORY',
  'AGENT_WALLET_TOKEN_CONTRACT',
  'AGENT_WALLET_TOKEN_ID',
] as const;
export const CODE_HASH_ENV = 'AGENT_WALLET_CODE_HASH';
export const UNVERIFIED_OPT_OUT_ENV = 'AGENT_WALLET_ALLOW_UNVERIFIED';

/**
 * Read the agentwallet-sdk 8 deployment identity from the environment.
 * Fails closed: the SDK's unverified opt-out is rejected for ANY non-empty
 * value, and the deployment identity (factory + token) is required. Values
 * here are public on-chain identifiers, never secrets.
 */
export function loadDeploymentIdentity(
  env: Record<string, string | undefined> = process.env
): { deployment: DeploymentIdentity; expectedCodeHash?: `0x${string}` } {
  if ((env[UNVERIFIED_OPT_OUT_ENV] ?? '') !== '') {
    throw new Error(
      `${UNVERIFIED_OPT_OUT_ENV} is not supported by AgentPay MCP: it would let payments go to an unverified wallet. ` +
        `Unset it and configure ${DEPLOYMENT_IDENTITY_ENV.join(', ')} instead.`
    );
  }
  let settings: ReturnType<typeof readDeploymentIdentitySettings>;
  try {
    settings = readDeploymentIdentitySettings((name) => env[name]);
  } catch (err) {
    throw new Error(`Invalid deployment identity: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!settings.deployment) {
    throw new Error(
      `Deployment identity required: set ${DEPLOYMENT_IDENTITY_ENV.join(', ')} (printed by deploy_wallet). ` +
        `${CODE_HASH_ENV} is strongly recommended as well.`
    );
  }
  return {
    deployment: settings.deployment as DeploymentIdentity,
    ...(settings.expectedCodeHash ? { expectedCodeHash: settings.expectedCodeHash as `0x${string}` } : {}),
  };
}

/** One non-secret startup line describing which wallet identity is enforced. */
export function describeWalletIdentity(config: AgentPayConfig): string {
  const d = config.deployment;
  return (
    `AgentPay wallet identity: chain=${config.chainId} account=${config.walletAddress} ` +
    `factory=${d.factoryAddress} tokenContract=${d.tokenContract} tokenId=${d.tokenId.toString()} ` +
    `codeHash=${config.expectedCodeHash ? 'set' : `NOT SET (strongly recommended: ${CODE_HASH_ENV})`}`
  );
}

// ─── Config loader ─────────────────────────────────────────────────────────

/**
 * Load configuration from environment variables.
 * Only AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS are required to get started.
 */
export function loadConfig(): AgentPayConfig {
  return { ...loadSignerConfig(), ...loadDeploymentIdentity(process.env) };
}

/**
 * Signer and chain settings only. Used by deploy_wallet, which creates the
 * deployment identity and so cannot require it yet.
 */
export function loadSignerConfig(): SignerConfig {
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
    deployment: config.deployment,
    ...(config.expectedCodeHash ? { expectedCodeHash: config.expectedCodeHash } : {}),
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
