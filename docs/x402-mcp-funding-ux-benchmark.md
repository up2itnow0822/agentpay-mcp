# x402 MCP funding UX benchmark

A new public repo, `yayashuxue/agent-marketplace-mcp`, is testing an x402-paid MCP server with hosted funding UX, local hot-wallet generation, optional Coinbase-managed mode, and Smithery hosting metadata. As of 2026-05-01 04:48 CT, `npm view agent-marketplace-mcp` returned 404, so this benchmark treats it as a public repo signal, not as a live npm package.

The signal matters because paid MCP builders are moving funding into the product pitch. AgentPay MCP should make the tradeoff clear: fast top-up is useful, but production agents need approval gates, daily caps, auditability, and a non-custodial posture before they can spend real budgets.

## Comparison

| Area | AgentPay MCP | agent-marketplace-mcp signal |
|------|--------------|------------------------------|
| Funding model | Bring a funded non-custodial Agent Wallet. Funding can happen through any wallet workflow the operator approves. | Public README describes a hosted fund link and optional managed wallet mode. |
| Approval gates | Payment tools are designed to sit behind human approval, policy checks, and per-call caps before signing. | The repo emphasizes easier funding. Approval gating is not the main product claim in the observed public metadata. |
| Daily caps | AgentPay MCP exposes spend limits and budget checks as first-class controls before paid tool use. | Funding UX may reduce onboarding friction, but a funded wallet still needs enforceable spend caps. |
| Auditability | AgentPay MCP records payment amount, recipient, network, transaction hash, and history through wallet activity tools. | Hosted top-up can help users fund faster, but operators still need agent-level audit rows for every paid call. |
| Custody posture | Non-custodial by default. The agent signs with its configured wallet key and policy layer. | Optional Coinbase-managed mode may be easier for onboarding, but it changes custody and operational risk assumptions. |
| Failure mode | Unsupported chains and unsupported x402 requirements fail closed. | Hosted funding does not remove the need to reject unsupported networks, assets, payees, and settlement paths. |

## Safe funding UX for AgentPay MCP

AgentPay MCP should keep funding easy without weakening spend controls:

1. Show wallet funding status before a paid tool call.
2. Link to operator-approved funding instructions, not an automatic top-up that bypasses review.
3. Require an approval gate before the first payment to a new service or payee.
4. Enforce per-call and daily caps before signing.
5. Log each payment with service, URL, amount, asset, recipient, network, transaction hash, and policy version.
6. Fail closed for unsupported networks, including TVM/TON exact-payment offers.
7. Keep managed-wallet mode as an explicit integration choice, not a silent default.

## Buyer guidance

Pick hosted funding when the goal is a fast demo and the budget is small.

Pick AgentPay MCP when a production agent needs to prove who approved the spend, how much it can spend per call, what daily ceiling applies, which wallet signed, and where the receipt lives.

Funding UX gets the wallet ready. Spend governance decides whether the agent is allowed to use it.
