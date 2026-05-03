# AgentPay MCP directory-grade metadata proof

Paid MCP buyers are starting discovery in catalogs before they read a repository. AgentPay MCP therefore keeps a directory-grade metadata bundle in the repo and npm package.

## Registry and listing surfaces

- npm package: `agentpay-mcp`
- MCP package identity: `io.github.up2itnow0822/agentpay`
- Repository: `https://github.com/up2itnow0822/agentpay-mcp`
- Glama listing: `https://glama.ai/mcp/servers/up2itnow0822/claw-pay-mcp`
- Glama metadata file: `glama.json`
- Smithery-compatible install metadata: `smithery.yaml`
- Directory install proof: `docs/directory-introspection-readiness.md`
- LLM crawler summary: `llms.txt`
- Registry-ready JSON: `docs/mcp-registry-listing.json`

The Glama listing slug still reflects the older `claw-pay-mcp` crawl identity. That is the valid current listing proof. Do not create a fake claim file for a directory that has not issued one. Use `glama.json`, the live Glama URL, npm identity, and repository metadata as the current claim artifacts.

## Install-readiness checks

A directory crawler can verify AgentPay MCP without custodying user funds:

```bash
npm pack --dry-run --json
npm exec --yes agentpay-mcp -- --help
```

For MCP introspection, initialize before `tools/list`:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"registry-check","version":"0.0.1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | \
  AGENT_WALLET_ADDRESS=0x0000000000000000000000000000000000000000 npx -y agentpay-mcp
```

Expected result: `initialize` returns `agentpay-mcp`, then `tools/list` returns the payment and budget tools. The package must not generate a wallet, ask for hosted custody, or sign any payment during listing introspection.

## Tool description standard

Directory-facing paid tools should tell buyers when to use the tool and when not to use it.

- `x402_pay`: use for one capped paid HTTP request; do not use for unknown networks, missing spend caps, or uninitialized Streamable HTTP MCP sessions.
- `x402_session_start`: use for a reusable paid entitlement; do not use if the provider lacks session semantics or if the buyer cannot store the returned session ID.
- `x402_session_fetch`: use after a valid session exists; do not use as a payment bypass or before `x402_session_start`.
- Budget tools: use for local policy enforcement before signing; do not treat catalog metadata as approval.

Every input field on paid tools must explain units, defaults, and failure behavior. Amount caps should name ETH-equivalent units. Network fields should name Base mainnet `8453` and Base Sepolia `84532` where relevant.

## Buyer safety language

AgentPay MCP metadata must preserve these claims:

- non-custodial local signing
- operator-supplied wallet configuration
- Base mainnet and Base Sepolia x402 exact-payment support
- fail-closed unsupported networks
- spend caps before signing
- receipt/audit trail requirements

Directory metadata rule: do not claim directory hosting, managed wallets, or verified listings that are not live.
