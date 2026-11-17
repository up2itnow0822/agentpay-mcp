/**
 * SDK 7 wrapper: verify AGENT_WALLET_ADDRESS is the expected AgentAccountV2
 * (factory CREATE2 binding + on-chain tokenContract/tokenId when RPC is available).
 */
import { getAddress, type Address } from 'viem'
import { getWalletAddress } from 'agentwallet-sdk'
import type { AgentPayConfig, AgentWalletInstance } from './client.js'
import { DefiniteSpendFailure } from './spend-intent.js'
import { ensureWalletStartupVerified } from './wallet-preflight.js'

export const WALLET_BINDING_ENV = [
  'AGENT_WALLET_FACTORY',
  'AGENT_WALLET_TOKEN_CONTRACT',
  'AGENT_WALLET_TOKEN_ID',
] as const

const UNVERIFIED_OPT_OUT = 'AGENT_WALLET_ALLOW_UNVERIFIED'

export interface WalletBindingIdentity {
  factoryAddress: Address
  tokenContract: Address
  tokenId: bigint
}

const CHAIN_NAME: Record<number, 'base' | 'base-sepolia'> = {
  8453: 'base',
  84532: 'base-sepolia',
}

function chainNameFor(chainId: number): 'base' | 'base-sepolia' {
  const name = CHAIN_NAME[chainId]
  if (!name) {
    throw new DefiniteSpendFailure(`Unsupported CHAIN_ID ${chainId} for wallet binding.`)
  }
  return name
}

/** Reject any opt-out that would skip factory binding (SDK 8 name; refused on 7.0.0 wrappers too). */
export function rejectUnverifiedWalletOptOut(env: Record<string, string | undefined> = process.env): void {
  const optOut =
    (process.env['AGENT_WALLET_ALLOW_UNVERIFIED'] ?? env['AGENT_WALLET_ALLOW_UNVERIFIED'] ?? env[UNVERIFIED_OPT_OUT] ?? '').trim()
  if (optOut !== '') {
    throw new DefiniteSpendFailure(
      `${UNVERIFIED_OPT_OUT} is not supported: unset it and configure ${WALLET_BINDING_ENV.join(', ')} ` +
        '(or FACTORY_ADDRESS, NFT_CONTRACT_ADDRESS, AGENT_WALLET_TOKEN_ID).'
    )
  }
}

/** Load factory + NFT binding from env; partial config fails closed. */
export function loadWalletBindingIdentity(
  env: Record<string, string | undefined> = process.env
): WalletBindingIdentity | null {
  rejectUnverifiedWalletOptOut(env)
  const factory =
    process.env['AGENT_WALLET_FACTORY']?.trim() ||
    env['AGENT_WALLET_FACTORY']?.trim() ||
    env['FACTORY_ADDRESS']?.trim() ||
    ''
  const tokenContract =
    process.env['AGENT_WALLET_TOKEN_CONTRACT']?.trim() ||
    env['AGENT_WALLET_TOKEN_CONTRACT']?.trim() ||
    env['NFT_CONTRACT_ADDRESS']?.trim() ||
    ''
  const tokenIdRaw =
    process.env['AGENT_WALLET_TOKEN_ID']?.trim() ?? env['AGENT_WALLET_TOKEN_ID']?.trim() ?? ''
  if (!factory && !tokenContract && !tokenIdRaw) return null
  if (!factory || !tokenContract || !tokenIdRaw) {
    throw new DefiniteSpendFailure(
      `Wallet binding is incomplete. Set all of ${WALLET_BINDING_ENV.join(', ')} ` +
        '(or FACTORY_ADDRESS, NFT_CONTRACT_ADDRESS, AGENT_WALLET_TOKEN_ID).'
    )
  }
  let tokenId: bigint
  try {
    tokenId = BigInt(tokenIdRaw)
  } catch {
    throw new DefiniteSpendFailure(`AGENT_WALLET_TOKEN_ID is not a valid integer: "${tokenIdRaw}".`)
  }
  if (tokenId < 0n) {
    throw new DefiniteSpendFailure('AGENT_WALLET_TOKEN_ID must be non-negative.')
  }
  return {
    factoryAddress: getAddress(factory),
    tokenContract: getAddress(tokenContract),
    tokenId,
  }
}

async function expectedFactoryAddress(
  identity: WalletBindingIdentity,
  config: AgentPayConfig
): Promise<Address> {
  return getWalletAddress({
    factoryAddress: identity.factoryAddress,
    tokenContract: identity.tokenContract,
    tokenId: identity.tokenId,
    chain: chainNameFor(config.chainId),
    rpcUrl: config.rpcUrl,
  })
}

async function readOnChainBinding(
  wallet: AgentWalletInstance,
  identity: WalletBindingIdentity
): Promise<void> {
  const contract = wallet.contract
  if (!contract?.read) return
  try {
    const [onChainToken, onChainId] = await Promise.all([
      contract.read.tokenContract(),
      contract.read.tokenId(),
    ])
    if (getAddress(onChainToken) !== identity.tokenContract) {
      throw new DefiniteSpendFailure(
        'AGENT_WALLET_ADDRESS tokenContract does not match the configured NFT contract.'
      )
    }
    if (BigInt(onChainId) !== identity.tokenId) {
      throw new DefiniteSpendFailure(
        'AGENT_WALLET_ADDRESS tokenId does not match AGENT_WALLET_TOKEN_ID.'
      )
    }
  } catch (error: unknown) {
    if (error instanceof DefiniteSpendFailure) throw error
    throw new DefiniteSpendFailure(
      `Could not read wallet owner binding on-chain: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Call immediately before any value-moving SDK write when binding env is configured.
 * With no binding env, fails closed for production paid tools (callers pass requireBinding=true).
 */
export async function assertExpectedSmartWallet(
  wallet: AgentWalletInstance,
  config: AgentPayConfig,
  options: { requireBinding?: boolean } = { requireBinding: true }
): Promise<void> {
  rejectUnverifiedWalletOptOut()
  if (options.requireBinding !== false) {
    await ensureWalletStartupVerified(wallet, config)
    return
  }
  const identity = loadWalletBindingIdentity()
  if (!identity) {
    return
  }
  const expected = await expectedFactoryAddress(identity, config)
  if (getAddress(config.walletAddress) !== getAddress(expected)) {
    throw new DefiniteSpendFailure(
      'AGENT_WALLET_ADDRESS does not match the factory-predicted AgentAccountV2 address for ' +
        'the configured factory, token contract, and token id. Refusing to sign.'
    )
  }
  if (getAddress(wallet.address) !== getAddress(config.walletAddress)) {
    throw new DefiniteSpendFailure('Wallet client address does not match AGENT_WALLET_ADDRESS.')
  }
  await readOnChainBinding(wallet, identity)
}