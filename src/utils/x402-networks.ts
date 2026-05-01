/**
 * x402 network support policy for AgentPay MCP.
 *
 * AgentPay MCP currently signs x402 exact payments only on the configured
 * Base network. New x402 networks must be added deliberately because each
 * network can need different wallet deployment, gas, asset, and settlement
 * handling.
 */

const X402_NETWORK_BY_CHAIN_ID: Record<number, string> = {
  8453: 'base:8453',
  84532: 'base-sepolia:84532',
};

export function supportedX402NetworksForChainId(chainId: number): string[] {
  const network = X402_NETWORK_BY_CHAIN_ID[chainId];
  return network ? [network] : [];
}

export function describeSupportedX402Networks(chainId: number): string {
  const networks = supportedX402NetworksForChainId(chainId);
  return networks.length > 0 ? networks.join(', ') : `none for CHAIN_ID ${chainId}`;
}

export function isTvmOrTonNetwork(network: string): boolean {
  const normalized = network.toLowerCase();
  return normalized.startsWith('tvm:') || normalized.includes('ton');
}
