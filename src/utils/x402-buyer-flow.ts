import { createHash } from 'node:crypto';

export type X402BuyerChallenge = {
  network?: string;
  asset?: string;
  amountRequired?: string;
  payTo?: string;
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

export function verifyX402BuyerFlow(input: X402BuyerFlowInput): X402BuyerFlowResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const expectedIdempotencyKey = createX402IdempotencyKey(input);
  const maxSpend = parsePositiveAmount(input.maxSpendAtomic);
  const amountRequired = parsePositiveAmount(input.challenge?.amountRequired);
  const toolSet = new Set(input.mcpTools);

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
    },
  };
}
