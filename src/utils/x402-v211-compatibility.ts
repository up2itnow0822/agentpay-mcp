/**
 * x402 v2.11 paid MCP compatibility helpers.
 *
 * These helpers keep buyer-facing documentation, tests, and downstream
 * Streamable HTTP gateways aligned on the same header names and receipt links.
 */

export const X402_V211_PAYMENT_SIGNATURE_HEADER = 'Payment-Signature';
export const X402_V211_DEPRECATED_PAYMENT_HEADERS = ['X-Payment'];
export const X402_V211_RECEIPT_HEADER = 'payment-response';
export const X402_V211_MCP_SESSION_HEADER = 'mcp-session-id';

export const X402_V211_BROWSER_EXPOSED_HEADERS = [
  X402_V211_RECEIPT_HEADER,
  X402_V211_MCP_SESSION_HEADER,
];

export type SupportedReceiptChainId = 8453 | 84532;

export type X402V211CompatibilityProof = {
  paymentSignatureHeader: typeof X402_V211_PAYMENT_SIGNATURE_HEADER;
  deprecatedPaymentHeaders: string[];
  responseHeaders: string[];
  corsExposeHeaders: string;
  streamableHttpSequence: string[];
  supportedReceiptChains: Array<{
    chainId: SupportedReceiptChainId;
    name: string;
    explorerTxBaseUrl: string;
    x402Network: string;
  }>;
};

const RECEIPT_EXPLORERS: Record<SupportedReceiptChainId, { name: string; explorerTxBaseUrl: string; x402Network: string }> = {
  8453: {
    name: 'Base mainnet',
    explorerTxBaseUrl: 'https://basescan.org/tx',
    x402Network: 'base',
  },
  84532: {
    name: 'Base Sepolia',
    explorerTxBaseUrl: 'https://sepolia.basescan.org/tx',
    x402Network: 'base-sepolia',
  },
};

export function buildCorsExposeHeaders(existing: string[] = []): string {
  const normalized = new Map<string, string>();
  for (const header of [...existing, ...X402_V211_BROWSER_EXPOSED_HEADERS]) {
    const clean = header.trim();
    if (clean) normalized.set(clean.toLowerCase(), clean);
  }
  return Array.from(normalized.values()).join(', ');
}

export function buildReceiptLink(chainId: number, txHash: string): string {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error('txHash must be a 32-byte 0x-prefixed transaction hash');
  }
  const chain = RECEIPT_EXPLORERS[chainId as SupportedReceiptChainId];
  if (!chain) {
    throw new Error('Unsupported receipt chain. Use Base mainnet 8453 or Base Sepolia 84532.');
  }
  return `${chain.explorerTxBaseUrl}/${txHash}`;
}

export function x402V211CompatibilityProof(): X402V211CompatibilityProof {
  return {
    paymentSignatureHeader: X402_V211_PAYMENT_SIGNATURE_HEADER,
    deprecatedPaymentHeaders: [...X402_V211_DEPRECATED_PAYMENT_HEADERS],
    responseHeaders: [...X402_V211_BROWSER_EXPOSED_HEADERS],
    corsExposeHeaders: buildCorsExposeHeaders(),
    streamableHttpSequence: [
      'POST /mcp initialize with Payment-Signature when the gateway charges for initialize',
      'Read payment-response and mcp-session-id from exposed response headers',
      'Send notifications/initialized after initialize succeeds',
      'Call tools/list only after initialize and initialized complete',
      'Call tools/call with the returned mcp-session-id when the gateway requires session continuity',
    ],
    supportedReceiptChains: Object.entries(RECEIPT_EXPLORERS).map(([chainId, value]) => ({
      chainId: Number(chainId) as SupportedReceiptChainId,
      ...value,
    })),
  };
}
