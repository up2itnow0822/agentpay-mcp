# Channel-agent affiliate payout controls

Axon added off-chain affiliate payouts, a builder dashboard, per-contact payout settings, and prepaid-balance debits on Apr 29. That is the right growth loop for WhatsApp and SMB agents, but it creates payout liability fast.

AgentPay MCP should sit at the spend and settlement boundary: cap payouts, require per-contact approval, write audit rows, and optionally settle affiliate shares through x402 when a channel platform is ready for on-chain receipts.

## Control model

Affiliate payouts need two separate controls:

1. Spend authority for the paid tool call.
2. Payout authority for the revenue share created by that call.

Do not bind both to one approval. A user approving a paid API call did not automatically approve an uncapped affiliate liability.

## Required policy fields

```json
{
  "channel": "whatsapp",
  "agent_id": "agent_123",
  "contact_id_hash": "sha256:...",
  "affiliate_program_id": "axon-affiliate-2026-04",
  "referrer_id_hash": "sha256:...",
  "policy_version": "agentpay-affiliate-policy-2026-04-30",
  "per_contact_approval_required": true,
  "per_contact_daily_payout_cap_usdc": "2.00",
  "per_contact_monthly_payout_cap_usdc": "20.00",
  "agent_daily_payout_cap_usdc": "50.00",
  "program_monthly_payout_cap_usdc": "500.00",
  "max_payout_per_paid_call_usdc": "0.25",
  "settlement_mode": "off_chain_ledger",
  "optional_x402_settlement": true
}
```

Hash contact and referrer identifiers in operational logs. Store raw identifiers only in the system that needs to contact or pay the user.

## Per-contact approval gate

A contact must be approved before affiliate payout accrual starts.

Approval record:

```json
{
  "approval_id": "approval_contact_789",
  "contact_id_hash": "sha256:...",
  "agent_id": "agent_123",
  "affiliate_program_id": "axon-affiliate-2026-04",
  "approved_by": "operator",
  "approved_at": "2026-04-30T05:14:00Z",
  "expires_at": "2026-05-30T05:14:00Z",
  "policy_version": "agentpay-affiliate-policy-2026-04-30"
}
```

Rules:

- No approval record, no payout accrual.
- Expired approval, no payout accrual.
- Policy version mismatch, route to reapproval.
- Contact-level cap exceeded, stop accrual for that contact and keep the paid tool policy independent.
- Program-level cap exceeded, stop all affiliate accrual until the operator raises or resets the cap.

## Audit trail

Every affiliate payout decision should write a row before money moves.

```json
{
  "event_type": "channel_affiliate_payout_decision",
  "channel": "whatsapp",
  "agent_id": "agent_123",
  "contact_id_hash": "sha256:...",
  "referrer_id_hash": "sha256:...",
  "paid_tool_call_id": "tool_call_456",
  "approval_id": "approval_contact_789",
  "policy_version": "agentpay-affiliate-policy-2026-04-30",
  "gross_call_revenue_usdc": "1.00",
  "proposed_payout_usdc": "0.10",
  "decision": "approved",
  "decision_reason": "within_per_contact_and_program_caps",
  "ledger_entry_id": "ledger_abc",
  "x402_settlement_tx": null,
  "created_at": "2026-04-30T05:14:00Z"
}
```

Decision reasons should be machine-readable:

- `approved`
- `missing_contact_approval`
- `contact_daily_cap_exceeded`
- `contact_monthly_cap_exceeded`
- `agent_daily_cap_exceeded`
- `program_monthly_cap_exceeded`
- `policy_version_mismatch`
- `settlement_failed`

## Optional x402 settlement path

The optional x402 settlement path keeps off-chain affiliate ledgers from becoming a dead end.

Off-chain ledgers are useful while channel platforms move quickly. They need a clean path to x402 settlement when payout volumes justify it.

Settlement flow:

1. Paid MCP tool call completes under the normal AgentPay MCP policy.
2. Affiliate payout decision writes an audit row with `decision: approved`.
3. The channel ledger records the pending payout.
4. At payout time, AgentPay MCP creates an x402 payment request for the affiliate share.
5. Operator policy checks caps again at settlement time.
6. Settlement writes `x402_settlement_tx`, `network`, `asset`, and reconciled amount.

Do not settle a payout if the approval record has expired between accrual and payout. Reapproval is required.

## Runtime placement

```text
WhatsApp contact message
  to channel agent intent
  to paid MCP tool call
  to AgentPay spend policy approval
  to x402 paid API settlement
  to affiliate payout decision
  to off-chain ledger or optional x402 affiliate settlement
  to audit readback
```

AgentPay MCP owns the two financial gates: spend approval before the paid tool call and payout approval before affiliate liability accrues.

## Acceptance checklist

- [ ] Affiliate payout policy defines per-contact caps.
- [ ] Affiliate payout policy defines agent-level and program-level caps.
- [ ] Contact approval exists before payout accrual.
- [ ] Approval records include `policy_version`, `approved_at`, and `expires_at`.
- [ ] Audit rows link the paid tool call, approval record, payout decision, and ledger entry.
- [ ] Optional x402 settlement records transaction hash and network when used.
- [ ] Logs hash contact and referrer identifiers by default.
- [ ] Paid tool spend approval and affiliate payout approval are separate decisions.
