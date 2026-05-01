# x402 multi-SDK batch-settlement parity for AgentPay MCP

x402 Foundation PR #2164 extends the batch-settlement work from the TypeScript branch into Go client, server, facilitator, and e2e paths. That changes the AgentPay MCP compatibility bar. Paid MCP providers should not prove batch-settlement safety with one SDK only.

The minimum proof now needs TypeScript and Go clients to produce the same channel-state evidence for deposits, vouchers, recovery, refunds, claims, and final settlement.

## Compatibility target

AgentPay MCP should treat multi-SDK batch settlement as one shared channel lifecycle with SDK-specific implementations.

A provider is compatible only when a TypeScript client and a Go client can both show:

- the same `channelId` derivation inputs for payer, `payerAuthorizer`, receiver, `receiverAuthorizer`, token, network, withdraw delay, and salt,
- the same policy approval gate before deposit or top-up,
- the same cumulative voucher cap checks before every voucher signature,
- the same recovery behavior after a corrective 402,
- the same refund and claim audit rows,
- the same proof bundle shape for paid MCP operators.

If one SDK emits less state than another, use the stricter shape. Do not let a Go integration skip an audit row that the TypeScript path already records, or vice versa.

## Cross-SDK channel identity

PR #2164 adds Go batch-settlement examples and e2e wiring around `CHANNEL_SALT`. AgentPay MCP should use the salt as part of the channel identity record, not as a test-only detail.

Store this channel identity before signing any voucher:

```json
{
  "event_type": "x402_batch_sdk_parity_channel",
  "sdk": "go",
  "sdk_version": "pr-2164-head",
  "channel_id": "0xchannel",
  "network": "eip155:84532",
  "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  "payer_hash": "sha256:...",
  "payer_authorizer_hash": "sha256:...",
  "receiver_hash": "sha256:...",
  "receiver_authorizer_hash": "sha256:...",
  "withdraw_delay_seconds": 86400,
  "channel_salt_hash": "sha256:...",
  "channel_config_hash": "sha256:...",
  "policy_version": "agentpay-policy-2026-04-30"
}
```

The `channel_config_hash` must be computed from the normalized config fields, not from a raw SDK struct dump. Field order and JSON tags differ across languages.

## Phased e2e proof

PR #2164 adds fixed batch-settlement phases for e2e clients:

- `initial`: deposit plus first voucher,
- `recovery-refund`: corrective recovery voucher plus cooperative refund,
- `full`: deposit, voucher, and refund in one flow.

AgentPay MCP test evidence should preserve the same phase names. Each phase needs one proof row per SDK:

```json
{
  "event_type": "x402_batch_sdk_parity_phase",
  "phase": "recovery-refund",
  "sdk": "go",
  "mcp_tool": "agentpay.x402_pay",
  "channel_id": "0xchannel",
  "deposit_tx": "0x...",
  "voucher_signature_hash": "sha256:...",
  "recovery_error_code": "batch_settlement_cumulative_amount_mismatch",
  "refund_tx": "0x...",
  "storage_version_before": "42",
  "storage_version_after": "43",
  "result": "passed"
}
```

A provider can run more phases, but it should not rename these three. Stable phase names make cross-SDK failures searchable in CI and production incident logs.

## Voucher signer separation

The Go client path adds optional `EVM_VOUCHER_SIGNER_PRIVATE_KEY`, matching the TypeScript direction where the payer key and voucher signer can be separated.

AgentPay MCP should record signer separation as a first-class policy fact:

- payer key signs deposits and channel funding authorizations,
- voucher signer signs repeat-call vouchers as `payerAuthorizer`,
- receiver authorizer signs claim and refund settlement actions,
- facilitator wallet submits on-chain settlement transactions.

A dedicated voucher signer is allowed only when policy records the delegated signer address and its scope. It must not inherit all payer permissions by accident.

Fail closed when:

- `payerAuthorizer` changes without a fresh approval,
- `EVM_VOUCHER_SIGNER_PRIVATE_KEY` appears in a provider runtime where voucher delegation is not expected,
- a voucher signer can also move funds directly from the payer wallet,
- the SDK reports a payer authorizer address that does not match the approved delegation.

## Facilitator and receiver authorizer expectations

Go examples add facilitator and server authorizer paths. AgentPay MCP should distinguish three operational roles:

1. Receiver: the payee address used for the channel.
2. Receiver authorizer: the key that signs claim and refund payloads.
3. Facilitator signer: the key that submits or sponsors on-chain settlement actions.

For production paid MCP providers, the safest path is a self-managed receiver authorizer controlled by the provider, with facilitator rotation treated as operational infrastructure. Delegating receiver authorization to a facilitator is acceptable for demos, but it should be logged as higher operational risk.

Audit rows must include hashed receiver authorizer and facilitator identity fields. A matching receiver address is not enough proof.

## Refund and recovery visibility

The Go e2e path makes recovery and refund behavior explicit. AgentPay MCP should expose the same visibility in provider logs:

- corrective 402 code,
- server-reported cumulative charge,
- client-local cumulative charge before recovery,
- recovered voucher hash,
- refund amount requested,
- outstanding signed max claimable before refund,
- claim-before-refund decision,
- refund transaction or pending status.

A refund that hides outstanding voucher state is not production-safe. The operator needs to know whether the server claimed first, refunded the unclaimed remainder, retried, or failed.

## Cross-SDK proof bundle

Before enabling batch-settlement for a paid MCP provider, require a proof bundle with this shape:

```json
{
  "provider": "paid-mcp-provider.example",
  "x402_pr_reference": "https://github.com/x402-foundation/x402/pull/2164",
  "agentpay_doc_reference": "docs/x402-multi-sdk-batch-settlement-parity.md",
  "sdk_matrix": [
    {
      "sdk": "typescript",
      "phases": ["initial", "recovery-refund", "full"],
      "voucher_signer_separation": true,
      "receiver_authorizer_pinned": true,
      "cas_storage_proven": true,
      "refund_recovery_rows_present": true
    },
    {
      "sdk": "go",
      "phases": ["initial", "recovery-refund", "full"],
      "voucher_signer_separation": true,
      "receiver_authorizer_pinned": true,
      "cas_storage_proven": true,
      "refund_recovery_rows_present": true
    }
  ],
  "acceptance": "passed"
}
```

The proof should link to CI output or a local validation artifact. Screenshots are not enough.

## Acceptance checklist

- [ ] TypeScript and Go runs use the same normalized channel identity fields.
- [ ] `CHANNEL_SALT` is recorded in hashed form and tied to the `channelId` proof.
- [ ] `initial`, `recovery-refund`, and `full` phase results are logged per SDK.
- [ ] `EVM_VOUCHER_SIGNER_PRIVATE_KEY` or equivalent delegation is recorded as `payerAuthorizer` scope, not broad payer authority.
- [ ] Receiver authorizer and facilitator signer roles are logged separately.
- [ ] Corrective 402 recovery rows include before and after cumulative state.
- [ ] Refund rows include outstanding signed max claimable and claim-before-refund behavior.
- [ ] The provider can hand operators one proof bundle that compares TypeScript and Go results side by side.
