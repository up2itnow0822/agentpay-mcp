/**
 * Multi-ledger x402 receipt normalization helpers.
 *
 * x402 paid MCP servers are starting to advertise non-Base payment rails. Buyer
 * agents need one normalized receipt envelope before signing, with explicit
 * ledger, asset, settlement target, verification state, and custody boundary.
 */

export type X402LedgerNamespace = 'eip155' | 'xrpl' | 'tvm' | 'solana' | 'other';

export type X402VerificationStatus = 'verified' | 'pending' | 'unsupported_refused' | 'failed' | 'unknown';

export type X402CustodyBoundary = 'non-custodial' | 'facilitator' | 'managed' | 'unknown';

export type X402MultiLedgerReceipt = {
  schema: 'agentpay-x402-multi-ledger-receipt/v1';
  observedAt: string;
  source: {
    name: string;
    repo?: string;
    evidenceUrl?: string;
    pushedAt?: string;
  };
  payment: {
    x402Version: string;
    paymentHeader: 'Payment-Signature';
    receiptHeader: 'payment-response';
  };
  ledger: {
    label: string;
    namespace: X402LedgerNamespace;
    chainId?: string | number;
  };
  settlement: {
    asset: string;
    target: string;
    reference?: string;
  };
  verification: {
    status: X402VerificationStatus;
    verifier?: string;
    checkedAt: string;
  };
  boundary: {
    custody: X402CustodyBoundary;
    nonCustodial: boolean;
    description: string;
  };
  unsupportedLedgerRefusal?: string;
};

export type X402MultiLedgerReceiptPolicy = {
  supportedLedgerNamespaces: X402LedgerNamespace[];
  allowedAssets: string[];
  allowedSettlementTargets: string[];
  requireNonCustodialBoundary: boolean;
  requireVerifiedReceipt: boolean;
  allowUnsupportedRefusalProof: boolean;
};

