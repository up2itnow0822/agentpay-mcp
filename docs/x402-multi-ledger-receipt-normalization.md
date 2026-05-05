# x402 multi-ledger receipt normalization

Paid MCP x402 is moving beyond one common Base and USDC path.

The buyer-side control cannot be "the README said x402." The control has to be a normalized receipt envelope that survives different ledgers, assets, facilitators, and hosted MCP gateways.

The May 4 XRPL-Utilities signal matters because it advertises XRPL MCP tools with caller-supplied x402 v2 payment headers. That makes the signing question concrete: what does the agent approve when the ledger is XRPL, the asset may not be USDC, and the receipt format is provider-defined?

AgentPay's answer is fail-closed normalization.

## Required receipt fields

Every paid MCP receipt needs these buyer-visible fields before signing:

- `ledger label`: human-readable rail name, such as `Base mainnet`, `XRPL mainnet`, or `TRON mainnet`.
- `ledger namespace`: machine-readable namespace, such as `eip155`, `xrpl`, `tvm`, or `solana`.
- `asset`: the exact settlement asset the buyer approved.
- `settlement target`: the address, account, or provider target the payment will reach.
- `payment header`: the request header carrying the x402 payment proof. For current AgentPay proofs this is `Payment-Signature`.
- `receipt header`: the response header carrying payment confirmation. For current AgentPay proofs this is `payment-response`.
- `verification status`: `verified`, `pending`, `unsupported_refused`, `failed`, or `unknown`.
- `non-custodial boundary`: who signs, where the key lives, and whether any facilitator can move funds.
- `unsupported-ledger refusal`: plain copy the agent can show when the rail is visible but not safe to sign.

## AgentPay current support boundary

AgentPay MCP treats Base x402 signing as the current production path.

XRPL, TRON, Solana, TON, and other rails are extension points until the following are implemented and tested:

- deterministic asset parsing,
- settlement target allowlists,
- non-custodial signer support,
- facilitator or verifier semantics,
- receipt mapping,
- refund or dispute state,
- audit-row correlation,
- negative tests proving unsupported rails do not silently fall back to Base.

This is not anti-multichain. It is how buyer agents avoid signing a payment whose ledger semantics they do not understand.

## Unsupported-ledger refusal copy

Use this copy when an agent sees a non-allowlisted x402 rail:

> Refused before signing: this x402 rail is visible but not allowlisted. Add ledger namespace, asset parser, settlement target allowlist, verifier, receipt mapping, and non-custodial signer support before retrying.

That sentence matters. It turns a vague failure into an actionable implementation path.

## Proof artifacts

- TypeScript helper: `src/utils/x402-multi-ledger-receipt.ts`
- Tests: `tests/x402-multi-ledger-receipt.test.ts`
- XRPL signal fixture: `docs/fixtures/multi-ledger-receipt-xrpl-utilities-2026-05-04.json`
- Schema: `docs/x402-multi-ledger-receipt-normalization.schema.json`

AgentPay's position: multi-ledger x402 is good. Hidden ledger assumptions are not.
