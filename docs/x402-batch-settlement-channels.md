# x402 batch-settlement channel compatibility for AgentPay MCP

x402 Foundation PR #2061 moves the TypeScript SDK toward batch-settlement channels for repeat paid calls. Instead of one paid request mapping to one immediate facilitator settle call, the client deposits once, signs cumulative vouchers off-chain, and lets the server claim or refund later.

That is good for low-latency paid MCP tools. It also changes the control surface. AgentPay MCP integrations must audit channel state, voucher caps, storage atomicity, corrective 402 recovery, and delayed settlement evidence before relying on batch-settlement for production tool calls.

## Compatibility goal

AgentPay MCP should treat batch-settlement as a channel lifecycle, not a single payment event.

A production integration is compatible only when it records and enforces these checkpoints:

1. Deposit created or topped up before the first paid call in the channel.
2. Voucher signed for each paid request with a cumulative maximum claimable amount.
3. Server verify path checks the voucher without settling every request.
4. Refund path closes unused channel balance with outstanding vouchers accounted for.
5. Claim path proves which cumulative voucher amount was claimed before final settle.
6. Storage uses an atomic compare-and-set or transaction boundary per `channelId`.
7. Corrective 402 recovery resyncs the client when cumulative state diverges.
8. Audit logs preserve off-chain voucher state and eventual on-chain settlement proof.

## Channel state AgentPay must persist

Batch-settlement adds durable per-channel state on both sides of the request.

AgentPay MCP should store a sanitized record keyed by `channelId`, `payer`, `receiver`, `token`, and `network`:

```json
{
  "event_type": "x402_batch_channel_state",
  "agent_id": "agent_123",
  "task_id": "task_456",
  "mcp_tool": "agentpay.x402_pay",
  "channel_id": "0xchannel",
  "network": "eip155:84532",
  "token": "USDC",
  "payer_hash": "sha256:...",
  "payer_authorizer_hash": "sha256:...",
  "receiver_hash": "sha256:...",
  "receiver_authorizer_hash": "sha256:...",
  "deposit_amount": "500000",
  "charged_cumulative_amount": "200000",
  "signed_max_claimable": "250000",
  "total_claimed": "0",
  "refund_nonce": "0",
  "storage_version": "42",
  "policy_version": "agentpay-policy-2026-04-30",
  "created_at": "2026-04-30T13:20:00Z"
}
```

Public logs should hash payer, receiver, payer authorizer, and receiver authorizer addresses. Internal reconciliation can retain raw addresses in encrypted storage.

## Deposit gate

A deposit is not a policy approval. It is a funding action that creates channel capacity.

Before any deposit or top-up, AgentPay MCP should check:

- the deposit amount is under the agent's per-channel deposit cap,
- the token and network are allowlisted,
- the receiver and server-owned `receiverAuthorizer` are expected for the paid MCP provider,
- the deposit multiplier or custom deposit strategy cannot exceed the daily budget,
- human approval is present when policy requires it.

The policy row should say whether the deposit was approved, declined, or skipped. Never infer approval from the x402 SDK choosing a default deposit amount.

## Voucher cap checks

Batch-settlement vouchers are cumulative. The important value is not only the current request price. It is the new `signedMaxClaimable` amount compared with policy.

Before signing a voucher, AgentPay MCP should compute:

```ts
const nextSignedMaxClaimable = currentSignedMaxClaimable + requestCharge;

if (nextSignedMaxClaimable > policy.perChannelVoucherCap) {
  throw new Error("voucher cap exceeded");
}

if (nextSignedMaxClaimable > approvedChannelBudget) {
  throw new Error("approved channel budget exceeded");
}
```

Required checks:

- per-request price is under `maxAmountRequired`,
- cumulative voucher amount is under the channel voucher cap,
- cumulative voucher amount is under the human-approved channel budget,
- channel balance covers the voucher or a policy-approved top-up is required,
- voucher signer delegation is recorded when `payerAuthorizer` differs from the payer.

If any check fails, signing must fail closed. A skipped facilitator settle call must never skip AgentPay policy.

## Atomic storage requirement

