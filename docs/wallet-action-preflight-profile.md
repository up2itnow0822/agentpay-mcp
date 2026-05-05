# Wallet-action MCP preflight profile

Wallet-action MCP servers are a different risk class from read-only paid APIs.

A read-only paid API can waste money. A wallet-action tool can move value, swap assets, buy chain resources, or set approvals. Those actions are often irreversible. The buyer agent needs a simulate-first gate before any signature.

The May 4 merx-mcp signal matters because it combines TRON balance checks, token sends, swaps, transaction simulation, energy buying, bandwidth management, and x402 facilitation in one MCP-shaped workflow.

AgentPay's response is a wallet-action preflight profile.

## Required controls

Before signing a transfer, swap, approval, energy purchase, bandwidth purchase, or similar wallet action, require:

- `simulate-first`: no signature until simulation returns `passed`.
- `chain/resource caps`: per-action amount caps, daily chain caps, fee caps, energy caps, bandwidth caps, and compute caps where relevant.
- `allowlists`: recipient, asset, chain namespace, and settlement target checks.
- `recipient and amount confirmation`: copy the user can compare against the intended task.
- `nonce guidance`: lock the nonce only after simulation and policy approval are complete.
- `approval copy`: human-readable approval text that includes recipient, amount, simulation ID, resource cost, and an irreversible-action warning.
- `receipt logging`: persist the simulation ID, approval decision, signature intent, transaction hash, and x402 receipt ID together.

## Approval copy example

Title: Approve TRON wallet resource purchase?

Summary: AgentPay detected an irreversible wallet-action request. Simulation passed and policy caps are satisfied.

Line items:

- Recipient: allowlisted TRON account
- Amount: 12.5 TRX, cap 25 TRX per action
- Simulation: passed
- Resource cost: max 1.0 TRX network fee, 25,000 energy, 600 bandwidth

Warning: Signing will authorize an irreversible TRON resource purchase. Decline if recipient, amount, or resource estimate differs from the intended task.

## Fail-closed cases

Deny before signing when any of these are true:

- simulation is missing, failed, stale, or does not match the transaction payload,
- amount exceeds the per-action cap,
- daily chain cap is exhausted,
- network fee or resource estimate exceeds cap,
- recipient or asset is not allowlisted,
- approval copy omits the irreversible warning,
- nonce was reserved before approval,
- the x402 receipt cannot be correlated with the wallet action.

## Proof artifacts

- TypeScript helper: `src/utils/wallet-action-preflight-profile.ts`
- Tests: `tests/wallet-action-preflight-profile.test.ts`
- TRON signal fixture: `docs/fixtures/wallet-action-preflight-merx-2026-05-04.json`

AgentPay's position: wallet-action MCP needs simulation before signing, not after something already moved.
