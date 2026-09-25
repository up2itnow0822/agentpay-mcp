/**
 * Payment-aware retry helpers for value-pack examples.
 *
 * Blind retries of fetchWithPayment can settle twice: a timeout after the
 * authorization is signed still looks like a failure, so a second attempt
 * signs a new nonce. Callers must not re-enter a paid fetch after payment
 * has been initiated, and budgets must record spend at settlement time.
 */

export interface RetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  onRetry?: (attempt: number, error: Error) => void;
}

export interface PaymentAttemptState {
  paymentInitiated: boolean;
  paymentMade: boolean;
  amountPaidUsd: number;
  txHash?: string;
}

export class PaymentAwareError extends Error {
  readonly paymentInitiated: boolean;
  readonly paymentMade: boolean;
  readonly amountPaidUsd: number;
  readonly txHash?: string;
  override readonly cause?: unknown;

  constructor(message: string, state: PaymentAttemptState & { cause?: unknown }) {
    super(message, state.cause !== undefined ? { cause: state.cause } : undefined);
    this.name = 'PaymentAwareError';
    this.paymentInitiated = state.paymentInitiated;
    this.paymentMade = state.paymentMade;
    this.amountPaidUsd = state.amountPaidUsd;
    this.txHash = state.txHash;
    this.cause = state.cause;
  }
}

export function isPaymentAwareError(err: unknown): err is PaymentAwareError {
  return err instanceof PaymentAwareError;
}

/** Amount that already moved on-chain, if the failure happened after settlement. */
export function settledPaymentAmount(err: unknown): number | null {
  if (err instanceof PaymentAwareError && err.paymentMade && err.amountPaidUsd > 0) {
    return err.amountPaidUsd;
  }
  return null;
}

/**
 * Convert a transport failure into a payment-aware error when authorization
 * already started. Unrelated errors are rethrown unchanged so they can retry.
 */
export function wrapPaymentFailure(err: unknown, state: PaymentAttemptState): never {
  if (state.paymentInitiated || state.paymentMade) {
    const causeMessage = err instanceof Error ? err.message : String(err);
    const phase = state.paymentMade ? 'settled' : 'initiated';
    throw new PaymentAwareError(
      `Payment already ${phase}; refusing a second settlement (${causeMessage})`,
      { ...state, cause: err }
    );
  }
  throw err instanceof Error ? err : new Error(String(err));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with exponential backoff.
 * Never retries PaymentAwareError: a second attempt would be a new payment.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  let lastError: Error = new Error('Unknown error');
  let delay = opts.initialDelayMs;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (lastError instanceof PaymentAwareError) {
        break;
      }

      if (attempt === opts.maxAttempts) break;

      if (opts.onRetry) opts.onRetry(attempt, lastError);

      await sleep(delay);
      delay = Math.min(delay * 2, opts.maxDelayMs);
    }
  }

  throw lastError;
}
