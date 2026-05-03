/**
 * Hosted x402 proxy verification helpers.
 *
 * These helpers let a buyer validate a hosted paid-MCP proxy challenge before
 * any wallet signs. They check the machine-readable 402 payment requirement
 * and the local buyer controls that sit outside the remote proxy: approval,
 * spend cap, audit logging, and pooled-token lock-in acceptance.
 */

type HeaderGetter = { get(_name: string): string | null | undefined };
type HeaderSource = Record<string, string | undefined> | Array<[string, string]> | HeaderGetter;

type X402Accept = {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  maxAmountRequired?: string;
  payTo?: string;
  [key: string]: unknown;
};

type X402PaymentRequirement = {
  accepts?: X402Accept[];
  [key: string]: unknown;
};

export type HostedProxyVerificationInput = {
  status: number;
  headers?: HeaderSource;
  body?: string;
  allowedNetworks: string[];
  allowedAssets: string[];
  maxAmountRequired?: string | bigint;
  approvalGate: {
    required: boolean;
    state: 'approved' | 'pending' | 'declined' | 'not_configured';
  };
  auditLog: {
    required: boolean;
    destination?: string;
    correlationId?: string;
  };
  upstreamCredentialMode: 'buyer-owned' | 'operator-pooled' | 'unknown';
  pooledTokenLockInAccepted?: boolean;
};

export type HostedProxyVerifiedOffer = {
  scheme?: string;
  network: string;
  asset: string;
  amountRequired: string;
  payTo: string;
};

export type HostedProxyVerificationResult = {
  ok: boolean;
  failures: string[];
  warnings: string[];
  source: 'payment-required-header' | 'x-payment-required-header' | 'body' | 'none';
  offers: HostedProxyVerifiedOffer[];
};

function readHeader(headers: HeaderSource | undefined, name: string): string | null {
  if (!headers) return null;
  const lowerName = name.toLowerCase();

  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === lowerName);
    return found?.[1] ?? null;
  }

  if ('get' in headers && typeof headers.get === 'function') {
    return headers.get(name) ?? headers.get(lowerName) ?? null;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) return value ?? null;
  }

  return null;
}

function parseRequirementJson(raw: string): X402PaymentRequirement | null {
  try {
    const parsed = JSON.parse(raw) as X402PaymentRequirement;
    return Array.isArray(parsed.accepts) ? parsed : null;
  } catch {
    return null;
  }
}

function parseRequirementHeader(raw: string | null): X402PaymentRequirement | null {
  if (!raw) return null;

  const direct = parseRequirementJson(raw);
  if (direct) return direct;

  try {
    return parseRequirementJson(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function isNonZeroRecipient(payTo: string | undefined): payTo is string {
  if (!payTo) return false;
  const normalized = payTo.toLowerCase();
  if (normalized === '0x0000000000000000000000000000000000000000') return false;
  return /^0x[a-f0-9]{40}$/.test(normalized);
}

function parseAmount(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const amount = BigInt(value);
  return amount > 0n ? amount : null;
}

function findPaymentRequirement(input: HostedProxyVerificationInput): {
  requirement: X402PaymentRequirement | null;
  source: HostedProxyVerificationResult['source'];
} {
  const paymentRequired = parseRequirementHeader(readHeader(input.headers, 'payment-required'));
  if (paymentRequired) return { requirement: paymentRequired, source: 'payment-required-header' };

  const xPaymentRequired = parseRequirementHeader(readHeader(input.headers, 'x-payment-required'));
  if (xPaymentRequired) return { requirement: xPaymentRequired, source: 'x-payment-required-header' };

  const bodyRequirement = input.body ? parseRequirementJson(input.body) : null;
  if (bodyRequirement) return { requirement: bodyRequirement, source: 'body' };

  return { requirement: null, source: 'none' };
}

export function verifyHostedProxyPaymentRequirement(
  input: HostedProxyVerificationInput
): HostedProxyVerificationResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const offers: HostedProxyVerifiedOffer[] = [];

  if (input.status !== 402) {
    failures.push(`Expected HTTP 402 before payment; received ${input.status}.`);
  }

  const { requirement, source } = findPaymentRequirement(input);
  if (!requirement) {
    failures.push('No parseable x402 payment requirement was found in payment-required, x-payment-required, or JSON body.');
  }

  if (source === 'body') {
    failures.push('Payment requirement was only present in the body; require a payment-required header for buyer verification.');
  }

  const maxAmount =
    typeof input.maxAmountRequired === 'bigint'
      ? input.maxAmountRequired
      : input.maxAmountRequired
        ? BigInt(input.maxAmountRequired)
        : undefined;

  for (const offer of requirement?.accepts ?? []) {
    const amountRequired = offer.maxAmountRequired ?? offer.amount;
    const parsedAmount = parseAmount(amountRequired);

    if (!isNonZeroRecipient(offer.payTo)) continue;
    if (!offer.network || !input.allowedNetworks.includes(offer.network)) continue;
    if (!offer.asset || !input.allowedAssets.map((asset) => asset.toLowerCase()).includes(offer.asset.toLowerCase())) continue;
    if (parsedAmount === null) continue;
    if (maxAmount !== undefined && parsedAmount > maxAmount) continue;

    offers.push({
      scheme: offer.scheme,
      network: offer.network,
      asset: offer.asset,
      amountRequired: amountRequired ?? '',
      payTo: offer.payTo,
    });
  }

  if ((requirement?.accepts ?? []).length === 0) {
    failures.push('The x402 requirement does not include any accepted payment options.');
  }

  if (offers.length === 0 && requirement) {
    failures.push('No offered payment option passed recipient, network, asset, amount, and spend-cap checks.');
  }

  const hasZeroOrMissingPayTo = (requirement?.accepts ?? []).some((offer) => !isNonZeroRecipient(offer.payTo));
  if (hasZeroOrMissingPayTo) {
    failures.push('At least one offered payment option has a missing, malformed, or zero payTo recipient.');
  }

  if (input.approvalGate.required && input.approvalGate.state !== 'approved') {
    failures.push(`Approval gate required state approved before signing; current state is ${input.approvalGate.state}.`);
  }

  if (input.auditLog.required && (!input.auditLog.destination || !input.auditLog.correlationId)) {
    failures.push('Audit logging is required before payment; destination and correlationId must both be present.');
  }

  if (input.upstreamCredentialMode !== 'buyer-owned' && !input.pooledTokenLockInAccepted) {
    failures.push(
      `Upstream credential mode is ${input.upstreamCredentialMode}; buyer must explicitly accept or reject pooled-token lock-in before payment.`
    );
  }

  if (input.upstreamCredentialMode === 'operator-pooled' && input.pooledTokenLockInAccepted) {
    warnings.push('Buyer accepted an operator-pooled upstream token model. Record this in the audit trail.');
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    source,
    offers,
  };
}
