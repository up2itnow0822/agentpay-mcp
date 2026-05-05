# x402 chain-neutral gateway profile proof

Paid MCP gateways are no longer competing only on whether one Base x402 request returns `402 Payment Required`.

The new buyer question is sharper: can an agent inspect the network profile before it signs?

On May 3, Rug Munch published a Solana x402 MCP gateway that advertises Solana mainnet, a Base gateway, PayAI facilitator metadata, 175 MCP tools across 28 services, framework endpoints, a Glama manifest, and a Smithery manifest. That is useful market pressure. It also shows why buyers need a profile shape that separates chain support from signing safety.

## Profile fields buyers should require

A chain-neutral paid MCP profile should expose these fields before any payment:

- `networks`: one descriptor per supported rail, using CAIP-2-style names such as `eip155:8453` and `solana:<cluster>`.
- `gateway`: the HTTPS endpoint for each rail, not a prose claim buried in a README.
- `facilitator`: the verifier or settlement service boundary when a gateway does not settle directly.
- `settlement`: who holds keys, who verifies receipts, and what custody model applies.
- `trial`: explicit trial semantics, including the no-trial case.
- `refund`: explicit refund semantics, including whether refund state is automatic, manual, or unsupported.
- `manifests`: `.well-known/x402`, Glama, Smithery, MCP catalog, OpenAPI, and `llms.txt` locations where available.

Directory-ready manifests and chain coverage belong in the same proof. If they are split, agent clients can discover a server without knowing which payment rail they are about to use.

## AgentPay MCP current profile

AgentPay MCP currently treats Base as the production x402 signing path and documents non-EVM networks as extension points until the wallet, asset, facilitator, receipt, refund, and audit semantics are implemented deliberately.

That is intentional. Claiming Solana support before those checks exist would be worse than being Base-only.

The packaged proof includes:

- TypeScript validator: `src/utils/x402-chain-neutral-gateway-profile.ts`
- JSON Schema: `docs/x402-chain-neutral-gateway-profile.schema.json`
- Rug Munch-derived fixture: `docs/fixtures/chain-neutral-gateway-profile-rugmunch-2026-05-03.json`
- Doc and fixture tests: `tests/x402-chain-neutral-gateway-profile.test.ts` and `tests/x402-chain-neutral-gateway-profile-docs.test.ts`

The validator requires `Payment-Signature`, `payment-response`, HTTPS gateway URLs, explicit settlement metadata, explicit trial policy, explicit refund policy, and at least one directory manifest beyond `.well-known/x402`.

## Non-EVM support policy

A non-EVM profile is valid only when it states the rail clearly and fails closed until support is complete.

For Solana, that means AgentPay must not advertise signing support until these are all true:

- The signer path is non-custodial and scoped to the agent's policy.
- Asset and amount parsing are deterministic.
- Facilitator or settlement verification is documented.
- Receipt links and refund state are audit-ready.
- Directory manifests expose the same network terms as the payment endpoint.
- Tests prove unsupported Solana terms do not fall back to Base silently.

The last point matters. A Base-only assumption leaking into discovery docs is how buyers pay the wrong rail.

## Buyer checklist

Before a paid MCP buyer signs against a multi-network gateway, check:

1. Does every advertised network have a CAIP-2-style descriptor?
2. Does each network point to an HTTPS gateway?
3. Is the facilitator or settlement verifier named?
4. Are trial and refund policies explicit and consistent across endpoint rows and top-level metadata?
5. Do Glama, Smithery, MCP catalog, OpenAPI, and `.well-known/x402` agree on the supported networks?
6. Does the buyer enforce a spend cap before signing?
7. Does the receipt prove the same network, asset, amount, and recipient the buyer approved?

AgentPay's position is simple: multi-chain x402 is good. Silent multi-chain assumptions are not.
