/**
 * shared/spending-policy.ts — SpendingPolicy wrapper with sensible defaults
 *
 * Wraps the agentwallet-sdk SpendingPolicy to enforce:
 *  - Daily spend cap (rolling 24-hour window)
 *  - Per-transaction cap
 *  - Human approval threshold
 *
 * The policy is purely in-process; it tracks cumulative spend for
 * the lifetime of the script run. For persistent cross-session limits,
 * use on-chain budget controls via set_spend_policy in the MCP server.
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface PolicyConfig {
  /** Maximum total USD spend per day (rolling 24h). Default: $5 */
  dailyCapUsd: number;
  /** Maximum USD per individual transaction. Default: $1 */
  perTxCapUsd: number;
  /** Require human approval for any payment above this amount. Default: $0.50 */
  approvalThresholdUsd: number;
}

export interface SpendRecord {
  amountUsd: number;
  endpoint: string;
  timestamp: number;
  approved: boolean;
}

// ─── Default policy ────────────────────────────────────────────────────────

export const DEFAULT_POLICY: PolicyConfig = {
  dailyCapUsd: 5.0,
  perTxCapUsd: 1.0,
  approvalThresholdUsd: 0.50,
};

// ─── PolicyGuard ───────────────────────────────────────────────────────────

/**
 * In-process spending tracker and guard.
 *
 * Usage:
 *   const guard = new PolicyGuard({ dailyCapUsd: 5 });
 *   guard.checkCanSpend(0.25, 'api endpoint');  // throws if over cap
 *   guard.record(0.25, 'api endpoint', true);
 */
export class PolicyGuard {
  readonly config: PolicyConfig;
  private readonly spendLog: SpendRecord[] = [];

  constructor(config: Partial<PolicyConfig> = {}) {
    this.config = { ...DEFAULT_POLICY, ...config };
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /** Total USD spent in the rolling 24-hour window */
  get dailySpend(): number {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.spendLog
      .filter((r) => r.timestamp > cutoff && r.approved)
      .reduce((sum, r) => sum + r.amountUsd, 0);
  }

  /** Total USD spent this session (all time, not rolling) */
  get sessionSpend(): number {
    return this.spendLog.filter((r) => r.approved).reduce((sum, r) => sum + r.amountUsd, 0);
  }

  /** How much budget remains in the 24-hour window */
  get remaining(): number {
    return Math.max(0, this.config.dailyCapUsd - this.dailySpend);
  }

  /** Full spend history */
  get history(): SpendRecord[] {
    return [...this.spendLog];
  }

  // ── Guards ────────────────────────────────────────────────────────────────

  /**
   * Check whether a spend is allowed. Throws a descriptive error if not.
   * Does NOT record the spend — call record() after user approval.
   */
  checkCanSpend(amountUsd: number, endpoint: string): void {
    if (amountUsd > this.config.perTxCapUsd) {
      throw new PolicyError(
        `Payment of $${amountUsd.toFixed(4)} exceeds per-transaction cap of $${this.config.perTxCapUsd.toFixed(2)}.`,
        'PER_TX_CAP',
        { amountUsd, endpoint }
      );
    }

    if (this.dailySpend + amountUsd > this.config.dailyCapUsd) {
      throw new PolicyError(
        `Payment of $${amountUsd.toFixed(4)} would exceed daily cap of $${this.config.dailyCapUsd.toFixed(2)} ` +
        `(already spent $${this.dailySpend.toFixed(4)} today).`,
        'DAILY_CAP',
        { amountUsd, endpoint, dailySpend: this.dailySpend }
      );
    }
  }

  /**
   * Returns true if this payment requires human approval.
   */
  requiresApproval(amountUsd: number): boolean {
    return amountUsd >= this.config.approvalThresholdUsd;
  }

  /**
   * Record a spend event (call after user approves and payment succeeds).
   */
  record(amountUsd: number, endpoint: string, approved: boolean): void {
    this.spendLog.push({
      amountUsd,
      endpoint,
      timestamp: Date.now(),
      approved,
    });
  }

  /**
   * Estimate whether a set of planned spends fits within budget.
   * Returns { fits: boolean; wouldSpend: number; remaining: number }
   */
  estimateBudget(plannedSpends: number[]): {
    fits: boolean;
    wouldSpend: number;
    remaining: number;
  } {
    const wouldSpend = plannedSpends.reduce((a, b) => a + b, 0);
    const remaining = this.remaining;
    return {
      fits: wouldSpend <= remaining,
      wouldSpend,
      remaining,
    };
  }

  /**
   * Return a human-readable summary of the policy and current spend.
   */
  summary(): string {
    const lines = [
      `Daily cap:     $${this.config.dailyCapUsd.toFixed(2)}`,
      `Per-tx cap:    $${this.config.perTxCapUsd.toFixed(2)}`,
      `Approval gate: $${this.config.approvalThresholdUsd.toFixed(2)}+`,
      `Spent today:   $${this.dailySpend.toFixed(4)}`,
      `Remaining:     $${this.remaining.toFixed(4)}`,
    ];
    return lines.join('\n');
  }
}

// ─── PolicyError ───────────────────────────────────────────────────────────

export class PolicyError extends Error {
  readonly code: string;
  readonly context: Record<string, unknown>;

  constructor(message: string, code: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
    this.context = context;
  }
}

// ─── USD conversion helpers ────────────────────────────────────────────────

/**
 * Convert a payment amount in USDC (6 decimals) to USD float.
 */
export function usdcToUsd(usdcAmount: bigint): number {
  return Number(usdcAmount) / 1_000_000;
}

/**
 * Convert USD float to USDC units (6 decimals).
 * Display/estimation only — payment caps use the exact string parser
 * usdToUsdcBaseUnits() in usdc-approval.ts.
 */
export function usdToUsdc(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

/**
 * Parse a payment amount from an x402 WWW-Authenticate header.
 * Header format: X402-Payment amount=<units>, token=<addr>, ...
 * Returns USD equivalent (assumes USDC-like 6-decimal token unless otherwise noted).
 * Legacy display helper: it does not verify the asset, so never use it to
 * authorize a payment. Payment offers go through selectUsdcOffer().
 */
export function parsePaymentAmountUsd(wwwAuthenticate: string): number | null {
  const match = wwwAuthenticate.match(/amount=(\d+)/);
  if (!match) return null;
  const rawAmount = BigInt(match[1]);
  // Assume USDC (6 decimals) as the most common x402 payment token
  return usdcToUsd(rawAmount);
}
