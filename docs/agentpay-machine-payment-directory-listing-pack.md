# AgentPay machine-payment directory listing pack

Machine-payment directories are starting to shape buyer discovery. If AgentPay is not described clearly in those directories, buyers will compare us against managed payment stacks using incomplete metadata.

This pack gives directory maintainers a concise AgentPay listing with x402-only settlement wording, proof links, install instructions, and safety controls.

## Listing title

AgentPay MCP - non-custodial x402 payment controls for AI agents

## Short description

AgentPay MCP is an MCP server that lets AI agents pay x402-enabled APIs and tools with human approval, hard spend caps, non-custodial signing, and receipt/audit logging.

## x402-only settlement wording

AgentPay MCP is not a managed wallet, hosted custodian, or payment processor. It is a buyer-side x402 payment-control layer. Current production signing is Base/USDC-oriented, and non-EVM rails are treated as fail-closed extension points until signer, asset, settlement, receipt, and refund semantics are implemented.

## Install snippet

```bash
npm install agentpay-mcp
```

MCP config:

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "npx",
      "args": ["agentpay-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x...",
        "AGENT_WALLET_ADDRESS": "0x..."
      }
    }
  }
}
```

## Safety controls to list

- Human approval for high-risk or high-value payments
- Per-transaction and daily spend caps
- Non-custodial private-key boundary
- x402 `Payment-Signature` and `payment-response` receipt handling
- Paid MCP manifest drift checks
- Provider-health and quality-threshold gates
- Chain-neutral gateway profile checks
- Multi-ledger receipt normalization
- Wallet-action simulate-first preflight profile

## Proof links

- npm: https://www.npmjs.com/package/agentpay-mcp
- GitHub: https://github.com/up2itnow0822/agentpay-mcp
- Chain-neutral x402 gateway profile: `docs/x402-chain-neutral-gateway-profile.md`
- Multi-ledger receipt normalization: `docs/x402-multi-ledger-receipt-normalization.md`
- Wallet-action preflight profile: `docs/wallet-action-preflight-profile.md`
- Dynamic paid MCP manifest drift: `docs/x402-dynamic-paid-mcp-manifest-drift.md`
- Smithery paid MCP installation: `docs/smithery-paid-mcp-installation.md`
- Machine-readable listing JSON: `docs/agentpay-machine-payment-directory-listing.json`

## Directory category suggestions

- MCP servers
- x402 tools
- Agent payments
- Stablecoin payment controls
- Non-custodial agent wallets
- Machine-payment buyer safety

## Suggested PR body

Add AgentPay MCP to the machine-payment directory as a non-custodial x402 payment-control layer for AI agents.

Market signal: paid MCP and MPP directories are becoming a buyer discovery surface. AgentPay is not a managed custodian or generic wallet provider. It controls buyer-side x402 payments with approval gates, spend caps, receipt logging, and fail-closed handling for unsupported ledgers.

Scope:

- Add `agentpay-mcp` under MCP servers, x402 tools, or agent payment controls.
- Use the x402-only settlement wording above.
- Link npm, GitHub, and proof docs.
- Do not claim broad live XRPL/TRON/Solana signing. Current non-EVM wording is fail-closed extension support.

## Suggested issue body

Could this directory add AgentPay MCP as a non-custodial x402 payment-control layer for AI agents?

AgentPay MCP lets AI agents pay x402-enabled APIs and tools while enforcing human approval, hard spend caps, non-custodial signing, and receipt/audit logging. It fits the machine-payment directory category because it covers buyer-side payment governance for paid MCP tools, not hosted custody or managed settlement.

Proof links:

- npm: https://www.npmjs.com/package/agentpay-mcp
- GitHub: https://github.com/up2itnow0822/agentpay-mcp
- Listing JSON: `docs/agentpay-machine-payment-directory-listing.json`
- Multi-ledger receipt normalization: `docs/x402-multi-ledger-receipt-normalization.md`
- Wallet-action preflight profile: `docs/wallet-action-preflight-profile.md`

Important wording: AgentPay MCP is a buyer-side x402 control layer. Current production signing is Base/USDC-oriented; non-EVM rails are fail-closed extension points until signer, asset, settlement, receipt, and refund semantics are implemented.
