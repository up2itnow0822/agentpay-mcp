/**
 * Authorized cybersecurity-scan payment profile helpers.
 *
 * Paid security tools need tighter guards than general data APIs. These helpers
 * require target authorization, allowed-domain binding, per-target spend caps,
 * scan-rate policy, human approval, and audit receipt language before x402
 * signing can proceed.
 */

import { z } from 'zod';

const isoDateString = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'must be an ISO-8601 timestamp',
});

const positiveIntegerString = z
  .string()
  .regex(/^\d+$/)
  .refine((value) => BigInt(value) > 0n, { message: 'amount must be greater than zero' });

export const AuthorizedCyberScanProfileSchema = z.object({
  schema: z.literal('agentpay-authorized-cybersecurity-scan-profile/v1'),
  generated_at: isoDateString,
  scan: z.object({
    tool_id: z.string().min(1),
    category: z.enum(['vulnerability_scan', 'compliance_check', 'threat_intel_lookup', 'security_audit']),
    target: z.string().min(1),
    target_domain: z.string().min(1),
    requested_by_agent: z.string().min(1),
  }),
  authorization: z.object({
    attestation_id: z.string().min(1),
    granted_by: z.string().min(1),
    granted_at: isoDateString,
    expires_at: isoDateString,
    allowed_domains: z.array(z.string().min(1)).min(1),
    allowed_scan_categories: z.array(z.enum(['vulnerability_scan', 'compliance_check', 'threat_intel_lookup', 'security_audit'])).min(1),
    proof_uri: z.string().url().optional(),
  }),
  spend_policy: z.object({
    currency: z.literal('USD'),
    per_target_cap_usd: z.number().positive(),
    spent_for_target_usd: z.number().nonnegative(),
    requested_cost_usd: z.number().positive(),
    x402_max_amount_required: positiveIntegerString,
  }),
  rate_limit: z.object({
    window_seconds: z.number().int().positive(),
    max_scans_per_window: z.number().int().positive(),
    scans_used_in_window: z.number().int().nonnegative(),
  }),
  approval_gate: z.object({
    fail_closed: z.literal(true),
    requires_human_approval: z.literal(true),
    approved: z.boolean(),
    prompt: z.string().min(1),
  }),
  audit_receipt: z.object({
    receipt_id: z.string().min(1),
    retention_days: z.number().int().positive(),
    language: z.string().min(40),
  }),
});

export type AuthorizedCyberScanProfile = z.infer<typeof AuthorizedCyberScanProfileSchema>;

export type AuthorizedCyberScanPolicy = {
  now?: Date;
  allowedDomains: string[];
  maxRequestedCostUsd: number;
  minReceiptRetentionDays: number;
};

export type AuthorizedCyberScanDecision = {
  ok: boolean;
  failures: string[];
  warnings: string[];
};

function sameDomain(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function includesDomain(domains: string[], targetDomain: string): boolean {
  return domains.some((domain) => sameDomain(domain, targetDomain));
}

export function evaluateAuthorizedCyberScanProfile(
  profileInput: unknown,
  policy: AuthorizedCyberScanPolicy
): AuthorizedCyberScanDecision {
  const parsed = AuthorizedCyberScanProfileSchema.safeParse(profileInput);
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!parsed.success) {
    return {
      ok: false,
      failures: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      warnings,
    };
  }

  const profile = parsed.data;
  const now = policy.now ?? new Date();
  const expiresAt = new Date(profile.authorization.expires_at);
  const grantedAt = new Date(profile.authorization.granted_at);

  if (grantedAt.getTime() > now.getTime()) {
    failures.push('Target authorization is not active yet.');
  }

  if (expiresAt.getTime() <= now.getTime()) {
    failures.push('Target authorization is expired.');
  }

  if (!includesDomain(profile.authorization.allowed_domains, profile.scan.target_domain)) {
    failures.push(`Target domain ${profile.scan.target_domain} is not listed in the authorization attestation.`);
  }

  if (!includesDomain(policy.allowedDomains, profile.scan.target_domain)) {
    failures.push(`Target domain ${profile.scan.target_domain} is not allowed by buyer policy.`);
  }

  if (!profile.authorization.allowed_scan_categories.includes(profile.scan.category)) {
    failures.push(`Scan category ${profile.scan.category} is not authorized for target ${profile.scan.target_domain}.`);
  }

  if (profile.spend_policy.requested_cost_usd > policy.maxRequestedCostUsd) {
    failures.push(`Requested scan cost ${profile.spend_policy.requested_cost_usd} exceeds buyer max ${policy.maxRequestedCostUsd}.`);
  }

  if (profile.spend_policy.spent_for_target_usd + profile.spend_policy.requested_cost_usd > profile.spend_policy.per_target_cap_usd) {
    failures.push('Requested scan would exceed the per-target spend cap.');
  }

  if (profile.rate_limit.scans_used_in_window >= profile.rate_limit.max_scans_per_window) {
    failures.push('Scan rate limit is exhausted for this target window.');
  }

  if (!profile.approval_gate.approved) {
    failures.push('Human approval has not been granted for this paid cybersecurity scan.');
  }

  if (!profile.approval_gate.prompt.includes(profile.scan.target_domain)) {
    warnings.push('Approval prompt does not name the target domain.');
  }

  if (profile.audit_receipt.retention_days < policy.minReceiptRetentionDays) {
    failures.push(`Audit receipt retention ${profile.audit_receipt.retention_days} days is below required ${policy.minReceiptRetentionDays}.`);
  }

  const language = profile.audit_receipt.language.toLowerCase();
  for (const requiredPhrase of ['authorized target', 'spend cap', 'x402 receipt']) {
    if (!language.includes(requiredPhrase)) {
      failures.push(`Audit receipt language must include "${requiredPhrase}".`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
  };
}
