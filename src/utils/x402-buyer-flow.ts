import { createHash } from 'node:crypto';

export type X402BuyerChallenge = {
  network?: string;
  asset?: string;
  amountRequired?: string;
  payTo?: string;
};

export type X402TypedPaymentErrorName =
  | 'PaymentRequiredError'
  | 'QuotaExceededError'
  | 'TokenExpiredError'
  | 'ValidationFailureError'
  | 'SpendLimitExceededError'
  | 'UnknownPaymentError';

export type X402Retryability = 'retry_after_payment' | 'retry_after_quota_reset' | 'refresh_token_then_retry' | 'do_not_retry' | 'operator_review';

export type X402TypedPaymentError = {
  name: X402TypedPaymentErrorName;
  message?: string;
  noCharge: boolean;
  retryAfterSeconds?: number;
};

export type X402QuotaEnvelope = {
  limit?: string | number;
  remaining?: string | number;
  resetAt?: string;
  sourceHeaders?: Record<string, string | undefined>;
};

export type X402SpendEnvelope = {
  maxSpendAtomic: string;
  amountRequiredAtomic?: string;
  remainingAfterPaymentAtomic?: string;
};

export type X402BuyerFlowInput = {
  method: string;
  url: string;
  body?: string;
  signer: string;
  challengeSource: 'directory' | 'payment-required-header' | 'x-payment-required-header' | 'body' | 'manual' | 'none';
  challenge?: X402BuyerChallenge;
  allowedNetworks: string[];
  allowedAssets: string[];
  maxSpendAtomic: string | bigint;
  dryRunCompleted: boolean;
  approvalState: 'approved' | 'pending' | 'declined' | 'not_required';
  idempotencyKey?: string;
  typedError?: X402TypedPaymentError;
  quota?: X402QuotaEnvelope;
  mcpTools: string[];
  audit: {
    destination?: string;
    correlationId?: string;
    receiptSink?: string;
  };
};

export type X402BuyerFlowResult = {
  ok: boolean;
  idempotencyKey: string;
  failures: string[];
  warnings: string[];
  parity: {
    discover: boolean;
    check: boolean;
    dryRun: boolean;
    pay: boolean;
    spendLimit: boolean;
    idempotency: boolean;
    mcpExposure: boolean;
    audit: boolean;
    typedErrors: boolean;
    retryability: boolean;
    quotaEnvelope: boolean;
    noChargeFailures: boolean;
  };
  recovery: {
    errorName?: X402TypedPaymentErrorName;
    retryability: X402Retryability;
    noCharge: boolean;
    quotaVisible: boolean;
  };
  envelope: {
    quota?: X402QuotaEnvelope;
    spend: X402SpendEnvelope;
  };
};

function normalizeMethod(method: string): string {
  return method.trim().toUpperCase();
}

export function createX402IdempotencyKey(input: Pick<X402BuyerFlowInput, 'method' | 'url' | 'body' | 'signer'>): string {
  const hash = createHash('sha256');
  hash.update(normalizeMethod(input.method));
  hash.update('\n');
  hash.update(input.url.trim());
  hash.update('\n');
  hash.update(input.body ?? '');
  hash.update('\n');
  hash.update(input.signer.toLowerCase());
  return hash.digest('hex');
}

function parsePositiveAmount(value: string | bigint | undefined): bigint | null {
  if (typeof value === 'bigint') return value > 0n ? value : null;
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : null;
}

function isNonZeroEvmAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(normalized) && normalized !== '0x0000000000000000000000000000000000000000';
}

function parseNonNegativeEnvelopeValue(value: string | number | undefined): bigint | null {
  if (value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) return null;
    return BigInt(value);
  }
  if (!/^\d+$/.test(value)) return null;
  return BigInt(value);
}

function hasQuotaVisibility(quota: X402QuotaEnvelope | undefined): boolean {
  if (!quota) return false;
  return Boolean(quota.limit !== undefined || quota.remaining !== undefined || quota.resetAt || Object.keys(quota.sourceHeaders ?? {}).length > 0);
}

function calculateRemainingAfterPayment(maxSpend: bigint | null, amountRequired: bigint | null): string | undefined {
  if (!maxSpend || !amountRequired || amountRequired > maxSpend) return undefined;
  return (maxSpend - amountRequired).toString();
}

export function classifyX402PaymentError(error?: X402TypedPaymentError, quota?: X402QuotaEnvelope): X402Retryability {
  if (!error) return 'do_not_retry';

  switch (error.name) {
    case 'PaymentRequiredError':
      return 'retry_after_payment';
    case 'QuotaExceededError':
      return hasQuotaVisibility(quota) ? 'retry_after_quota_reset' : 'operator_review';
    case 'TokenExpiredError':
      return 'refresh_token_then_retry';
    case 'ValidationFailureError':
    case 'SpendLimitExceededError':
      return 'do_not_retry';
    case 'UnknownPaymentError':
    default:
      return 'operator_review';
  }
}

