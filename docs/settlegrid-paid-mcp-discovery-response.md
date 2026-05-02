# Paid MCP discovery and budget response

SettleGrid is useful market validation for paid MCP. It shows that discovery, metering, budget checks, remote MCP endpoints, and protocol routing are becoming part of the buyer's comparison set.

AgentPay MCP should answer that shift directly: discovery helps an agent find a paid tool, but it must not become payment authorization.

## Verified SettleGrid signal

On 2026-05-01, the Intelligence cycle verified these public SettleGrid claims and endpoints:

- `@settlegrid/mcp` on npm at version `0.1.1`
- `@settlegrid/discovery` on npm at version `1.0.1`
- repo commits at 2026-05-02T00:47:42Z and 2026-05-02T00:55:11Z, including a Stripe-only rail cutover playbook
- README claims for 14 payment protocols, built-in discovery, agent identity, budget enforcement, an HTTP MCP endpoint, an MCP discovery server, and 1,017 billing-ready templates
- `https://settlegrid.ai/api/openapi.json` returning paths including `/api/sdk/validate-key`, `/api/sdk/meter`, `/api/sessions`, `/api/agents`, and `/api/x402/verify`
- `https://settlegrid.ai/api/v1/discover` returning active monetized tool records with per-method pricing

Those are real platform signals. They do not remove the buyer's need to verify before payment.

## AgentPay's answer

AgentPay MCP wins by keeping spend authority at the buyer edge.

A paid MCP directory can tell an agent where a tool is. AgentPay decides whether the agent is allowed to pay for it.

Before signing an x402 payment, AgentPay should verify:

1. The response is HTTP 402 with a parseable `payment-required` or `x-payment-required` header.
2. `payTo` is present, valid, expected, and non-zero.
3. The requested network is on the wallet policy allowlist.
4. The requested asset matches an allowed asset exactly.
5. The amount is positive and under the per-call or session cap.
6. Required human approval is already `approved`.
7. The audit row can record endpoint, tool call, recipient, network, asset, amount, policy version, approval state, and receipt.
8. Any hosted proxy or operator-pooled upstream credential path is explicitly accepted by policy.

## What to copy and what not to copy

Copy the buyer-visible parts:

- clean directory metadata
- simple install paths
- live discovery endpoints
- per-tool pricing fields
- clear metering and budget language

Do not copy hosted lock-in as the default:

- do not require platform-held buyer funds by default
- do not hide recipient or asset fields behind a dashboard
- do not treat directory discovery as spend approval
- do not let platform-side budget checks replace wallet-edge caps

## Recommended AgentPay ship path

1. Keep the hosted proxy verifier documented and packaged.
2. Add a discovery plus budget FAQ to the README that separates directory search from x402 authorization.
3. Add a docs test that fails if the required buyer controls disappear from this guide.
4. Add a scanner fixture that proves a discovered paid MCP endpoint still fails closed until approval and spend caps pass.

AgentPay's posture is simple: discover widely, verify locally, cap before signing, approve intentionally, and audit every paid call.
