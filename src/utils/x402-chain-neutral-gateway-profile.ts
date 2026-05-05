/**
 * Chain-neutral x402 gateway profile helpers.
 *
 * Paid MCP discovery is moving from one Base endpoint to profile documents that
 * describe every supported payment rail, settlement/facilitator boundary,
 * trial/refund policy, and directory manifest path. These helpers validate that
 * profile shape without assuming every x402 payment rail is EVM-compatible.
 */

export type X402NetworkNamespace = 'eip155' | 'solana' | 'tvm' | 'ton' | 'other';

export type X402NetworkDescriptor = {
  network: string;
  name: string;
  gateway: string;
  namespace?: X402NetworkNamespace;
  settlementAsset?: string;
  settlementChainId?: number | string;
  notes?: string;
};

export type X402TrialPolicy = {
  enabled: boolean;
  calls?: number;
  description: string;
};

export type X402RefundPolicy = {
  supported: boolean;
  mode: 'automatic' | 'manual' | 'none';
  description: string;
};

export type X402DirectoryManifests = {
  wellKnownX402: string;
  glama?: string;
  smithery?: string;
  mcpCatalog?: string;
  openapi?: string;
  llmsTxt?: string;
};

export type X402ChainNeutralGatewayProfile = {
  serviceName: string;
  x402Version: number | string;
  paymentHeader: 'Payment-Signature';
  receiptHeader: 'payment-response';
  networks: X402NetworkDescriptor[];
  facilitator?: string;
  settlement: {
    custody: 'non-custodial' | 'facilitator' | 'managed' | 'unknown';
    description: string;
  };
  trial: X402TrialPolicy;
  refund: X402RefundPolicy;
  manifests: X402DirectoryManifests;
};

export type X402ChainNeutralGatewayProfileReport = {
  serviceName: string;
  networkNamespaces: X402NetworkNamespace[];
  hasEvmNetwork: boolean;
  hasNonEvmNetwork: boolean;
  hasDirectoryManifests: boolean;
  hasExplicitTrialPolicy: boolean;
  hasExplicitRefundPolicy: boolean;
  hasSettlementMetadata: boolean;
  issues: string[];
};

const CAIP2_PREFIX_RE = /^([a-z0-9-]+):(.+)$/i;

