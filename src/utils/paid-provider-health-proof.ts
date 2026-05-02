/**
 * Paid-provider health proof verification helpers.
 *
 * Buyer agents should not route paid work from a marketplace-level "up" flag.
 * They need provider-level success, stale streak, receipt, and x402 payment
 * metadata checks before a wallet signs. These helpers validate that proof and
 * fail closed when the feed is stale, incomplete, inconsistent, or points at an
 * unexpected network, asset, or recipient.
 */

import { z } from 'zod';

const isoDateString = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'must be an ISO-8601 timestamp',
});

const nonZeroEvmAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/)
  .refine((value) => value.toLowerCase() !== '0x0000000000000000000000000000000000000000', {
    message: 'payTo must not be the zero address',
  });

const positiveIntegerString = z
  .string()
  .regex(/^\d+$/)
  .refine((value) => BigInt(value) > 0n, { message: 'amount must be greater than zero' });

export const X402ProviderPaymentMetadataSchema = z.object({
  scheme: z.literal('exact').default('exact'),
  network: z.string().min(1),
  asset: z.string().min(1),
  payTo: nonZeroEvmAddress,
  amountRequired: positiveIntegerString.optional(),
  maxAmountRequired: positiveIntegerString.optional(),
  resource: z.string().url().optional(),
  facilitator: z.string().min(1).optional(),
});

export const PaidProviderHealthProofSchema = z.object({
  schema: z.literal('agentpay-paid-provider-health-proof/v1'),
  generated_at: isoDateString,
  source: z.object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    commit: z.string().min(7).optional(),
    raw_schema: z.string().min(1).optional(),
  }),
  health: z.object({
    ok: z.boolean(),
    latency_ms: z.number().nonnegative().optional(),
  }),
  ok: z.boolean(),
  summary: z.object({
    providers_probed: z.number().int().nonnegative(),
    providers_ok: z.number().int().nonnegative(),
    providers_failing: z.number().int().nonnegative(),
    success_rate: z.number().min(0).max(1),
  }),
  providers: z.array(
    z.object({
      provider_id: z.string().min(1),
      capability: z.string().min(1).optional(),
      capability_id: z.string().min(1).optional(),
      status: z.enum(['ok', 'failed', 'stale', 'unknown']),
      stale_streak: z.number().int().nonnegative(),
      receipt_state: z.enum(['verified', 'pending_acceptance_verified', 'missing', 'invalid', 'unverified']),
      receipt_id: z.string().min(1).optional(),
      verified: z.boolean(),
      latency_ms: z.number().nonnegative().optional(),
      error: z.string().min(1).optional(),
      x402_payment: X402ProviderPaymentMetadataSchema.optional(),
    })
  ),
  routing: z.object({
    fail_closed: z.literal(true),
    decision: z.enum(['allow', 'deny', 'degraded']),
    reason: z.array(z.string().min(1)),
  }),
});

export type PaidProviderHealthProof = z.infer<typeof PaidProviderHealthProofSchema>;
export type X402ProviderPaymentMetadata = z.infer<typeof X402ProviderPaymentMetadataSchema>;

export type PaidProviderHealthPolicy = {
  minimumSuccessRate: number;
  maxProofAgeMs: number;
  maxProviderStaleStreak: number;
  allowedNetworks: string[];
  allowedAssets: string[];
  allowedPayTo: string[];
  requireVerifiedReceipt: boolean;
  requireX402PaymentMetadata: boolean;
};

export type PaidProviderHealthVerificationResult = {
  ok: boolean;
  failures: string[];
  warnings: string[];
  eligibleProviders: string[];
};

function paymentAmount(payment: X402ProviderPaymentMetadata): bigint | null {
  const rawAmount = payment.maxAmountRequired ?? payment.amountRequired;
  return rawAmount ? BigInt(rawAmount) : null;
}

function successRate(providersOk: number, providersProbed: number): number {
  return providersProbed === 0 ? 0 : providersOk / providersProbed;
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.000001;
}

function includesCaseInsensitive(values: string[], value: string): boolean {
  return values.map((entry) => entry.toLowerCase()).includes(value.toLowerCase());
}

