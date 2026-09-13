/**
 * Bind value-moving tools to the configured wallet chain.
 *
 * The MCP wallet client is created once for CHAIN_ID (Base or Base Sepolia).
 * Token lookups and CCTP contract addresses must use that same chain —
 * otherwise a caller-supplied chainId can resolve a foreign-chain address
 * that happens to exist on the wallet chain (WETH 0x4200…0006 on every
 * OP-stack L2) and the transfer still succeeds on the wrong network.
 */
import { getConfig } from './client.js'

/**
 * CCTP `fromChain` names this wallet can actually sign for.
 * Burns submitted with a different source chain use that chain's
 * USDC/TokenMessenger addresses while the signer still broadcasts on
 * the configured network.
 */
const BRIDGE_SOURCE_BY_CHAIN_ID: Record<number, string> = {
  8453: 'base',
}

/**
 * Refuse a caller-supplied chainId that is not the configured wallet chain.
 *
 * send_token / swap_tokens look up token addresses by input.chainId, then
 * agentTransferToken / SwapModule always submit on wallet.chain.
 */
export function assertConfiguredChain(requestedChainId: number): number {
  const { chainId } = getConfig()
  if (requestedChainId !== chainId) {
    throw new Error(
      `Requested chainId ${requestedChainId} does not match the configured wallet chain ${chainId}. ` +
      `This server always submits transactions on chain ${chainId}; token addresses from other chains must not be used.`
    )
  }
  return chainId
}

/**
 * Refuse a CCTP source chain that the configured wallet cannot sign for.
 */
export function assertConfiguredBridgeSource(fromChain: string): void {
  const { chainId } = getConfig()
  const source = BRIDGE_SOURCE_BY_CHAIN_ID[chainId]
  if (!source) {
    throw new Error(
      `bridge_usdc cannot burn from chain ${chainId}. ` +
      'CCTP source is only supported when the wallet is on Base Mainnet (8453).'
    )
  }
  if (fromChain !== source) {
    throw new Error(
      `fromChain "${fromChain}" does not match the configured wallet chain (${source}, ${chainId}). ` +
      `CCTP burns are signed by this wallet and must originate on ${source}.`
    )
  }
}
