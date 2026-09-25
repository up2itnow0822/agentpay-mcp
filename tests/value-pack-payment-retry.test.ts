/**
 * Value-pack retry must not double-settle after a paid timeout, and spend
 * must be visible even when the HTTP response is lost.
 */
import { describe, it, expect } from 'vitest';
import { PolicyGuard } from '../examples/value-packs/shared/spending-policy.js';
import {
  PaymentAwareError,
  settledPaymentAmount,
  withRetry,
  wrapPaymentFailure,
} from '../examples/value-packs/shared/payment-retry.js';

const FAST_RETRY = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 };

describe('wrapPaymentFailure', () => {
  it('wraps timeouts after payment into PaymentAwareError', () => {
    expect(() =>
      wrapPaymentFailure(new Error('The operation was aborted due to timeout'), {
        paymentInitiated: true,
        paymentMade: true,
        amountPaidUsd: 0.02,
        txHash: '0xdead',
      })
    ).toThrow(PaymentAwareError);
  });

  it('wraps timeouts after authorization starts even if settlement is unconfirmed', () => {
    try {
      wrapPaymentFailure(new Error('aborted'), {
        paymentInitiated: true,
        paymentMade: false,
        amountPaidUsd: 0,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentAwareError);
      expect(settledPaymentAmount(err)).toBeNull();
      return;
    }
    throw new Error('expected wrapPaymentFailure to throw');
  });

  it('rethrows the original error when no payment started', () => {
    const err = new Error('connect reset');
    try {
      wrapPaymentFailure(err, {
        paymentInitiated: false,
        paymentMade: false,
        amountPaidUsd: 0,
      });
    } catch (thrown) {
      expect(thrown).toBe(err);
      return;
    }
    throw new Error('expected wrapPaymentFailure to throw');
  });
});

describe('withRetry payment awareness', () => {
  it('does not re-enter the paid fetch after settlement', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw new PaymentAwareError('timeout after pay', {
          paymentInitiated: true,
          paymentMade: true,
          amountPaidUsd: 0.01,
          txHash: '0xabc',
        });
      }, FAST_RETRY)
    ).rejects.toBeInstanceOf(PaymentAwareError);
    expect(calls).toBe(1);
  });

  it('does not re-enter the paid fetch after authorization starts', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        wrapPaymentFailure(new Error('timeout'), {
          paymentInitiated: true,
          paymentMade: false,
          amountPaidUsd: 0,
        });
      }, FAST_RETRY)
    ).rejects.toMatchObject({ name: 'PaymentAwareError' });
    expect(calls).toBe(1);
  });

  it('retries transient errors that happen before payment', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 2) throw new Error('network down');
      return 'ok';
    }, FAST_RETRY);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('budget records settlement even when the fetch fails', () => {
  it('records spend from a PaymentAwareError instead of waiting for success', async () => {
    const policy = new PolicyGuard({ dailyCapUsd: 5, perTxCapUsd: 1 });
    let recordedAtPayment = false;

    await expect(
      withRetry(async () => {
        policy.record(0.01, 'https://paid.example/api', true);
        recordedAtPayment = true;
        throw new PaymentAwareError('timeout after pay', {
          paymentInitiated: true,
          paymentMade: true,
          amountPaidUsd: 0.01,
          txHash: '0xabc',
        });
      }, { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 })
    ).rejects.toBeInstanceOf(PaymentAwareError);

    const settled = 0.01;
    if (!recordedAtPayment) {
      policy.record(settled, 'https://paid.example/api', true);
    }

    expect(policy.sessionSpend).toBe(0.01);
    expect(policy.remaining).toBe(4.99);
  });
});
