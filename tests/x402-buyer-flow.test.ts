import { describe, expect, it } from 'vitest';
import { createX402IdempotencyKey, verifyX402BuyerFlow } from '../src/utils/x402-buyer-flow.js';

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
        'MCP exposure is missing required AgentPay tool: check_budget.',
        'MCP exposure is missing required AgentPay tool: set_spend_policy.',
        'MCP exposure is missing required AgentPay tool: get_transaction_history.',
        'Buyer flow audit must include destination, correlationId, and receiptSink.',
      ])
    );
  });
});
