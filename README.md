# AgentPay MCP

[![npm](https://img.shields.io/npm/v/agentpay-mcp.svg)](https://www.npmjs.com/package/agentpay-mcp)
[![CI](https://github.com/up2itnow0822/agentpay-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/up2itnow0822/agentpay-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

AgentPay MCP is a stdio Model Context Protocol server for x402 payments and
wallet operations. It exposes Agent Wallet SDK functions as MCP tools and loads
a caller-controlled signing key from the local process environment.

The current npm package is `agentpay-mcp` v4.1.17.

## Start without funds

Check the installed command without loading wallet credentials:

```bash
npx -y agentpay-mcp --version
npx -y agentpay-mcp --help
```

Use the
[AgentPay Wallet Starter](https://github.com/up2itnow0822/agentpay-wallet-starter)
for a no-funds verification of allowed, approval-required, and blocked policy
outcomes.

## MCP client configuration

Wallet tools read the following environment variables:

| Variable | Required for wallet tools | Meaning |
| --- | --- | --- |
| `AGENT_PRIVATE_KEY` | Yes | Local hot-wallet signing key |
| `AGENT_WALLET_ADDRESS` | Yes | Deployed `AgentAccountV2` address |
| `CHAIN_ID` | No | `8453` or `84532`; defaults to Base mainnet |
| `RPC_URL` | No | Caller-selected Base RPC endpoint |
| `FACTORY_ADDRESS` | For deployment | Wallet factory address |
| `NFT_CONTRACT_ADDRESS` | For deployment | Token contract bound to a wallet |
| `SESSION_TTL_SECONDS` | No | Local session lifetime in seconds |

Example MCP configuration:

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "npx",
      "args": ["-y", "agentpay-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "<secret-reference-or-local-key>",
        "AGENT_WALLET_ADDRESS": "0x<deployed-wallet-address>",
        "CHAIN_ID": "84532"
      }
    }
  }
}
```

Do not commit a real signing key. Use the client or operating system's secret
mechanism where one exists. Start on Base Sepolia before using Base mainnet.

## Tool groups

The tool registry in [`src/index.ts`](src/index.ts) exposes these groups:

| Group | Examples |
| --- | --- |
| Wallet | `deploy_wallet`, `get_wallet_info`, `queue_approval` |
| Payments | `send_payment`, `x402_pay`, x402 session tools |
| Policy | `set_spend_policy`, `check_budget`, OTel budget tools |
| Tokens | Lookup, custom-token registration, balances, and transfers |
| Execution | Swap, USDC bridge, and mutual-stake escrow |
| Trust | ERC-8004 identity, reputation, and UAID verification |
| History | `get_transaction_history` for wallet contract events |

Tool schemas and handlers live under [`src/tools/`](src/tools/).

## Security boundaries

These boundaries matter more than the feature list:

- The server reads `AGENT_PRIVATE_KEY` into its local Node.js process and uses
  viem for signing. Protect the process, environment, and MCP client config.
- `set_spend_policy` stores policy in the MCP server process. The same agent can
  call that tool again, and a process restart clears its rolling state.
- Every current value-moving handler calls the in-process policy check, but
  this is still application-level enforcement.
- On-chain limits exist only when the wallet owner configures them directly on
  `AgentAccountV2`. `set_spend_policy` does not write those contract limits.
- An over-limit transaction is a human gate only when the owner key is kept
  separate from the agent key.
- `get_transaction_history` reads on-chain wallet events. It is not an MCP
  request log and does not record rejected pre-chain attempts or read-only
  calls.
- Runtime wallet configuration currently supports Base mainnet and Base
  Sepolia. Unsupported chain IDs fail closed in
  [`src/utils/client.ts`](src/utils/client.ts).
- Swap, bridge, escrow, and payment tools can move funds and consume gas. Test
  with bounded values and independent wallet limits.

Read [`docs/security-posture.md`](docs/security-posture.md) for the detailed
control map and known limitations.

## Technical proof index

The repository keeps deeper interoperability and buyer-safety evidence in
versioned documents:

- [`docs/agentpay-buyer-flow-parity.md`](docs/agentpay-buyer-flow-parity.md)
  covers typed payment errors and buyer flow behavior.
- [`docs/paid-mcp-gateway-hardening.md`](docs/paid-mcp-gateway-hardening.md)
  covers default-deny controls and quota envelopes.
- [`docs/agentpay-five-tool-parity-proof.md`](docs/agentpay-five-tool-parity-proof.md)
  records the five-tool parity check.
- [`docs/agentpay-escrow-reputation-boundary.md`](docs/agentpay-escrow-reputation-boundary.md)
  defines the escrow and reputation boundary.
- [`docs/paid-mcp-proxy-discovery-readiness.md`](docs/paid-mcp-proxy-discovery-readiness.md)
  records discovery readiness evidence.
- [`docs/x402-chain-neutral-gateway-profile.md`](docs/x402-chain-neutral-gateway-profile.md)
  defines the packaged chain-neutral profile.
- [`docs/x402-dynamic-paid-mcp-manifest-drift.md`](docs/x402-dynamic-paid-mcp-manifest-drift.md)
  documents checks for stale paid-tool metadata.
- [`docs/mcp-registry-listing-proof.md`](docs/mcp-registry-listing-proof.md)
  and [`llms.txt`](llms.txt) expose directory metadata.
- [`docs/smithery-paid-mcp-installation.md`](docs/smithery-paid-mcp-installation.md)
  and
  [`examples/smithery-paid-mcp-installation`](examples/smithery-paid-mcp-installation)
  document the packaged Smithery path without asserting a live listing.
- [`docs/paid-provider-health-proof.md`](docs/paid-provider-health-proof.md)
  defines provider-health evidence.
- [`docs/hosted-x402-proxy-verification.md`](docs/hosted-x402-proxy-verification.md)
  defines hosted-proxy preflight checks.
- [`docs/x402-native-vs-stripe-proxy.md`](docs/x402-native-vs-stripe-proxy.md)
  separates local spend control from hosted proxy billing.
- [`docs/dependency-pin-policy.md`](docs/dependency-pin-policy.md) defines the
  release gate for payment-critical packages.

AgentPay pins `viem` exactly at `2.56.0`.

The directory comparison was captured against `agentpay-mcp@4.1.9`; the
package version at the top of this README is the current release.

## Verify a clean checkout

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run lint
npm run security
npm run smoke:clean-install
```

The CI workflow is separate from scheduled daily review and repair workflows.
A scheduled-review failure is not a product-test result, and a repair success
does not replace CI.

## Related repositories

- [Agent Wallet SDK](https://github.com/up2itnow0822/agent-wallet-sdk) provides
  the wallet and policy library used by this server.
- [AgentPay Wallet Starter](https://github.com/up2itnow0822/agentpay-wallet-starter)
  provides the combined no-funds onboarding path.
- [NVIDIA NeMo Agent Toolkit Examples PR 17](https://github.com/NVIDIA/NeMo-Agent-Toolkit-Examples/pull/17)
  is an independently merged integration example.

## Support and disclosure

- File product bugs through the
  [GitHub issue queue](https://github.com/up2itnow0822/agentpay-mcp/issues).
- Report security issues through [`SECURITY.md`](SECURITY.md).
- Contribution rules live in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

MIT. See [`LICENSE`](LICENSE).
