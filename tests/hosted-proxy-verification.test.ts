import { describe, expect, it } from 'vitest';
import { verifyHostedProxyPaymentRequirement } from '../src/utils/hosted-proxy-verification.js';

const USDC_BASE_SEPOLIA = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const PAY_TO = '0x1111111111111111111111111111111111111111';

function paymentRequiredHeader(overrides: Record<string, unknown> = {}): string {
  const payload = {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base-sepolia',
        asset: USDC_BASE_SEPOLIA,
        maxAmountRequired: '10000',
        payTo: PAY_TO,
        resource: 'https://mcp.example.com/mcp/finance',
        ...overrides,
      },
    ],
  };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

describe('hosted x402 proxy verification', () => {
  it('accepts a 402 payment-required header only when buyer controls are already satisfied', () => {
    const result = verifyHostedProxyPaymentRequirement({
      status: 402,
      headers: { 'payment-required': paymentRequiredHeader() },
      allowedNetworks: ['base-sepolia'],
      allowedAssets: [USDC_BASE_SEPOLIA],
      maxAmountRequired: '25000',
      approvalGate: { required: true, state: 'approved' },
      auditLog: { required: true, destination: 'otel', correlationId: 'tool-call-123' },
      upstreamCredentialMode: 'buyer-owned',
    });

    expect(result.ok).toBe(true);
    expect(result.source).toBe('payment-required-header');
    expect(result.offers).toEqual([
      expect.objectContaining({
        network: 'base-sepolia',
        asset: USDC_BASE_SEPOLIA,
        amountRequired: '10000',
        payTo: PAY_TO,
      }),
    ]);
  });

  it('fails closed for zero recipients, disallowed networks, cap overrun, missing approval, missing audit, and unresolved pooled-token lock-in', () => {
    const result = verifyHostedProxyPaymentRequirement({
      status: 402,
      headers: {
        'payment-required': paymentRequiredHeader({
          network: 'base',
          maxAmountRequired: '50000',
          payTo: '0x0000000000000000000000000000000000000000',
        }),
      },
      allowedNetworks: ['base-sepolia'],
      allowedAssets: [USDC_BASE_SEPOLIA],
      maxAmountRequired: '25000',
      approvalGate: { required: true, state: 'pending' },
      auditLog: { required: true, destination: 'otel' },
      upstreamCredentialMode: 'operator-pooled',
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'No offered payment option passed recipient, network, asset, amount, and spend-cap checks.',
        'At least one offered payment option has a missing, malformed, or zero payTo recipient.',
        'Approval gate required state approved before signing; current state is pending.',
        'Audit logging is required before payment; destination and correlationId must both be present.',
        'Upstream credential mode is operator-pooled; buyer must explicitly accept or reject pooled-token lock-in before payment.',
      ])
    );
  });

  it('requires a payment-required header rather than body-only payment metadata', () => {
    const body = Buffer.from(paymentRequiredHeader(), 'base64').toString('utf8');
    const result = verifyHostedProxyPaymentRequirement({
      status: 402,
      body,
      allowedNetworks: ['base-sepolia'],
      allowedAssets: [USDC_BASE_SEPOLIA],
      maxAmountRequired: '25000',
      approvalGate: { required: true, state: 'approved' },
      auditLog: { required: true, destination: 'otel', correlationId: 'tool-call-123' },
      upstreamCredentialMode: 'buyer-owned',
    });

    expect(result.ok).toBe(false);
    expect(result.source).toBe('body');
    expect(result.failures).toContain(
      'Payment requirement was only present in the body; require a payment-required header for buyer verification.'
    );
  });
});
