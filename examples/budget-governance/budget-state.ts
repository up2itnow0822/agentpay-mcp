export type SpendCategory = 'data' | 'compute' | 'infra';

export interface GovernanceLimits {
  sessionCapUsd: number;
  perCallCapUsd: number;
  categoryCapsUsd: Record<SpendCategory, number>;
  maxPaymentsPerHour: number;
}

export interface BudgetSnapshot {
  spentTotalUsd: number;
  spentByCategoryUsd: Record<SpendCategory, number>;
  remainingSessionUsd: number;
  paymentsLastHour: number;
  limits: GovernanceLimits;
}

export interface PaymentDecision {
  allowed: boolean;
  reason: string;
  snapshot: BudgetSnapshot;
}

const HOUR_MS = 60 * 60 * 1000;

export class BudgetState {
  private spentTotalUsd = 0;
  private readonly spentByCategoryUsd: Record<SpendCategory, number> = {
    data: 0,
    compute: 0,
    infra: 0,
  };

  private readonly paymentTimestamps: number[] = [];

  constructor(private readonly limits: GovernanceLimits) {}

  getSnapshot(now = Date.now()): BudgetSnapshot {
    this.pruneWindow(now);

    return {
      spentTotalUsd: this.round(this.spentTotalUsd),
      spentByCategoryUsd: {
        data: this.round(this.spentByCategoryUsd.data),
        compute: this.round(this.spentByCategoryUsd.compute),
        infra: this.round(this.spentByCategoryUsd.infra),
      },
      remainingSessionUsd: this.round(Math.max(0, this.limits.sessionCapUsd - this.spentTotalUsd)),
      paymentsLastHour: this.paymentTimestamps.length,
      limits: {
        sessionCapUsd: this.round(this.limits.sessionCapUsd),
        perCallCapUsd: this.round(this.limits.perCallCapUsd),
        categoryCapsUsd: {
          data: this.round(this.limits.categoryCapsUsd.data),
          compute: this.round(this.limits.categoryCapsUsd.compute),
          infra: this.round(this.limits.categoryCapsUsd.infra),
        },
        maxPaymentsPerHour: this.limits.maxPaymentsPerHour,
      },
    };
  }

  authorizeSpend(amountUsd: number, category: SpendCategory, now = Date.now()): PaymentDecision {
    this.pruneWindow(now);

    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return this.reject('Denied: amount must be a finite number greater than zero.', now);
    }

    const currentCategorySpend = this.spentByCategoryUsd[category];

    if (amountUsd > this.limits.perCallCapUsd) {
      return this.reject(`Denied: per-call cap is $${this.limits.perCallCapUsd.toFixed(2)}.`, now);
    }

    if (this.spentTotalUsd + amountUsd > this.limits.sessionCapUsd) {
      return this.reject('Denied: session cap would be exceeded.', now);
    }

    if (currentCategorySpend + amountUsd > this.limits.categoryCapsUsd[category]) {
      return this.reject(`Denied: ${category} category cap would be exceeded.`, now);
    }

    if (this.paymentTimestamps.length >= this.limits.maxPaymentsPerHour) {
      return this.reject('Denied: hourly payment velocity limit reached.', now);
    }

    this.spentTotalUsd += amountUsd;
    this.spentByCategoryUsd[category] += amountUsd;
    this.paymentTimestamps.push(now);

    return {
      allowed: true,
      reason: 'Approved.',
      snapshot: this.getSnapshot(now),
    };
  }

  private reject(reason: string, now: number): PaymentDecision {
    return {
      allowed: false,
      reason,
      snapshot: this.getSnapshot(now),
    };
  }

  private pruneWindow(now: number): void {
    const cutoff = now - HOUR_MS;
    while (this.paymentTimestamps.length > 0 && this.paymentTimestamps[0] < cutoff) {
      this.paymentTimestamps.shift();
    }
  }

  private round(value: number): number {
    return Number(value.toFixed(4));
  }
}

export const defaultBudgetState = new BudgetState({
  sessionCapUsd: 5,
  perCallCapUsd: 1,
  categoryCapsUsd: {
    data: 3,
    compute: 2,
    infra: 1,
  },
  maxPaymentsPerHour: 100,
});