export function inferX402NetworkNamespace(network: string): X402NetworkNamespace {
  const match = network.match(CAIP2_PREFIX_RE);
  if (!match) return 'other';
  const namespace = match[1].toLowerCase();
  if (namespace === 'eip155') return 'eip155';
  if (namespace === 'solana') return 'solana';
  if (namespace === 'tvm') return 'tvm';
  if (namespace === 'ton') return 'ton';
  return 'other';
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

export function validateX402ChainNeutralGatewayProfile(
  profile: X402ChainNeutralGatewayProfile
): X402ChainNeutralGatewayProfileReport {
  const issues: string[] = [];
  const namespaces = unique(profile.networks.map((network) => network.namespace ?? inferX402NetworkNamespace(network.network)));
  const hasEvmNetwork = namespaces.includes('eip155');
  const hasNonEvmNetwork = namespaces.some((namespace) => namespace !== 'eip155');

  if (!profile.serviceName.trim()) issues.push('serviceName is required');
  if (profile.paymentHeader !== 'Payment-Signature') issues.push('paymentHeader must be Payment-Signature');
  if (profile.receiptHeader !== 'payment-response') issues.push('receiptHeader must be payment-response');
  if (profile.networks.length === 0) issues.push('at least one supported network descriptor is required');

  for (const [index, network] of profile.networks.entries()) {
    const namespace = network.namespace ?? inferX402NetworkNamespace(network.network);
    if (!network.name.trim()) issues.push(`networks[${index}].name is required`);
    if (namespace === 'other') issues.push(`networks[${index}].network should use a known CAIP-2 namespace`);
    if (!isHttpsUrl(network.gateway)) issues.push(`networks[${index}].gateway must be an https URL`);
  }

  const manifestUrls = [
    profile.manifests.wellKnownX402,
    profile.manifests.glama,
    profile.manifests.smithery,
    profile.manifests.mcpCatalog,
    profile.manifests.openapi,
    profile.manifests.llmsTxt,
  ].filter((value): value is string => Boolean(value));

  if (!isHttpsUrl(profile.manifests.wellKnownX402)) issues.push('manifests.wellKnownX402 must be an https URL');
  if (manifestUrls.some((url) => !isHttpsUrl(url))) issues.push('all directory manifest URLs must use https');

  const hasDirectoryManifests = Boolean(profile.manifests.wellKnownX402 && (profile.manifests.glama || profile.manifests.smithery || profile.manifests.mcpCatalog));
  const hasExplicitTrialPolicy = typeof profile.trial.enabled === 'boolean' && Boolean(profile.trial.description.trim());
  const hasExplicitRefundPolicy = typeof profile.refund.supported === 'boolean' && Boolean(profile.refund.description.trim()) && profile.refund.mode !== undefined;
  const hasSettlementMetadata = Boolean(profile.settlement.description.trim()) && Boolean(profile.facilitator || profile.settlement.custody === 'non-custodial');

  if (!hasDirectoryManifests) issues.push('profile must include .well-known/x402 plus Glama, Smithery, or MCP catalog metadata');
  if (!hasExplicitTrialPolicy) issues.push('trial policy must be explicit, including no-trial cases');
  if (!hasExplicitRefundPolicy) issues.push('refund policy must be explicit, including no-refund cases');
  if (!hasSettlementMetadata) issues.push('settlement metadata must identify custody or facilitator boundary');

  return {
    serviceName: profile.serviceName,
    networkNamespaces: namespaces,
    hasEvmNetwork,
    hasNonEvmNetwork,
    hasDirectoryManifests,
    hasExplicitTrialPolicy,
    hasExplicitRefundPolicy,
    hasSettlementMetadata,
    issues,
  };
}

export function buildAgentPayChainNeutralGatewayProfile(): X402ChainNeutralGatewayProfile {
  return {
    serviceName: 'AgentPay MCP',
    x402Version: '2.11-compatible',
    paymentHeader: 'Payment-Signature',
    receiptHeader: 'payment-response',
    networks: [
      {
        network: 'eip155:8453',
        name: 'Base mainnet',
        gateway: 'https://www.npmjs.com/package/agentpay-mcp',
        namespace: 'eip155',
        settlementAsset: 'USDC',
        settlementChainId: 8453,
        notes: 'Current production x402 signing path for AgentPay MCP.',
      },
      {
        network: 'solana:extension-point',
        name: 'Solana extension point',
        gateway: 'https://github.com/up2itnow0822/agentpay-mcp/blob/main/docs/x402-chain-neutral-gateway-profile.md',
        namespace: 'solana',
        notes: 'Documented as fail-closed until Solana signing, asset, facilitator, receipt, and refund semantics are deliberately implemented.',
      },
    ],
    settlement: {
      custody: 'non-custodial',
      description: 'AgentPay signs only after local policy approval. New non-EVM rails must preserve non-custodial signing and audit rows before support is advertised.',
    },
    trial: {
      enabled: false,
      description: 'AgentPay does not advertise free trials. Buyers should set explicit per-call and daily caps before signing.',
    },
    refund: {
      supported: false,
      mode: 'none',
      description: 'AgentPay treats refunds as provider-specific settlement events that must be captured in receipts before buyer agents rely on them.',
    },
    manifests: {
      wellKnownX402: 'https://github.com/up2itnow0822/agentpay-mcp/blob/main/docs/x402-chain-neutral-gateway-profile.md',
      glama: 'https://glama.ai/mcp/servers/up2itnow0822/claw-pay-mcp',
      smithery: 'https://github.com/up2itnow0822/agentpay-mcp/blob/main/smithery.yaml',
      mcpCatalog: 'https://github.com/up2itnow0822/agentpay-mcp/blob/main/docs/mcp-registry-listing.json',
      llmsTxt: 'https://github.com/up2itnow0822/agentpay-mcp/blob/main/llms.txt',
    },
  };
}