export function verifyX402BuyerFlow(input: X402BuyerFlowInput): X402BuyerFlowResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const expectedIdempotencyKey = createX402IdempotencyKey(input);
  const maxSpend = parsePositiveAmount(input.maxSpendAtomic);
  const amountRequired = parsePositiveAmount(input.challenge?.amountRequired);
  const toolSet = new Set(input.mcpTools);
  const quotaLimit = parseNonNegativeEnvelopeValue(input.quota?.limit);
  const quotaRemaining = parseNonNegativeEnvelopeValue(input.quota?.remaining);
  const quotaVisible = hasQuotaVisibility(input.quota);
  const retryability = classifyX402PaymentError(input.typedError, input.quota);

  try {
    new URL(input.url);
  } catch {
    failures.push('Buyer flow URL must be an absolute URL before any payment check runs.');
  }

  if (input.challengeSource === 'none') {
    failures.push('Buyer flow must discover or inspect a 402 challenge before payment.');
  }

  if (!input.challenge?.network || !input.allowedNetworks.includes(input.challenge.network)) {
    failures.push('Challenge network must match the buyer allowlist.');
  }

  const asset = input.challenge?.asset?.toLowerCase();
  const allowedAssets = input.allowedAssets.map((item) => item.toLowerCase());
  if (!asset || !allowedAssets.includes(asset)) {
    failures.push('Challenge asset must match the buyer allowlist.');
  }

  if (!isNonZeroEvmAddress(input.challenge?.payTo)) {
    failures.push('Challenge payTo must be a non-zero EVM recipient before signing.');
  }

  if (!maxSpend) {
    failures.push('Buyer flow must set a positive max spend cap.');
  }

  if (!amountRequired) {
    failures.push('Challenge must include a positive amount before dry-run or pay.');
  }

  if (maxSpend && amountRequired && amountRequired > maxSpend) {
    failures.push('Challenge amount exceeds the buyer max spend cap.');
  }

  if (!input.dryRunCompleted) {
    failures.push('Buyer flow must complete a dry-run plan before signing.');
  }

  if (input.approvalState !== 'approved' && input.approvalState !== 'not_required') {
    failures.push(`Buyer flow approval state must be approved or not_required before signing; received ${input.approvalState}.`);
  }

  if (input.idempotencyKey && input.idempotencyKey !== expectedIdempotencyKey) {
    failures.push('Provided idempotency key does not match method, URL, body, and signer.');
  }

  if (input.typedError && !input.typedError.noCharge) {
    failures.push('Typed payment errors must explicitly preserve no-charge failure semantics before retry or operator action.');
  }

  if (input.typedError?.name === 'QuotaExceededError' && !quotaVisible) {
    failures.push('QuotaExceededError must include quota visibility from X-Quota-* headers or an equivalent envelope.');
  }

  if (input.typedError?.name === 'TokenExpiredError' && retryability !== 'refresh_token_then_retry') {
    failures.push('TokenExpiredError must map to refresh_token_then_retry recovery guidance.');
  }

  if (input.quota?.limit !== undefined && quotaLimit === null) {
    failures.push('Quota envelope limit must be a non-negative integer when present.');
  }

  if (input.quota?.remaining !== undefined && quotaRemaining === null) {
    failures.push('Quota envelope remaining must be a non-negative integer when present.');
  }

  if (quotaLimit !== null && quotaRemaining !== null && quotaRemaining > quotaLimit) {
    failures.push('Quota envelope remaining must not exceed quota limit.');
  }

  for (const requiredTool of ['x402_pay', 'check_budget', 'set_spend_policy', 'get_transaction_history']) {
    if (!toolSet.has(requiredTool)) {
      failures.push(`MCP exposure is missing required AgentPay tool: ${requiredTool}.`);
    }
  }

  if (!toolSet.has('queue_approval')) {
    warnings.push('queue_approval is not listed. Human approval should be explicit for above-threshold payments.');
  }

  if (!input.audit.destination || !input.audit.correlationId || !input.audit.receiptSink) {
    failures.push('Buyer flow audit must include destination, correlationId, and receiptSink.');
  }

  return {
    ok: failures.length === 0,
    idempotencyKey: expectedIdempotencyKey,
    failures,
    warnings,
    parity: {
      discover: input.challengeSource !== 'none',
      check: Boolean(input.challenge?.network && input.challenge?.asset && input.challenge?.payTo && input.challenge?.amountRequired),
      dryRun: input.dryRunCompleted,
      pay: input.approvalState === 'approved' || input.approvalState === 'not_required',
      spendLimit: Boolean(maxSpend && (!amountRequired || amountRequired <= maxSpend)),
      idempotency: !input.idempotencyKey || input.idempotencyKey === expectedIdempotencyKey,
      mcpExposure: ['x402_pay', 'check_budget', 'set_spend_policy', 'get_transaction_history'].every((tool) => toolSet.has(tool)),
      audit: Boolean(input.audit.destination && input.audit.correlationId && input.audit.receiptSink),
      typedErrors: Boolean(input.typedError?.name),
      retryability: Boolean(input.typedError),
      quotaEnvelope: quotaVisible,
      noChargeFailures: input.typedError ? input.typedError.noCharge : true,
    },
    recovery: {
      errorName: input.typedError?.name,
      retryability,
      noCharge: input.typedError ? input.typedError.noCharge : true,
      quotaVisible,
    },
    envelope: {
      quota: input.quota,
      spend: {
        maxSpendAtomic: maxSpend?.toString() ?? String(input.maxSpendAtomic),
        amountRequiredAtomic: amountRequired?.toString(),
        remainingAfterPaymentAtomic: calculateRemainingAfterPayment(maxSpend, amountRequired),
      },
    },
  };
}
