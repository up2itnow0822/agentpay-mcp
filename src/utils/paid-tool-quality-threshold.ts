/**
 * Paid-tool quality threshold helpers.
 *
 * Buyer agents should not sign x402 payments from a catalog score alone. They
 * need a fresh score, a provider-health snapshot, a minimum-quality policy, and
 * an approval gate that fails closed when the score is stale or below threshold.
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

export const PaidToolQualityProofSchema = z.object({
  schema: z.literal('agentpay-paid-tool-quality-proof/v1'),
  generated_at: isoDateString,
  source: z.object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    commit: z.string().min(7).optional(),
    raw_score_field: z.string().min(1).optional(),
  }),
  tool: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    provider_id: z.string().min(1),
    capability: z.string().min(1),
  }),
  score: z.object({
    current: z.number().min(0).max(100),
    maximum: z.literal(100).default(100),
    min_required: z.number().min(0).max(100),
    measured_at: isoDateString,
    stale_after_seconds: z.number().int().positive(),
    dimensions: z.object({
      reliability: z.number().min(0).max(100),
      availability: z.number().min(0).max(100),
      receipt_integrity: z.number().min(0).max(100),
      policy_fit: z.number().min(0).max(100),
    }),
  }),
  provider_health: z.object({
    status: z.enum(['ok', 'degraded', 'failed', 'unknown']),
    success_rate_24h: z.number().min(0).max(1),
    last_success_at: isoDateString.optional(),
    stale_streak: z.number().int().nonnegative(),
    receipt_state: z.enum(['verified', 'pending_acceptance_verified', 'missing', 'invalid', 'unverified']),
  }),
  x402_payment: z.object({
    scheme: z.literal('exact').default('exact'),
    network: z.string().min(1),
    asset: z.string().min(1),
    payTo: nonZeroEvmAddress,
    maxAmountRequired: positiveIntegerString,
  }),
  approval_gate: z.object({
    fail_closed: z.literal(true),
    requires_human_approval: z.boolean(),
    decision: z.enum(['allow', 'deny']),
    reason: z.array(z.string().min(1)),
  }),
});

export type PaidToolQualityProof = z.infer<typeof PaidToolQualityProofSchema>;

export type PaidToolQualityPolicy = {
  minimumScore: number;
  maxScoreAgeMs: number;
  maxProviderStaleStreak: number;
  minimumSuccessRate24h: number;
  allowedNetworks: string[];
  allowedAssets: string[];
  allowedPayTo: string[];
  requireHumanApproval: boolean;
  requireVerifiedReceipt: boolean;
};

export type PaidToolQualityDecision = {
  ok: boolean;
  decision: 'allow' | 'deny';
  failures: string[];
  warnings: string[];
};

function includesCaseInsensitive(values: string[], value: string): boolean {
  return values.map((entry) => entry.toLowerCase()).includes(value.toLowerCase());
}

function scoreAgeMs(proof: PaidToolQualityProof, now: Date): number {
  return now.getTime() - Date.parse(proof.score.measured_at);
}

export function evaluatePaidToolQualityThreshold(
  proofInput: unknown,
  policy: PaidToolQualityPolicy,
  now = new Date()
): PaidToolQualityDecision {
  const parsed = PaidToolQualityProofSchema.safeParse(proofInput);
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!parsed.success) {
    return {
      ok: false,
      decision: 'deny',
      failures: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      warnings,
    };
  }

  const proof = parsed.data;
  const measuredAgeMs = scoreAgeMs(proof, now);
  const generatedAgeMs = now.getTime() - Date.parse(proof.generated_at);
  const declaredStaleAfterMs = proof.score.stale_after_seconds * 1000;

  if (generatedAgeMs < 0 || measuredAgeMs < 0) {
    failures.push('Quality proof timestamp is in the future.');
  }

  if (generatedAgeMs > policy.maxScoreAgeMs || measuredAgeMs > policy.maxScoreAgeMs) {
    failures.push(`Quality proof is stale for buyer policy: age ${Math.max(generatedAgeMs, measuredAgeMs)}ms exceeds ${policy.maxScoreAgeMs}ms.`);
  }

  if (measuredAgeMs > declaredStaleAfterMs) {
    failures.push(`Quality score is stale by proof contract: age ${measuredAgeMs}ms exceeds ${declaredStaleAfterMs}ms.`);
  }

  if (proof.score.min_required !== policy.minimumScore) {
    warnings.push(`Proof min_required ${proof.score.min_required} differs from buyer policy ${policy.minimumScore}; buyer policy wins.`);
  }

  if (proof.score.current < policy.minimumScore) {
    failures.push(`Quality score ${proof.score.current} is below required ${policy.minimumScore}.`);
  }

  for (const [dimension, value] of Object.entries(proof.score.dimensions)) {
    if (value < policy.minimumScore) {
      warnings.push(`Quality dimension ${dimension}=${value} is below buyer threshold ${policy.minimumScore}.`);
    }
  }

  if (proof.provider_health.status !== 'ok') {
    failures.push(`Provider health status is ${proof.provider_health.status}.`);
  }

  if (proof.provider_health.success_rate_24h < policy.minimumSuccessRate24h) {
    failures.push(`Provider success_rate_24h ${proof.provider_health.success_rate_24h} is below required ${policy.minimumSuccessRate24h}.`);
  }

  if (proof.provider_health.stale_streak > policy.maxProviderStaleStreak) {
    failures.push(`Provider stale_streak ${proof.provider_health.stale_streak} exceeds ${policy.maxProviderStaleStreak}.`);
  }

  if (policy.requireVerifiedReceipt && proof.provider_health.receipt_state !== 'verified') {
    failures.push(`Provider receipt_state is ${proof.provider_health.receipt_state}.`);
  }

  if (!policy.allowedNetworks.includes(proof.x402_payment.network)) {
    failures.push(`x402 network ${proof.x402_payment.network} is not allowed.`);
  }

  if (!includesCaseInsensitive(policy.allowedAssets, proof.x402_payment.asset)) {
    failures.push(`x402 asset ${proof.x402_payment.asset} is not allowed.`);
  }

  if (!includesCaseInsensitive(policy.allowedPayTo, proof.x402_payment.payTo)) {
    failures.push(`x402 payTo ${proof.x402_payment.payTo} is not allowed.`);
  }

  if (!proof.approval_gate.fail_closed) {
    failures.push('approval_gate.fail_closed must be true.');
  }

  if (policy.requireHumanApproval && !proof.approval_gate.requires_human_approval) {
    failures.push('Human approval is required before signing this paid tool call.');
  }

  if (proof.approval_gate.decision === 'allow' && failures.length > 0) {
    failures.push('Approval gate cannot allow paid work while quality threshold checks fail.');
  }

  const ok = failures.length === 0 && proof.approval_gate.decision === 'allow';

  return {
    ok,
    decision: ok ? 'allow' : 'deny',
    failures,
    warnings,
  };
}
