/**
 * Bind spend and balance tools to the configured wallet chain.
 *
 * The MCP wallet is permanently bound to CHAIN_ID (Base 8453 or Base Sepolia
 * 84532). Registry lookups keyed by a caller-supplied chainId can still
 * resolve OP-stack tokens that share an address (WETH 0x4200…0006) and then
 * broadcast on the wallet chain while reporting the requested network.
 */
import { getConfig } from './client.js'

const BRIDGE_SOURCE_CHAIN_IDS: Record<string, number> = {
  base: 8453,
  ethereum: 1,
  optimism: 10,
  arbitrum: 42161,
  polygon: 137,
  avalanche: 43114,
  linea: 59144,
  unichain: 130,
  sonic: 146,
  worldchain: 480,
}

export function getConfiguredChainId(): number {
  return getConfig().chainId
}

export function assertConfiguredChain(requestedChainId: number, tool: string): void {
  const configured = getConfiguredChainId()
  if (requestedChainId !== configured) {
    throw new Error(
      `${tool} is bound to configured CHAIN_ID ${configured}; ` +
        `refusing chainId ${requestedChainId} because the wallet cannot sign or broadcast on that network.`
    )
  }
}

export function assertConfiguredBridgeSource(fromChain: string, tool: string): void {
  const configured = getConfiguredChainId()
  const fromChainId = BRIDGE_SOURCE_CHAIN_IDS[fromChain]
  if (fromChainId === undefined) {
    throw new Error(
      `${tool} does not recognize source chain "${fromChain}"; refusing to burn USDC.`
    )
  }
  if (fromChainId !== configured) {
    throw new Error(
      `${tool} is bound to configured CHAIN_ID ${configured}; ` +
        `refusing fromChain "${fromChain}" (${fromChainId}) because the wallet cannot sign the CCTP burn on that network.`
    )
  }
}
