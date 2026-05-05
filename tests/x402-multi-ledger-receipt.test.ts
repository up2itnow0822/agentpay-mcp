import { describe, expect, it } from 'vitest';
import {
  buildAgentPayBaseReceiptExample,
  buildXrplUnsupportedRefusalExample,
  evaluateX402MultiLedgerReceipt,
  type X402MultiLedgerReceiptPolicy,
} from '../src/utils/x402-multi-ledger-receipt.js';

const basePolicy: X402MultiLedgerReceiptPolicy = {
  supportedLedgerNamespaces: ['eip155'],
  allowedAssets: ['USDC'],
  allowedSettlementTargets: ['0x1111111111111111111111111111111111111111'],
  requireNonCustodialBoundary: true,
  requireVerifiedReceipt: true,
  allowUnsupportedRefusalProof: true,
};

describe('x402 multi-ledger receipt normalization', () => {
  it('allows a verified Base receipt with explicit non-custodial boundary', () => {
    const decision = evaluateX402MultiLedgerReceipt(buildAgentPayBaseReceiptExample(), basePolicy, new Date('2026-05-05T01:11:00.000Z'));
    expect(decision).toMatchObject({ ok: true, decision: 'allow', failures: [] });
  });

  it('fails closed for XRPL until ledger, asset, target, verifier, and signer support exist', () => {
    const decision = evaluateX402MultiLedgerReceipt(buildXrplUnsupportedRefusalExample(), basePolicy, new Date('2026-05-05T01:11:00.000Z'));
    expect(decision.ok).toBe(false);
    expect(decision.decision).toBe('deny');
    expect(decision.failures).toContain('ledger namespace xrpl is not supported by buyer policy.');
    expect(decision.failures).toContain('settlement asset RLUSD or XRP, provider-declared is not allowed.');
    expect(decision.failures).toContain('settlement target unsupported-until-allowlisted is not allowlisted.');
    expect(decision.failures).toContain('non-custodial boundary is required before signing.');
    expect(decision.warnings).toContain('Receipt is an unsupported-ledger refusal proof, not a spend authorization.');
  });

  it('requires Payment-Signature and payment-response header normalization', () => {
    const broken = {
      ...buildAgentPayBaseReceiptExample(),
      payment: {
        x402Version: '2.x',
        paymentHeader: 'X-Payment' as 'Payment-Signature',
        receiptHeader: 'x-payment-response' as 'payment-response',
      },
    };

    const decision = evaluateX402MultiLedgerReceipt(broken, basePolicy, new Date('2026-05-05T01:11:00.000Z'));
    expect(decision.failures).toContain('payment.paymentHeader must be Payment-Signature.');
    expect(decision.failures).toContain('payment.receiptHeader must be payment-response.');
  });
});
