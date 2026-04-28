# WhatsApp and SMB paid-agent controls with AgentPay MCP

WhatsApp agent management changes the buyer question. The problem is no longer only "can this gateway call a paid API?" It is "can a shop owner approve spend from the same channel where the agent works?"

AgentPay MCP should sit between the channel agent and the x402 or USDC endpoint.

## Reference flow

```text
Customer or operator in WhatsApp
  -> WhatsApp agent runtime
  -> paid action requested
  -> AgentPay MCP policy check
  -> approval card or decline path
  -> x402 or USDC payment only after approval
  -> audit row returned to the operator
```

## Control points

1. The WhatsApp agent asks to call a paid API, book a service, buy data, or trigger a USDC payment.
2. AgentPay MCP computes the spend decision before any wallet signature exists.
3. If the request needs approval, the channel shows a concise card:
   - merchant or endpoint,
   - amount,
   - token and chain,
   - reason the agent gave,
   - daily cap remaining,
   - approve, deny, or lower cap.
4. AgentPay MCP signs only after an approved decision.
5. The operator gets a receipt with transaction hash, URL, amount, policy version, and agent task ID.

## Policy shape

```json
{
  "agent_id": "whatsapp-agent-42",
  "channel": "whatsapp",
  "daily_cap_usdc": "25.00",
  "per_call_cap_usdc": "2.00",
  "approval_required_above_usdc": "0.50",
  "allowed_recipients": ["api.vendor.example"],
  "allowed_chains": ["base", "base-sepolia"],
  "audit_tags": ["smb", "whatsapp", "x402"]
}
```

## Example approval card text

```text
Approve paid agent action?

Agent: Inventory assistant
Endpoint: api.supplier.example/restock-check
Cost: 0.18 USDC on Base
Daily cap left: 14.72 USDC
Reason: Check supplier stock before replying to customer

[Approve once] [Deny] [Lower cap]
```

## Failure behavior

- If the user denies, return a normal agent message and do not sign.
- If the cap is exceeded, fail closed and ask for a cap update.
- If the payment metadata is missing or malformed, do not guess.
- If the chain is unknown, route to the chain-drift watchlist before enabling payment.
- If the WhatsApp session expires, require a fresh approval.

## Audit row

```json
{
  "timestamp": "2026-04-28T05:20:00Z",
  "agent_id": "whatsapp-agent-42",
  "task_id": "restock-check-1902",
  "channel": "whatsapp",
  "resource": "https://api.supplier.example/restock-check",
  "amount_usdc": "0.18",
  "chain": "base",
  "approval_decision": "approved_once",
  "policy_version": "2026-04-28.whatsapp-smb.v1",
  "settlement_reference": "0x..."
}
```

## Acceptance criteria

- No channel agent can produce a wallet signature before AgentPay MCP returns an approved decision.
- Operators can set daily and per-call caps per WhatsApp agent.
- Every paid call joins channel context, payment metadata, policy version, and settlement reference.
- Deny, cancel, expired session, cap exceeded, and unknown chain paths all fail closed.
