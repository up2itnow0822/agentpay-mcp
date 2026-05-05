# AgentPay five-tool x402 parity proof

OpenDexter documents a compact paid-MCP grammar: `x402_search`, `x402_check`, `x402_fetch`, `x402_wallet`, and `x402_pay`. That grammar is useful because it gives buyer agents one mental model for discovery, policy checks, fetching, wallet state, and final payment.

AgentPay does not need to copy hosted session custody to be compatible with that buyer flow. The safer parity target is a mapping that lets agents run the same sequence while keeping signing local, policy explicit, and unsupported chains fail closed.

## Market signal

Source: `Dexter-DAO/dexter-mcp` README, fetched during the May 4 market-intel cycle.

Observed claims:

- Hosted sessions create one Solana address and one EVM address for the user.
- `x402_fetch` checks balances across chains and picks the best-funded chain accepted by the endpoint.
- Sessions persist for 30 days in PostgreSQL.
- The local signer package exposes the same five-tool story and stores a local wallet file.
- The local signing path is currently optimized around Solana.

## AgentPay parity map

| OpenDexter grammar | AgentPay equivalent | Proof surface | Buyer safety rule |
|---|---|---|---|
| `x402_search` | Directory/listing metadata, registry proof, and discovery docs | `docs/agentpay-machine-payment-directory-listing.json`, `docs/mcp-registry-listing-proof.md`, `docs/directory-introspection-readiness.md` | Search results are metadata only. They cannot authorize payment. |
| `x402_check` | Budget, spend-limit, manifest, provider-health, quality, and chain checks | `check_budget`, `check_spend_limit`, `docs/x402-dynamic-paid-mcp-manifest-drift.md`, `docs/paid-provider-health-proof.md`, `docs/paid-tool-quality-thresholds.md` | Checks must fail closed when network, asset, `payTo`, price, manifest freshness, or quality proof is missing. |
| `x402_fetch` | `x402_pay` for paid fetches, or `x402_session_fetch` for reusable paid sessions | `x402_pay`, `x402_session_start`, `x402_session_fetch`, `docs/x402-v211-paid-mcp-compatibility.md` | Fetch must not auto-pay unless policy, approval, cap, receipt, and session state pass first. |
| `x402_wallet` | Local wallet info, policy, deployment, and session status | `get_wallet_info`, `set_spend_policy`, `deploy_wallet`, `x402_session_status` | Wallet state stays local. Directories and hosted proxies do not receive private keys. |
| `x402_pay` | Approval-gated x402 payment execution | `x402_pay`, `docs/x402-multi-ledger-receipt-normalization.md`, `docs/wallet-action-preflight-profile.md` | Payment signs only after explicit network, asset, amount, recipient, policy, and approval checks. |

## Hosted session wallet boundary

Hosted session wallets can reduce onboarding friction, but they move two risks into the provider surface:

1. The provider or database becomes part of the wallet trust boundary.
2. Chain auto-selection can hide which ledger, asset, and settlement target the buyer is about to use.

AgentPay's default posture is different:

- Signing stays local to the buyer runtime.
- Policy approval happens before payment, not after a provider selects a chain.
- The buyer sees `payTo`, network, asset, amount, session, receipt, and unsupported-ledger refusal copy before signing.
- Directory and proxy metadata can help the buyer discover endpoints, but metadata alone never grants spend authority.

## Multi-chain selection guardrails

If a paid MCP endpoint supports more than one network, AgentPay should preserve these guardrails before any future auto-selection flow:

- Require an allowlist for network and asset.
- Require non-zero and verified `payTo`.
- Prefer a deterministic buyer policy over provider-selected best balance.
- Log why a chain was selected.
- Refuse Solana, XRPL, TRON, TVM, or other non-EVM payments until signer, asset, receipt, refund, and settlement semantics are implemented for that rail.
- Show the final chain and asset in approval copy.

## Acceptance proof

A buyer agent can follow the five-step grammar today without handing custody to AgentPay or a hosted directory:

1. Search: read AgentPay listing metadata and proof docs.
2. Check: validate price, manifest, chain, provider health, quality, budget, and approval policy.
3. Fetch: use `x402_pay` or `x402_session_fetch` only after checks pass.
4. Wallet: inspect local wallet and active sessions without exposing private keys.
5. Pay: sign a capped x402 payment and persist the receipt/audit trail.

This is five-tool parity at the buyer-flow layer, with local signer safety instead of hidden hosted-session custody.
