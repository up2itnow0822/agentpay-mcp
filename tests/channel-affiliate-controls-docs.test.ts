import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const docs = readFileSync('docs/channel-agent-affiliate-controls.md', 'utf8');

describe('channel agent affiliate controls docs', () => {
  it('requires payout caps at contact, agent, and program levels', () => {
    expect(docs).toContain('per_contact_daily_payout_cap_usdc');
    expect(docs).toContain('per_contact_monthly_payout_cap_usdc');
    expect(docs).toContain('agent_daily_payout_cap_usdc');
    expect(docs).toContain('program_monthly_payout_cap_usdc');
    expect(docs).toContain('max_payout_per_paid_call_usdc');
  });

  it('separates per-contact approval from paid tool spend approval', () => {
    expect(docs).toContain('No approval record, no payout accrual');
    expect(docs).toContain('policy_version');
    expect(docs).toContain('Paid tool spend approval and affiliate payout approval are separate decisions');
  });

  it('covers audit trail and optional x402 settlement', () => {
    expect(docs).toContain('channel_affiliate_payout_decision');
    expect(docs).toContain('ledger_entry_id');
    expect(docs).toContain('optional x402 settlement path');
    expect(docs).toContain('x402_settlement_tx');
    expect(docs).toContain('Logs hash contact and referrer identifiers by default');
  });
});