export type X402MultiLedgerReceiptDecision = {
  ok: boolean;
  decision: 'allow' | 'deny';
  failures: string[];
  warnings: string[];
};

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function includesCaseInsensitive(values: string[], value: string): boolean {
  return values.map((entry) => entry.toLowerCase()).includes(value.toLowerCase());
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function evaluateX402MultiLedgerReceipt(
  receipt: X402MultiLedgerReceipt,
  policy: X402MultiLedgerReceiptPolicy,
  now = new Date()
): X402MultiLedgerReceiptDecision {
  const failures: string[] = [];
  const warnings: string[] = [];

  if (receipt.schema !== 'agentpay-x402-multi-ledger-receipt/v1') failures.push('schema must be agentpay-x402-multi-ledger-receipt/v1.');
  if (!isNonEmpty(receipt.source.name)) failures.push('source.name is required.');
  if (receipt.payment.paymentHeader !== 'Payment-Signature') failures.push('payment.paymentHeader must be Payment-Signature.');
  if (receipt.payment.receiptHeader !== 'payment-response') failures.push('payment.receiptHeader must be payment-response.');
  if (!isNonEmpty(receipt.ledger.label)) failures.push('ledger.label is required.');
  if (!isNonEmpty(receipt.settlement.asset)) failures.push('settlement.asset is required.');
  if (!isNonEmpty(receipt.settlement.target)) failures.push('settlement.target is required.');
  if (!isNonEmpty(receipt.verification.checkedAt) || Number.isNaN(parseTime(receipt.verification.checkedAt))) failures.push('verification.checkedAt must be an ISO timestamp.');
  if (!isNonEmpty(receipt.observedAt) || Number.isNaN(parseTime(receipt.observedAt))) failures.push('observedAt must be an ISO timestamp.');
  if (parseTime(receipt.observedAt) > now.getTime()) warnings.push('observedAt is in the future relative to evaluator clock.');

  if (!policy.supportedLedgerNamespaces.includes(receipt.ledger.namespace)) {
    failures.push(`ledger namespace ${receipt.ledger.namespace} is not supported by buyer policy.`);
  }

  if (!includesCaseInsensitive(policy.allowedAssets, receipt.settlement.asset)) {
    failures.push(`settlement asset ${receipt.settlement.asset} is not allowed.`);
  }

  if (!includesCaseInsensitive(policy.allowedSettlementTargets, receipt.settlement.target)) {
    failures.push(`settlement target ${receipt.settlement.target} is not allowlisted.`);
  }

  if (policy.requireNonCustodialBoundary && (!receipt.boundary.nonCustodial || receipt.boundary.custody !== 'non-custodial')) {
    failures.push('non-custodial boundary is required before signing.');
  }

  if (policy.requireVerifiedReceipt && receipt.verification.status !== 'verified') {
    if (receipt.verification.status === 'unsupported_refused' && policy.allowUnsupportedRefusalProof && isNonEmpty(receipt.unsupportedLedgerRefusal)) {
      warnings.push('Receipt is an unsupported-ledger refusal proof, not a spend authorization.');
    } else {
      failures.push(`verification status ${receipt.verification.status} is not verified.`);
    }
  }

  if (receipt.verification.status === 'unsupported_refused' && !isNonEmpty(receipt.unsupportedLedgerRefusal)) {
    failures.push('unsupportedLedgerRefusal copy is required for unsupported ledger refusal proofs.');
  }

  const ok = failures.length === 0 && receipt.verification.status === 'verified';
  return {
    ok,
    decision: ok ? 'allow' : 'deny',
    failures,
    warnings,
  };
}

export function buildAgentPayBaseReceiptExample(): X402MultiLedgerReceipt {
  return {
    schema: 'agentpay-x402-multi-ledger-receipt/v1',
    observedAt: '2026-05-05T01:10:00.000Z',
    source: {
      name: 'AgentPay MCP',
      repo: 'up2itnow0822/agentpay-mcp',
      evidenceUrl: 'https://www.npmjs.com/package/agentpay-mcp',
    },
    payment: {
      x402Version: '2.x',
      paymentHeader: 'Payment-Signature',
      receiptHeader: 'payment-response',
    },
    ledger: {
      label: 'Base mainnet',
      namespace: 'eip155',
      chainId: 8453,
    },
    settlement: {
      asset: 'USDC',
      target: '0x1111111111111111111111111111111111111111',
      reference: 'x402-receipt:base-mainnet-example',
    },
    verification: {
      status: 'verified',
      verifier: 'AgentPay local policy engine',
      checkedAt: '2026-05-05T01:10:00.000Z',
    },
    boundary: {
      custody: 'non-custodial',
      nonCustodial: true,
      description: 'Private keys remain local and AgentPay signs only after policy approval.',
    },
  };
}

export function buildXrplUnsupportedRefusalExample(): X402MultiLedgerReceipt {
  return {
    schema: 'agentpay-x402-multi-ledger-receipt/v1',
    observedAt: '2026-05-05T01:10:00.000Z',
    source: {
      name: 'XRPL-Utilities MCP market signal',
      repo: 'XRPL-Utilities/xrpl-utilities-mcp',
      evidenceUrl: 'https://github.com/XRPL-Utilities/xrpl-utilities-mcp',
      pushedAt: '2026-05-05T01:02:00.000Z',
    },
    payment: {
      x402Version: '2.x',
      paymentHeader: 'Payment-Signature',
      receiptHeader: 'payment-response',
    },
    ledger: {
      label: 'XRPL extension point',
      namespace: 'xrpl',
      chainId: 'xrpl-mainnet',
    },
    settlement: {
      asset: 'RLUSD or XRP, provider-declared',
      target: 'unsupported-until-allowlisted',
    },
    verification: {
      status: 'unsupported_refused',
      verifier: 'AgentPay buyer policy',
      checkedAt: '2026-05-05T01:10:00.000Z',
    },
    boundary: {
      custody: 'unknown',
      nonCustodial: false,
      description: 'AgentPay does not sign XRPL settlement until signer, asset, target, facilitator, and receipt semantics are explicitly implemented.',
    },
    unsupportedLedgerRefusal:
      'Refused before signing: XRPL x402 rail is visible but not allowlisted. Add ledger namespace, asset parser, settlement target allowlist, verifier, receipt mapping, and non-custodial signer support before retrying.',
  };
}
