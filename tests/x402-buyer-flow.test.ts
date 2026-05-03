import { describe, expect, it } from 'vitest';
import { classifyX402PaymentError, createX402IdempotencyKey, verifyX402BuyerFlow } from '../src/utils/x402-buyer-flow.js';

const signer = '0x2222222222222222222222222222222222222222';
const payTo = '0x1111111111111111111111111111111111111111';
const asset = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const baseFlow = {
  method: 'POST',
  url: 'https://paid.example.com/mcp/search',
  body: '{"query":"agent payments"}',
  signer,
  challengeSource: 'payment-required-header' as const,
  challenge: {
    network: 'base-sepolia',
    asset,
    amountRequired: '10000',
    payTo,
  },
  allowedNetworks: ['base-sepolia'],
  allowedAssets: [asset],
  maxSpendAtomic: '25000',
  dryRunCompleted: true,
  approvalState: 'approved' as const,
  typedError: {
    name: 'PaymentRequiredError' as const,
    noCharge: true,
  },
  quota: {
    limit: '100',
    remaining: '99',
    resetAt: '2026-05-02T10:00:00Z',
    sourceHeaders: {
      'X-Quota-Limit': '100',
      'X-Quota-Remaining': '99',
      'X-Quota-Reset': '2026-05-02T10:00:00Z',
    },
  },
  mcpTools: ['x402_pay', 'check_budget', 'set_spend_policy', 'get_transaction_history', 'queue_approval'],
  audit: {
    destination: 'otel',
    correlationId: 'tool-call-abc',
    receiptSink: 'transaction-history',
  },
};

describe('x402 buyer-flow parity helper', () => {
  it('accepts a complete discover, check, dry-run, pay, spend-cap, idempotency, MCP, and audit flow', () => {
    const idempotencyKey = createX402IdempotencyKey(baseFlow);
    const result = verifyX402BuyerFlow({ ...baseFlow, idempotencyKey });

    expect(result.ok).toBe(true);
    expect(result.idempotencyKey).toBe(idempotencyKey);
    expect(result.parity).toEqual({
      discover: true,
      check: true,
      dryRun: true,
      pay: true,
      spendLimit: true,
      idempotency: true,
      mcpExposure: true,
      audit: true,
      typedErrors: true,
      retryability: true,
      quotaEnvelope: true,
      noChargeFailures: true,
    });
    expect(result.recovery).toEqual({
      errorName: 'PaymentRequiredError',
      retryability: 'retry_after_payment',
      noCharge: true,
      quotaVisible: true,
    });
    expect(result.envelope.spend).toEqual({
      maxSpendAtomic: '25000',
      amountRequiredAtomic: '10000',
      remainingAfterPaymentAtomic: '15000',
    });
  });

  it('fails closed before payment when buyer controls are incomplete', () => {
    const result = verifyX402BuyerFlow({
      ...baseFlow,
      challengeSource: 'none',
      challenge: {
        network: 'solana-devnet',
        asset: 'So11111111111111111111111111111111111111112',
        amountRequired: '50000',
        payTo: '0x0000000000000000000000000000000000000000',
      },
      dryRunCompleted: false,
      approvalState: 'pending',
      typedError: {
        name: 'QuotaExceededError',
        noCharge: false,
      },
      quota: {
        limit: '10',
        remaining: '11',
      },
      mcpTools: ['x402_pay'],
      audit: {},
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'Buyer flow must discover or inspect a 402 challenge before payment.',
        'Challenge network must match the buyer allowlist.',
        'Challenge asset must match the buyer allowlist.',
        'Challenge payTo must be a non-zero EVM recipient before signing.',
        'Challenge amount exceeds the buyer max spend cap.',
        'Buyer flow must complete a dry-run plan before signing.',
        'Buyer flow approval state must be approved or not_required before signing; received pending.',
        'Typed payment errors must explicitly preserve no-charge failure semantics before retry or operator action.',
        'Quota envelope remaining must not exceed quota limit.',
        'MCP exposure is missing required AgentPay tool: check_budget.',
        'MCP exposure is missing required AgentPay tool: set_spend_policy.',
        'MCP exposure is missing required AgentPay tool: get_transaction_history.',
        'Buyer flow audit must include destination, correlationId, and receiptSink.',
      ])
    );
  });

  it('maps typed payment errors to deterministic recovery guidance', () => {
    expect(classifyX402PaymentError({ name: 'PaymentRequiredError', noCharge: true })).toBe('retry_after_payment');
    expect(classifyX402PaymentError({ name: 'QuotaExceededError', noCharge: true }, { remaining: '0', resetAt: '2026-05-02T10:00:00Z' })).toBe(
      'retry_after_quota_reset'
    );
    expect(classifyX402PaymentError({ name: 'TokenExpiredError', noCharge: true })).toBe('refresh_token_then_retry');
    expect(classifyX402PaymentError({ name: 'SpendLimitExceededError', noCharge: true })).toBe('do_not_retry');
    expect(classifyX402PaymentError({ name: 'UnknownPaymentError', noCharge: true })).toBe('operator_review');
  });

  it('fails closed when a quota error omits the quota envelope', () => {
    const result = verifyX402BuyerFlow({
      ...baseFlow,
      typedError: {
        name: 'QuotaExceededError',
        noCharge: true,
      },
      quota: undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.recovery.retryability).toBe('operator_review');
    expect(result.failures).toContain('QuotaExceededError must include quota visibility from X-Quota-* headers or an equivalent envelope.');
  });
});
