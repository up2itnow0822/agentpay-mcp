# x402-native AgentPay MCP vs Stripe-proxy MCP patterns

Toolstem opened a public MCP proxy repo on 2026-05-01 with x402 and Stripe Agent
positioning. The verified README signal is useful: paid MCP discovery is moving
toward familiar payment keywords before every project has shipped a full
implementation.

AgentPay MCP should be evaluated on a different axis. It is not a pooled-token
proxy that hides a downstream account. It is an MCP payment-control server for
agents that need x402 payment execution with local policy, human approval, spend
caps, and audit trails before signing.

## Quick answer

Choose AgentPay MCP when the agent owns the spend decision and must prove who
approved the payment, how much was allowed, which tool requested it, and whether
the policy engine accepted or rejected the transaction.

In AgentPay, policy approval can be required before signing.

Use a Stripe-proxy pattern when the product goal is to put a familiar billing
surface in front of a downstream service and the operator is comfortable with
the proxy holding pooled service credentials.

## Comparison

- **Payment trigger:** AgentPay calls `x402_pay` after an HTTP 402 challenge or
  paid-tool request. A proxy accepts payment and forwards to another gateway.
- **Custody posture:** AgentPay keeps `AGENT_PRIVATE_KEY` local. A proxy may
  operate credentials or pool downstream tokens.
- **Approval gate:** AgentPay can require policy and human approval before
  signing. Proxy behavior depends on its implementation.
- **Spend caps:** AgentPay applies transaction, daily, session, and policy caps
  before payment. A proxy may rely on external billing or account limits.
- **Audit trail:** AgentPay records tool, merchant, amount, policy result,
  receipt, and transaction history. Proxy evidence varies by implementation.
- **Directory proof:** AgentPay packages Glama, Smithery, Docker, npm, and
  27-tool introspection evidence. Do not assume equivalent proxy evidence until
  it is published and verified.
- **Failure mode:** AgentPay fails closed when the policy, chain, asset, or
  approval state is unsupported. Proxy behavior varies by implementation.

## What "x402-native" means here

AgentPay MCP keeps the payment contract visible to the agent runtime:

1. The agent sees a paid endpoint or paid MCP tool.
2. AgentPay checks policy before any signature is produced.
3. If human approval is required, the payment waits.
4. If the policy rejects, the request fails closed.
5. If approved, `x402_pay` signs and submits through the configured x402 path.
6. The audit trail records the tool, amount, policy version, approval state, and
   receipt.

That is different from routing every paid call through a proxy that owns the
downstream service account. A proxy can be useful, but it does not automatically
solve per-agent spend authority.

## Directory proof status

AgentPay MCP currently has public discovery and package proof:

- [Glama MCP Server listing](https://glama.ai/mcp/servers/up2itnow0822/claw-pay-mcp)
- npm package: `agentpay-mcp@4.1.8` or newer
- Packaged catalog metadata: `glama.json` and `smithery.yaml`
- Packaged install paths: `npx` and Docker
- Introspection proof: 27 MCP tools, including `x402_pay`, `check_budget`,
  `set_spend_policy`, and `otel_evaluate_spend`
- Readiness note: `docs/directory-introspection-readiness.md`

Do not claim a directory listing or proxy integration until the external
directory or repo verifies it. README keywords are a signal, not proof of a
working payment path.

## Lightning Wallet MCP comparison

Lightning Wallet MCP is a Bitcoin wallet MCP with directory-facing Glama badge
work and x402 fallback positioning. That is a useful wallet product. AgentPay
MCP is narrower and stricter for paid MCP spend control:

- x402 payment-tool focus through `x402_pay`
- policy checks before signing
- non-custodial local key posture
- explicit approval modes
- daily and per-call caps
- directory metadata meant for catalog introspection
- audit rows that connect payments to agent tool calls

If the buyer question is "give my agent a Bitcoin wallet," Lightning Wallet MCP
may be the right comparison. If the buyer question is "let my agent pay x402
endpoints without runaway spend," AgentPay MCP is the sharper fit.

## README checklist for paid MCP directories

Keep these signals visible for Glama, Smithery, and other MCP catalogs:

- stable npm badge
- stable Glama badge or listing link
- exact install command
- Docker build path
- MCP server name
- tool count from live introspection
- required payment tools
- non-custodial key warning
- approval and spend-cap summary
- link to the latest proof artifact or PR comment
