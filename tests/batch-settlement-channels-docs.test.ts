import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const docs = readFileSync('docs/x402-batch-settlement-channels.md', 'utf8');

describe('x402 batch-settlement channel docs', () => {
  it('covers the full channel lifecycle for paid MCP calls', () => {
    expect(docs).toContain('client deposits once');
    expect(docs).toContain('signs cumulative vouchers');
    expect(docs).toContain('Refund path closes unused channel balance');
    expect(docs).toContain('Claim path proves which cumulative voucher amount was claimed');
  });

  it('requires policy checks for deposits and cumulative voucher caps', () => {
    expect(docs).toContain('per-channel deposit cap');
    expect(docs).toContain('perChannelVoucherCap');
    expect(docs).toContain('approved channel budget exceeded');
    expect(docs).toContain('A skipped facilitator settle call must never skip AgentPay policy');
  });

  it('requires atomic channel storage and corrective 402 recovery', () => {
    expect(docs).toContain('compare-and-set semantics per channel');
    expect(docs).toContain('storage.updateChannel');
    expect(docs).toContain('batch_settlement_cumulative_amount_mismatch');
    expect(docs).toContain('recovery_failed');
  });

  it('documents receiver authorizer pinning and off-chain settlement audit rows', () => {
    expect(docs).toContain('receiverAuthorizer');
    expect(docs).toContain('provider identity');
    expect(docs).toContain('Off-chain settlement audit checklist');
    expect(docs).toContain('channel_id');
    expect(docs).toContain('settlement transaction proof');
  });
});
