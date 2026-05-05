# Paid MCP proxy and discovery readiness pack

Toolstem and Cinderwright show the next buyer channel for paid tools: proxies that convert existing SaaS tools into x402-paid MCP endpoints, plus directories that compare paid services across x402, MPP, and L402.

AgentPay should be easy for those surfaces to list without giving them custody, overstating ledger support, or hiding buyer policy.

## Market signal

Sources fetched during the May 4 market-intel cycle:

- `toolstem/toolstem-proxy` describes an x402-paid proxy for Apify-backed MCP tools without Apify signup.
- `cinderwright-ai/cinderwright-api` describes discovery data across x402, MPP, and L402, with 1,551 services and paid market-intelligence endpoints.

## Paid-proxy recipe for tool authors

Use this pattern when wrapping an existing API, actor, or MCP server with x402:

1. Keep the upstream service token on the provider side. Do not ask buyer agents to hold pooled SaaS credentials.
2. Publish a fresh `.well-known/x402` offer with price, asset, network, `payTo`, terms, and refund policy.
3. Return typed 402 errors for unpaid, underpaid, wrong-network, stale-receipt, quota, and provider-health failures.
4. Charge only after the request is valid enough to execute. Validation failures should not bill.
5. Expose provider-health and quality fields before payment.
6. Include idempotency keys so retries do not double charge.
7. Make directory metadata crawlable without a private key.
8. Let buyers bring AgentPay for approval gates, caps, allowlists, and x402 receipt logging.

## AgentPay listing metadata

Directories can list AgentPay with these fields:

```json
{
  "name": "agentpay-mcp",
  "role": "buyer-side x402 payment-control layer",
  "package": "agentpay-mcp",
  "mcp_name": "io.github.up2itnow0822/agentpay",
  "settlement": "x402 with local non-custodial signing",
  "supports": ["MCP", "x402", "human approval", "spend caps", "receipt logging"],
  "does_not_provide": ["managed custody", "pooled SaaS token custody", "automatic non-EVM signing"],
  "install": "npx agentpay-mcp",
  "proofs": [
    "docs/agentpay-five-tool-parity-proof.md",
    "docs/agentpay-escrow-reputation-boundary.md",
    "docs/agentpay-machine-payment-directory-listing.json",
    "docs/x402-dynamic-paid-mcp-manifest-drift.md",
    "docs/paid-provider-health-proof.md"
  ]
}
```

## Discovery insertion checklist

Before submitting AgentPay to a paid-MCP or machine-payment directory, verify:

- npm package name and current version.
- GitHub repository URL.
- MCP package identity.
- Install command and required environment variables.
- No private key required for `initialize` or `tools/list`.
- x402-only wording is present.
- Base/USDC production signing is not broadened into unsupported non-EVM claims.
- Proof docs are linked for five-tool parity, manifest drift, provider health, quality gates, receipt normalization, and escrow boundary.

## Outreach posture

For Toolstem-style proxies, propose buyer-side approval and receipt guidance, not a partnership claim.

For Cinderwright-style directories, propose adding AgentPay as a buyer-control tool with exact metadata and proof links.

For Dexter-style five-tool flows, propose interoperability language: AgentPay can satisfy the same buyer sequence with local signing and explicit policy checks, while hosted session wallets remain a different trust model.
