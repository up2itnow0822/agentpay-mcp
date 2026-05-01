# AgentPay MCP directory introspection readiness

Paid MCP servers are starting to get ranked by catalog proof, not only by README claims. This note records the install paths a directory crawler can verify without changing AgentPay MCP's custody model.

## Machine-readable package identity

- npm package: `agentpay-mcp`
- MCP server name in `package.json`: `io.github.up2itnow0822/agentpay`
- MCP runtime name from `initialize`: `agentpay-mcp`
- CLI binary: `agentpay-mcp`
- Repository: `https://github.com/up2itnow0822/agentpay-mcp`
- Docker entrypoint: `node dist/index.js`

The package does not create or manage a hot wallet by default. Directory installs should require explicit operator-supplied wallet configuration.

## npx path

Use this for local MCP clients and catalog recipes that execute npm packages directly:

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "npx",
      "args": ["-y", "agentpay-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x...",
        "AGENT_WALLET_ADDRESS": "0x...",
        "CHAIN_ID": "8453",
        "RPC_URL": "https://mainnet.base.org"
      }
    }
  }
}
```

AGENT_PRIVATE_KEY stays local to the MCP runtime. AgentPay MCP does not ask a catalog to custody keys, generate first-run wallets, or opt users into a managed-wallet path.

## Docker path for Glama-style introspection

Build from the repository root:

```bash
docker build -t agentpay-mcp:glama-introspection .
```

Run stdio introspection with a placeholder address. Tool listing does not require a private key because tools are registered before any payment call loads spend policy state:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"catalog-check","version":"0.0.1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' |
  docker run --rm -i \
    -e AGENT_WALLET_ADDRESS=0x0000000000000000000000000000000000000000 \
    agentpay-mcp:glama-introspection
```

Expected proof points:

- `initialize` returns server name `agentpay-mcp`.
- `tools/list` returns payment tools such as `x402_pay`, `check_budget`, `set_spend_policy`, and `otel_evaluate_spend`.
- No default managed wallet is created during introspection.

## Glama metadata

`glama.json` is present at the repository root with schema `https://glama.ai/mcp/schemas/server.json` and maintainer `up2itnow0822`. Glama-style crawlers can use this alongside the Dockerfile to identify the server without asking users to move private keys into a hosted catalog.

## Smithery-compatible metadata

`smithery.yaml` declares the same stdio start command and wallet environment variables. The schema marks private-key input as a password field and keeps `CHAIN_ID` constrained to supported Base values.

This is a catalog metadata file, not a hosting custody model. Hosted directory operators should still treat AgentPay MCP as a user-controlled, non-custodial server.

## Listing status

As of 2026-05-01, Glama and Smithery public pages were not fetchable from this runtime (`web_fetch` failed for Glama and Smithery returned a Vercel security checkpoint). Do not claim a live directory listing until the page can be verified by URL. The verified live paths today are npm, GitHub, repository metadata (`glama.json`, `smithery.yaml`, `Dockerfile`), and the open AgentPay MCP PR carrying this readiness note.