export function verifyPaidProviderHealthProof(
  proofInput: unknown,
  policy: PaidProviderHealthPolicy,
  now = new Date()
): PaidProviderHealthVerificationResult {
  const parsed = PaidProviderHealthProofSchema.safeParse(proofInput);
  const failures: string[] = [];
  const warnings: string[] = [];
  const eligibleProviders: string[] = [];

  if (!parsed.success) {
    return {
      ok: false,
      failures: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      warnings,
      eligibleProviders,
    };
  }

  const proof = parsed.data;
  const proofAgeMs = now.getTime() - Date.parse(proof.generated_at);

  if (proofAgeMs < 0) {
    failures.push('Health proof timestamp is in the future.');
  }

  if (proofAgeMs > policy.maxProofAgeMs) {
    failures.push(`Health proof is stale: age ${proofAgeMs}ms exceeds ${policy.maxProofAgeMs}ms.`);
  }

  if (!proof.health.ok) {
    failures.push('Base health flag is false.');
  }

  if (!proof.ok) {
    failures.push('Top-level provider health flag is false.');
  }

  if (!proof.routing.fail_closed) {
    failures.push('Routing proof must set fail_closed=true.');
  }

  if (proof.routing.decision === 'allow' && !proof.ok) {
    failures.push('Routing decision cannot allow paid work when top-level ok=false.');
  }

  const providersOk = proof.providers.filter((provider) => provider.status === 'ok').length;
  const providersFailing = proof.providers.length - providersOk;
  const expectedSuccessRate = successRate(providersOk, proof.providers.length);

  if (proof.summary.providers_probed !== proof.providers.length) {
    failures.push('summary.providers_probed does not match providers.length.');
  }

  if (proof.summary.providers_ok !== providersOk) {
    failures.push('summary.providers_ok does not match providers with status ok.');
  }

  if (proof.summary.providers_failing !== providersFailing) {
    failures.push('summary.providers_failing does not match providers without status ok.');
  }

  if (!closeEnough(proof.summary.success_rate, expectedSuccessRate)) {
    failures.push('summary.success_rate does not match providers_ok / providers_probed.');
  }

  if (proof.summary.success_rate < policy.minimumSuccessRate) {
    failures.push(
      `Provider success_rate ${proof.summary.success_rate} is below required ${policy.minimumSuccessRate}.`
    );
  }

  for (const provider of proof.providers) {
    const providerFailures: string[] = [];

    if (provider.status !== 'ok') {
      providerFailures.push(`status=${provider.status}`);
    }

    if (provider.stale_streak > policy.maxProviderStaleStreak) {
      providerFailures.push(`stale_streak=${provider.stale_streak}`);
    }

    if (policy.requireVerifiedReceipt && !provider.verified) {
      providerFailures.push(`receipt_state=${provider.receipt_state}`);
    }

    if (policy.requireX402PaymentMetadata && !provider.x402_payment) {
      providerFailures.push('missing x402_payment metadata');
    }

    if (provider.x402_payment) {
      const payment = provider.x402_payment;
      const amount = paymentAmount(payment);

      if (!policy.allowedNetworks.includes(payment.network)) {
        providerFailures.push(`network=${payment.network} is not allowed`);
      }

      if (!includesCaseInsensitive(policy.allowedAssets, payment.asset)) {
        providerFailures.push(`asset=${payment.asset} is not allowed`);
      }

      if (!includesCaseInsensitive(policy.allowedPayTo, payment.payTo)) {
        providerFailures.push(`payTo=${payment.payTo} is not allowed`);
      }

      if (amount === null) {
        providerFailures.push('missing x402 amountRequired or maxAmountRequired');
      }
    }

    if (providerFailures.length > 0) {
      failures.push(`${provider.provider_id}: ${providerFailures.join('; ')}.`);
    } else {
      eligibleProviders.push(provider.provider_id);
    }
  }

  if (eligibleProviders.length === 0) {
    failures.push('No provider passed status, stale streak, receipt, and x402 payment metadata checks.');
  }

  if (proof.routing.decision === 'degraded') {
    warnings.push('Routing decision is degraded; buyers should require explicit fallback policy before payment.');
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    eligibleProviders,
  };
}
