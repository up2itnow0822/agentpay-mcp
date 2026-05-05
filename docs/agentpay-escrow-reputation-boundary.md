# AgentPay escrow and reputation boundary proof

Execution Market packages x402 payment claims with escrow, ERC-8004 identity, A2A task execution, World ID proof, worker evidence, and reputation. That is a useful market signal: buyers will compare payment tools by trust outcomes, not only by payment headers.

This proof separates the layers so buyers do not treat payment authorization as proof that work was completed.

## Market signal

Source: `UltravioletaDAO/execution-market` README, fetched during the May 4 market-intel cycle.

Observed claims:

- Task bounties can lock USDC in on-chain escrow.
- The product exposes MCP, REST, WebSocket, and A2A paths.
- Identity references include ERC-8004 and World ID.
- Worker submissions, evidence, approval, cancellation, refund, and escrow-state checks sit around payment.
- x402 is part of a broader task market, not the whole trust system.

## Boundary table

| Layer | What the buyer needs | AgentPay role | Boundary |
|---|---|---|---|
| Payment authorization | Decide whether an agent may spend a given amount to a given recipient | Enforce approval gates, hard spend caps, allowlists, x402 metadata checks, and receipt logging | Payment authorization does not prove the seller did the task. |
| x402 settlement | Produce and verify the payment proof for a paid endpoint | Sign and retry x402 calls only after policy passes | x402 receipt is payment evidence, not work evidence. |
| Escrow | Lock funds until task terms, evidence, and approval rules are satisfied | AgentPay has a separate `create_escrow` tool for mutual-stake escrow when a factory is configured | Escrow must be explicit. It must not be hidden inside `x402_pay`. |
| Identity | Bind buyers, workers, agents, and policies to identities | AgentPay exposes wallet and identity/reputation utilities from the wallet stack | Identity signals can inform policy, but they are not spend approval by themselves. |
| Reputation | Score prior behavior and outcomes | AgentPay can read reputation signals and log payment outcomes | Reputation should be an input to policy, not the only policy. |
| Work proof | Validate evidence, fulfillment, dispute state, and release conditions | Integration boundary with task-market or verifier systems | Work proof belongs above payment execution. |

## Safe buyer architecture

Use AgentPay as the x402 control layer in front of any task marketplace or paid worker flow:

1. Discover the task or endpoint.
2. Read identity, reputation, escrow, and work-proof requirements.
3. Run AgentPay policy checks for spend cap, `payTo`, asset, network, price, manifest freshness, provider health, and approval mode.
4. If the task requires escrow, call an escrow-specific flow such as `create_escrow`; do not treat a normal x402 receipt as escrow.
5. Release or dispute funds only through the task-market or escrow contract state machine.
6. Persist x402 receipts, escrow transaction hashes, worker evidence IDs, and approval logs as separate audit fields.

## AgentPay guarantees today

AgentPay can guarantee these payment-control properties when configured correctly:

- Non-custodial local signing.
- Human approval for high-risk or high-value payments.
- Per-transaction and daily spend caps.
- Network, asset, recipient, and manifest checks.
- x402 `Payment-Signature` and `payment-response` receipt handling.
- Separate escrow creation through `create_escrow` when the wallet SDK factory is configured.
- Fail-closed behavior for unsupported ledgers or incomplete payment metadata.

AgentPay should not claim these as automatic x402 guarantees:

- Worker identity verification.
- World ID proof.
- Task outcome verification.
- Dispute resolution.
- Reputation scoring accuracy.
- Escrow release correctness.

## Integration rule

A task platform can integrate AgentPay safely by treating it as the buyer-side payment policy layer. The platform should keep escrow, worker evidence, reputation, identity, and dispute state in its own task protocol or contracts, then pass only verified payment intents to AgentPay for approval and signing.