A batch channel can receive overlapping paid calls. Application-level `get` then `set` is not enough because two requests can sign from the same base cumulative amount.

AgentPay MCP should require compare-and-set semantics per channel:

```ts
await storage.updateChannel(channelId, current => {
  if (!current) return createInitialChannel();
  if (current.storageVersion !== expectedVersion) return current;

  return {
    ...current,
    chargedCumulativeAmount: nextChargedCumulativeAmount,
    signedMaxClaimable: nextSignedMaxClaimable,
    storageVersion: current.storageVersion + 1,
    lastRequestTimestamp: Date.now()
  };
});
```

Acceptable production backends:

- Redis or Valkey with Lua or `WATCH` / `MULTI` / `EXEC`,
- SQL transaction with `SELECT ... FOR UPDATE` or optimistic version checks,
- Cloudflare Durable Objects when a single object owns one channel,
- any backend that gives atomic conditional mutation for all app instances sharing the channel.

In-memory storage is acceptable only for a single-process demo.

## Corrective 402 recovery

PR #2061 adds corrective 402 recovery for cumulative mismatches. AgentPay MCP should log recovery as a first-class payment event because it means client and server channel state diverged.

Recovery handling should verify and record:

- corrective error code, such as `batch_settlement_cumulative_amount_mismatch`,
- server-provided `chargedCumulativeAmount`,
- server-provided `signedMaxClaimable`,
- voucher signature used to prove the server snapshot,
- whether recovery came from server signature or on-chain state,
- local storage version before and after resync,
- whether the original request was retried.

If recovery cannot verify the signature, channel config, or on-chain state, AgentPay MCP should mark the channel `recovery_failed` and block more voucher signing until a human or operator reconciles it.

## Refund and claim audit path

Refund and claim are delayed settlement operations. They need different audit rows from a normal one-shot x402 payment.

For refunds, record:

- requested refund amount or full refund flag,
- outstanding signed max claimable amount,
- server claim action before refund if any,
- refund transaction hash or pending status,
- remaining channel balance after refund.

For claims, record:

- claimed channel IDs,
- claimed cumulative amount per channel,
- claim transaction hash,
- settle transaction hash if funds are swept separately,
- receiver and receiver authorizer hashes,
- failed, partial, or retried claims.

A paid MCP provider should be able to answer: which tool call increased the voucher, which cumulative voucher got claimed, and which on-chain transaction settled it.

## Server-owned receiver authorizer

The batch-settlement scheme includes `receiverAuthorizer` in channel config. For AgentPay MCP, this is part of provider identity.

AgentPay MCP should pin or allowlist expected receiver authorizers per paid MCP provider. If the receiver authorizer changes, the integration should require one of these outcomes:

- a signed provider rotation notice,
- a fresh human approval,
- or fail-closed rejection.

Do not treat a matching receiver address as enough. The receiver authorizer can become the operational key that approves server-side settlement behavior.

## Off-chain settlement audit checklist

Before enabling batch-settlement for a paid MCP tool, require:

- `channel_id` in every payment attempt row,
- `deposit_amount`, `charged_cumulative_amount`, and `signed_max_claimable` in channel rows,
- policy approval ID attached to deposit and voucher signing,
- CAS or transaction proof for channel storage mutations,
- corrective 402 recovery rows,
- refund and claim rows with transaction hashes when available,
- hashed payer, receiver, payer authorizer, and receiver authorizer fields,
- failure rows for skipped deposits, voucher cap rejection, recovery failure, refund failure, and claim failure.

## Acceptance checklist

- [ ] Deposit policy enforces per-channel and daily caps before channel funding.
- [ ] Voucher signing checks cumulative voucher caps, not only per-request price.
- [ ] Server-owned `receiverAuthorizer` is pinned or routed through approval.
- [ ] Channel storage uses atomic compare-and-set or transaction semantics.
- [ ] Corrective 402 recovery is logged and fails closed when verification fails.
- [ ] Refund flows account for outstanding signed vouchers before returning balance.
- [ ] Claim flows log cumulative claimed amount and settlement transaction proof.
- [ ] Audit rows connect MCP tool name, policy version, channel ID, voucher state, and on-chain settlement.
