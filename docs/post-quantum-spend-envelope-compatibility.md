# AgentPay MCP post-quantum spend-envelope compatibility assessment

PQSafe's May 4 signal pushes spend authorization into a post-quantum envelope frame: ML-DSA-65 signatures, AP2 and ACP compatibility language, MCP endpoints, audit ledgers, and x402 routing.

AgentPay should answer that without overclaiming. Current AgentPay artifacts map cleanly to envelope concepts at the policy and receipt layer, but this package does not claim post-quantum cryptography.

## Compatibility map

| AgentPay control | Envelope concept | Status |
| --- | --- | --- |
| Spend limits | maximum authorized spend inside a signed envelope | Compatible |
| Network, asset, and recipient allowlists | route constraints attached to spend intent | Compatible |
| x402 receipts | receipt pointer for audit and reconciliation | Requires adapter |
| Approval gates | approval before spend execution | Compatible |
| agent_id, task_id, policy_version, receipt_id | audit ledger payload | Requires adapter |

## Explicit non-claims

AgentPay MCP does not claim any of the following from this assessment:

- ML-DSA-65 signing,
- post-quantum key lifecycle,
- AP2 envelope conformance,
- ACP envelope conformance,
- Arbitrum audit-ledger publication.

Those claims require implementation, fixtures, and cryptographic tests before they belong in product docs.

## Practical buyer response

If a buyer asks whether AgentPay can coexist with post-quantum spend envelopes, the current answer is:

- AgentPay spend policies, allowlists, approval gates, x402 receipts, and audit metadata are compatible inputs to an envelope adapter.
- AgentPay can preserve receipt IDs and policy versions so an envelope signer can bind payment approval to settlement evidence.
- AgentPay should not market ML-DSA or post-quantum signing until tests verify it.

The helper at `src/utils/post-quantum-spend-envelope-compatibility.ts` returns this assessment in code so docs and future adapter work start from the same boundaries.
