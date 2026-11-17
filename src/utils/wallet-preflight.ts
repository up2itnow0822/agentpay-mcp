/**
 * SDK 7 wrapper #3: fail-closed wallet startup gate before the first write.
 */
import { createPublicClient, getAddress, http, keccak256, type Address, type Chain, type Hex } from 'viem'
import { base, baseSepolia } from 'viem/chains'
import { getWalletAddress } from 'agentwallet-sdk'
import type { AgentPayConfig, AgentWalletInstance } from './client.js'
import { DefiniteSpendFailure } from './spend-intent.js'
import { rejectUnverifiedWalletOptOut } from './wallet-binding.js'

const CHAIN_MAP: Record<number, Chain> = {
  8453: base,
  84532: baseSepolia,
}

const EIP7702_DELEGATION_PREFIX = '0xef0100'

let startupVerified = false

export function _resetWalletStartupGate(): void {
  startupVerified = false
}

function loadCodeHash(env: Record<string, string | undefined> = process.env): Hex | null {
  const raw = process.env['AGENT_WALLET_CODE_HASH']?.trim() ?? env['AGENT_WALLET_CODE_HASH']?.trim() ?? ''
  if (!raw) return null
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new DefiniteSpendFailure('AGENT_WALLET_CODE_HASH must be a 0x-prefixed 32-byte hex string.')
  }
  return raw as Hex
}

function loadFactoryBinding(env: Record<string, string | undefined> = process.env): {
  factory: Address
  tokenContract: Address
  tokenId: bigint
} | null {
  const factory =
    (process.env['AGENT_WALLET_FACTORY'] ?? env['AGENT_WALLET_FACTORY'] ?? env['FACTORY_ADDRESS'] ?? '').trim()
  const tokenContract =
    (process.env['AGENT_WALLET_TOKEN_CONTRACT'] ??
      env['AGENT_WALLET_TOKEN_CONTRACT'] ??
      env['NFT_CONTRACT_ADDRESS'] ??
      '').trim()
  const tokenIdRaw = (process.env['AGENT_WALLET_TOKEN_ID'] ?? env['AGENT_WALLET_TOKEN_ID'] ?? '').trim()
  if (!factory && !tokenContract && !tokenIdRaw) return null
  if (!factory || !tokenContract || !tokenIdRaw) {
    throw new DefiniteSpendFailure(
      'Deployment identity incomplete: set AGENT_WALLET_CODE_HASH or all of ' +
        'AGENT_WALLET_FACTORY, AGENT_WALLET_TOKEN_CONTRACT, AGENT_WALLET_TOKEN_ID.'
    )
  }
  return {
    factory: getAddress(factory),
    tokenContract: getAddress(tokenContract),
    tokenId: BigInt(tokenIdRaw),
  }
}

/** Ensures deployment identity env is present (code hash or factory binding). */
export function requireDeploymentIdentityEnv(): void {
  rejectUnverifiedWalletOptOut()
  const codeHash = loadCodeHash()
  const factory = loadFactoryBinding()
  if (!codeHash && !factory) {
    throw new DefiniteSpendFailure(
      'Deployment identity required at startup: set AGENT_WALLET_CODE_HASH or ' +
        '(AGENT_WALLET_FACTORY, AGENT_WALLET_TOKEN_CONTRACT, AGENT_WALLET_TOKEN_ID).'
    )
  }
}

/**
 * Run once before the first value-moving write. Fails closed with no opt-out env.
 */
export async function ensureWalletStartupVerified(
  wallet: AgentWalletInstance,
  config: AgentPayConfig
): Promise<void> {
  if (startupVerified) return
  rejectUnverifiedWalletOptOut()
  requireDeploymentIdentityEnv()

  const chain = CHAIN_MAP[config.chainId]
  if (!chain) throw new DefiniteSpendFailure(`Unsupported chain ${config.chainId}.`)

  const publicClient =
    wallet.publicClient ?? createPublicClient({ chain, transport: http(config.rpcUrl) })

  const walletClient = wallet.walletClient
  if (!walletClient?.chain?.id) {
    throw new DefiniteSpendFailure('Wallet client chain is not configured.')
  }

  const [rpcChainId, onChainCode] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getCode({ address: config.walletAddress }),
  ])

  if (rpcChainId !== config.chainId || rpcChainId !== walletClient.chain.id) {
    throw new DefiniteSpendFailure(
      `Chain ID mismatch: RPC=${rpcChainId}, config=${config.chainId}, wallet client=${walletClient.chain.id}.`
    )
  }

  const code = (onChainCode ?? '0x') as Hex
  if (code === '0x' || code.length <= 2) {
    throw new DefiniteSpendFailure('AGENT_WALLET_ADDRESS has no contract code (EOA or undeployed).')
  }
  if (code.toLowerCase().startsWith(EIP7702_DELEGATION_PREFIX)) {
    throw new DefiniteSpendFailure('AGENT_WALLET_ADDRESS is an EIP-7702 delegation (0xef0100); refused.')
  }

  const codeHash = loadCodeHash()
  const factoryBinding = loadFactoryBinding()
  if (codeHash) {
    const deployed = keccak256(code)
    if (deployed.toLowerCase() !== codeHash.toLowerCase()) {
      throw new DefiniteSpendFailure('On-chain code hash does not match AGENT_WALLET_CODE_HASH.')
    }
  }
  if (factoryBinding) {
    const chainName = config.chainId === 84532 ? 'base-sepolia' : 'base'
    const predicted = await getWalletAddress({
      factoryAddress: factoryBinding.factory,
      tokenContract: factoryBinding.tokenContract,
      tokenId: factoryBinding.tokenId,
      chain: chainName,
      rpcUrl: config.rpcUrl,
    })
    if (getAddress(predicted) !== getAddress(config.walletAddress)) {
      throw new DefiniteSpendFailure(
        'AGENT_WALLET_ADDRESS does not match factory prediction for token id and contract.'
      )
    }
    const [onChainToken, onChainId] = await Promise.all([
      wallet.contract.read.tokenContract(),
      wallet.contract.read.tokenId(),
    ])
    if (getAddress(onChainToken) !== factoryBinding.tokenContract) {
      throw new DefiniteSpendFailure('On-chain tokenContract does not match AGENT_WALLET_TOKEN_CONTRACT.')
    }
    if (BigInt(onChainId) !== factoryBinding.tokenId) {
      throw new DefiniteSpendFailure('On-chain tokenId does not match AGENT_WALLET_TOKEN_ID.')
    }
  }

  const agentEoa = walletClient.account?.address
  if (!agentEoa) {
    throw new DefiniteSpendFailure('AGENT_PRIVATE_KEY wallet client has no account address.')
  }
  const active = await wallet.contract.read.isOperatorActive([agentEoa])
  if (!active) {
    throw new DefiniteSpendFailure('Agent EOA is not an active operator on the AgentAccountV2 wallet.')
  }

  startupVerified = true
}