# AgentPay MCP

[![npm](https://img.shields.io/npm/v/agentpay-mcp.svg)](https://www.npmjs.com/package/agentpay-mcp)
[![CI](https://github.com/up2itnow0822/agentpay-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/up2itnow0822/agentpay-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

AgentPay MCP is a stdio Model Context Protocol server for x402 payments and
wallet operations. It exposes Agent Wallet SDK functions as MCP tools and loads
a caller-controlled signing key from the local process environment.

The current npm package is `agentpay-mcp` v5.0.0.

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

Operator safety variables. They are read from the server environment only and
cannot be changed through MCP:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENTPAY_POLICY_DAILY_LIMIT_ETH` | unset | Operator 24-hour rolling limit (ETH-equivalent) |
| `AGENTPAY_POLICY_PER_TX_CAP_ETH` | unset | Operator per-transaction cap (ETH-equivalent) |
| `AGENTPAY_POLICY_ALLOWED_RECIPIENTS` | unset | Comma-separated operator recipient allowlist |
| `AGENTPAY_ALLOW_UNPOLICED_SPEND` | off | `1` permits value movement with no operator policy, relying only on on-chain limits |
| `AGENTPAY_X402_MAX_PAYMENT` | unset | USDC ceiling applied on top of every per-call x402 cap; non-USDC x402 payments are refused while set |
| `AGENTPAY_STATE_DIR` | unset | Directory for the fsync'd spend-intent journal; locks and keyed settlements survive restarts. If the journal cannot be read or fsync'd, value movement is refused |
| `AGENTPAY_ALLOWED_PRIVATE_HOSTS` | unset | Comma-separated hosts whose private address may be reached by outbound requests |
| `AGENTPAY_ALLOW_PRIVATE_NETWORK` | off | Development only: permit private destinations and plain `http` |

Without at least one `AGENTPAY_POLICY_*` variable, or
`AGENTPAY_ALLOW_UNPOLICED_SPEND=1`, every value-moving tool refuses to spend.

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
        "CHAIN_ID": "84532",
        "AGENTPAY_POLICY_PER_TX_CAP_ETH": "0.01",
        "AGENTPAY_POLICY_DAILY_LIMIT_ETH": "0.1",
        "AGENTPAY_X402_MAX_PAYMENT": "1",
        "AGENTPAY_STATE_DIR": "<writable-private-directory>"
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
| Payments | `send_payment`, `x402_quote`, `x402_pay`, x402 session tools |
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
- Spend policy is default-deny. The operator policy comes from
  `AGENTPAY_POLICY_*` environment variables, is loaded once, and cannot be
  changed or cleared through MCP. Without it, value movement is refused unless
  the operator sets `AGENTPAY_ALLOW_UNPOLICED_SPEND=1`.
- `set_spend_policy` can only tighten. Each call adds a layer to its scope; a
  request that raises a limit, drops a constraint, or widens an allowlist is
  refused, and earlier layers keep their rolling-window accounting. Loosening
  requires an operator restart. All policy state is still in-process and is
  reset by a restart.
- `x402_pay` and `x402_session_start` require `max_payment_eth` and `pay_to`.
  The asset is always bound: it defaults to the chain's USDC unless `asset`
  names another; `network` can be bound too. A 402 that names another payee,
  asset, or network, the zero address, or a debit (principal plus the 0.77%
  protocol fee) above the cap is refused before any wallet write.
  `AGENTPAY_X402_MAX_PAYMENT` is a USDC ceiling; with it set, non-USDC
  payments are refused. Use `x402_quote` to read the offered terms first.
- If a payment settles but its response is not delivered — the response
  fails, or the paid request is answered with any non-2xx status — every new
  x402 payment to that **host** (any path, port or spelling of the name) and
  to that **payee** (behind any host) is locked until an operator reconciles
  it. The lock is written before the wallet call, so a crash cannot lose it.
- Caller-selected outbound requests (x402, quote, sessions, OTel kill
  callback) use a safe transport: `https` only (a kill callback may use `http`
  only for a host in `AGENTPAY_KILL_CALLBACK_ALLOWED_HOSTS`), private, loopback, link-local and metadata destinations refused,
  DNS resolved once with the
  socket pinned to the validated address, no automatic redirects, and
  response bodies capped at 2 MiB (1 MiB rendered).
- `send_payment`, `send_token`, `swap_tokens`, `bridge_usdc`, `create_escrow`,
  `x402_pay`, and `x402_session_start` run inside a spend intent. Identical retries replay;
  `idempotencyKey` distinguishes equal payments; an unclear post-broadcast
  outcome locks the intent with no timer. Locks are process-local unless
  `AGENTPAY_STATE_DIR` journals them. Reconcile with
  `agentpay-mcp spend-intents list` and `resolve <key>`, which is a local CLI,
  never an MCP tool.
- `send_payment` takes decimals from the token registry or the token
  contract; a differing `token_decimals` is refused before signing.
- On-chain limits exist only when the wallet owner configures them directly on
  `AgentAccountV2`. The application policy does not write those contract
  limits, and an over-limit transaction is a human gate only when the owner
  key is kept separate from the agent key.
- `get_transaction_history` reads on-chain wallet events and, for unscoped
  `all` queries, also lists x402 settlements made by this server process (final URL of
  the paid response, which may differ from the 402 issuer under redirects, method, amount, token, payee, tx hash, replay count). Those x402
  receipts mean the payment was broadcast (a tx hash was returned), not that a receipt was confirmed. They are kept in memory only, capped at 256, and lost on restart. They are
  omitted from block-scoped queries. This is not an MCP request log: it does not
  record rejected pre-chain attempts or read-only calls.
- Runtime wallet configuration currently supports Base mainnet and Base
  Sepolia. Unsupported chain IDs fail closed in
  [`src/utils/client.ts`](src/utils/client.ts).
- Swap, bridge, escrow, and payment tools can move funds and consume gas. Test
  with bounded values and independent wallet limits.

Read [`docs/security-posture.md`](docs/security-posture.md) for the detailed
control map and known limitations.

## Upgrading from 4.x

v5.0.0 is a breaking security release. Before upgrading:

- Set an operator policy (`AGENTPAY_POLICY_*`) or explicitly opt out with
  `AGENTPAY_ALLOW_UNPOLICED_SPEND=1`; otherwise every spend is refused.
- Pass `max_payment_eth` and `pay_to` to every `x402_pay` and
  `x402_session_start` call. Use `x402_quote` to read the terms first.
- Stop relying on `set_spend_policy` to raise or clear limits.
- Move any `http` or private-network x402 endpoint to `https`, or allow it with
  `AGENTPAY_ALLOWED_PRIVATE_HOSTS` (production) or
  `AGENTPAY_ALLOW_PRIVATE_NETWORK=1` (development only).
- Set `AGENTPAY_STATE_DIR` on long-lived servers.

[`docs/security-remediation-2026-10.md`](docs/security-remediation-2026-10.md)
maps every finding to its fix and test.

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

AgentPay pins `viem` exactly at `2.57.4`.

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
