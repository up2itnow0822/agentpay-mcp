# AgentPay MCP — Security Posture

> Last updated: 2026-10-25 (v5.0.0)

This document maps AgentPay MCP's security controls to the CoSAI (Coalition for Secure AI) threat taxonomy and MCP 2026 authentication requirements. It is intended for enterprise security teams evaluating MCP servers for production deployment.

> **Correction (2026-08-16):** Earlier revisions of this document overstated several controls. Specifically, they described the `set_spend_policy` limits, merchant allowlist, and policy engine as "enforced by the AgentAccountV2 smart contract / on-chain — cannot be overridden," and described a per-tool-invocation audit log. Neither claim was accurate. The policy configured via `set_spend_policy` is enforced **in the MCP server process**, not on-chain; on-chain limits exist only if the wallet owner has configured them directly on the AgentAccountV2 contract, which `set_spend_policy` does **not** do. The audit trail is on-chain event history only — there is no per-tool-invocation log. The sections below state what each control actually guarantees.

> **Update (2026-10-25, v5.0.0):** the October 2026 security remediation ([`security-remediation-2026-10.md`](security-remediation-2026-10.md)) changed several controls described here. The spend policy is now default-deny and anchored by an immutable operator policy read from the server environment; `set_spend_policy` can only tighten and no longer resets accounting; `x402_pay` and `x402_session_start` require a cap and an approved payee; caller-selected outbound requests go through a pinned, byte-capped safe transport; `send_payment` is idempotent; and OTel state is bounded. Rows and paragraphs below describe v5.0.0 behaviour. Releases before 5.0.0 do not have these controls.

## CoSAI Threat Alignment

### T9 — Financial Fraud

**Threat:** An AI agent is manipulated (via prompt injection, tool poisoning, or logic error) into making unauthorized payments.

**Mitigations in AgentPay MCP:**

| Control | Implementation | Bypass Resistance |
|---------|---------------|-------------------|
| Operator spend policy (in-process) | `AGENTPAY_POLICY_PER_TX_CAP_ETH`, `AGENTPAY_POLICY_DAILY_LIMIT_ETH`, and `AGENTPAY_POLICY_ALLOWED_RECIPIENTS`, read once from the server environment into a reserved `operator` scope. Without them every value-moving tool refuses to spend (default deny) unless the operator sets `AGENTPAY_ALLOW_UNPOLICED_SPEND=1` | Process-level only — **not** on-chain. It cannot be changed, cleared, or shadowed through MCP (`set_spend_policy` refuses the `operator` scope). It can still be bypassed by a compromised server process or by whoever controls the server environment |
| Per-transaction spending cap (in-process) | The operator cap plus any caller cap added with `set_spend_policy`; every value-moving tool — `send_payment`, `send_token`, `x402_pay`, `x402_session_start`, `bridge_usdc`, `create_escrow`, and `swap_tokens` — reserves against every layer in force (`reserveSpendPolicy` / `enforceSpendPolicy` — see version note below) | Process-level only. `set_spend_policy` can only **tighten**: a request that raises a cap, omits a cap the scope already has, or widens its allowlist is refused, so a manipulated agent cannot loosen its own limits. Loosening requires an operator restart |
| Rolling period limits (in-process) | Operator and caller daily limits (24-hour rolling window). Each `set_spend_policy` call adds a new layer; earlier layers keep their rolling-window accounting and any held or locked reservations | Process-level only, not smart-contract enforcement. All rolling state is reset by a server restart |
| Merchant allowlist (in-process) | `AGENTPAY_POLICY_ALLOWED_RECIPIENTS` and `allowedRecipients` in `set_spend_policy` restrict recipient addresses; a caller allowlist must be a non-empty subset of any allowlist already in force. Note: `swap_tokens` and `bridge_usdc` custody/return funds at the agent wallet's own address, so that address is the checked recipient — allowlist-only policies must include the agent wallet address to permit swaps and bridging | Process-level only — the allowlist is **not** written to or enforced by the smart contract |
| Mandatory x402 cap and bound terms | `x402_pay` and `x402_session_start` require `max_payment_eth` and `pay_to` (optional `asset`, `network`). Inside `onBeforePayment` the SDK-selected requirement must match the approved payee (never the zero address), asset, and network, and its amount must not exceed the cap converted to the selected asset's decimals, or `AGENTPAY_X402_MAX_PAYMENT` if lower. `x402_quote` reads the offered terms without signing | Checked on the exact values the SDK signs, before any fee or principal write. Process-level |
| Payment idempotency (in-process, optionally durable) | `send_payment`, `send_token`, `swap_tokens`, `bridge_usdc`, `x402_pay`, and `x402_session_start` run inside a spend intent: identical retries replay, `idempotencyKey` distinguishes equal payments and refuses reuse with a different payload, and an unclear post-broadcast outcome locks the intent with no timer. `x402_session_start` is serialised per canonical host. An unresolved x402 intent (paid but undelivered, including a paid non-2xx response) blocks every new x402 payment to its host — any path, port or alias — and to its payee behind any host. With `AGENTPAY_STATE_DIR` the intents are journalled (fsync'd, append-only) and replayed at startup | Locks are never evicted; at 1,024 unresolved intents new value movement is refused. Without `AGENTPAY_STATE_DIR` the state is lost on restart. Locks are cleared only through the local `agentpay-mcp spend-intents resolve` CLI, never through MCP |
| Authoritative token decimals | `send_payment` takes decimals from the token registry, native ETH, or the token contract's `decimals()`; `token_decimals` is only an assertion and a mismatch is refused before policy or signing | Prevents a caller from scaling a transfer past the policy by up to 10^12 |
| On-chain per-tx and period limits | AgentAccountV2 smart contract limits, configured by the wallet owner directly on the contract (out-of-band — `set_spend_policy` does not write them). Readable via `check_budget` / `get_wallet_info` | On-chain — cannot be overridden by application code or the agent, **provided the owner has actually configured limits on the contract** |
| Human-approval gate | Transactions above the on-chain limits are queued by AgentAccountV2 for review; releasing one requires an owner-privileged approval transaction (`queue_approval`) | Queuing of over-limit transactions is on-chain and cannot be skipped. It is only a *human* gate if the owner key is held by a human and kept separate from the agent key |
| Fail-closed policy engine (in-process) | Any error while evaluating the in-process spend policy rejects the payment (default-deny) | Fail-closed applies within the policy check itself; all seven value-moving tools invoke the check before executing. A future code path that never invoked the check would not be covered by it |
| Audit trail | On-chain AgentAccountV2 events (executions, queued transactions, approvals, cancellations, on-chain policy updates, operator changes), retrievable via `get_transaction_history` | Immutable on-chain record — but it covers on-chain wallet operations only; see [Audit Logging](#audit-logging) for what is not recorded |

> **Version note (in-process policy enforcement):** the in-process policy engine (now `reserveSpendPolicy` / `enforceSpendPolicy`) was wired into the payment path by PR [#29](https://github.com/up2itnow0822/agentpay-mcp/pull/29), now merged. All seven value-moving tools — `send_payment`, `send_token`, `x402_pay`, `x402_session_start`, `bridge_usdc`, `create_escrow`, and `swap_tokens` — consult the policy before moving value. Every configured scope (the `global` scope and any custom `scopeKey`) is enforced together as a union, amounts are normalised from the asset's own base units to the policy's 9-decimal ETH-equivalent scale before comparison, `create_escrow` checks the full buyer commitment (payment plus equal buyer stake), and any error during evaluation rejects the payment (fail-closed). Releases cut **before** that change record the policy via `set_spend_policy` but do not consult it on the payment path — on those versions, treat the in-process rows above as configuration-only and rely on the on-chain AgentAccountV2 limits. Verify your installed version includes the enforcement wiring before depending on the in-process policy. Releases before 5.0.0 also allowed every spend when no policy was configured and let `set_spend_policy` replace, loosen, or clear a policy (resetting its rolling accumulator); 5.0.0 removed both behaviours.

**Defense-in-depth guidance:** treat the in-process policy as defence in depth and the on-chain AgentAccountV2 limits as the tamper-resistant control. `set_spend_policy` still carries no authentication, but since 5.0.0 it can only add tighter layers: the agent it constrains can no longer raise, clear, or reset its own limits, and re-calling it does not reset any rolling accumulator. The operator policy lives in the server environment, outside MCP. All in-process policy state is still lost on restart, and anything that can control the server process or its environment can change it. Enterprise deployments should configure on-chain limits on the contract itself and set an operator policy rather than relying on `set_spend_policy`.

### Outbound requests (SSRF)

**Threat:** a caller-selected URL is used to reach internal services, cloud metadata, or to exhaust server memory.

| Control | Implementation |
|---------|---------------|
| Safe transport | Every caller-selected destination — `x402_pay`, `x402_quote`, `x402_session_start`, `x402_session_fetch`, and the OTel kill callback — goes through `src/utils/safe-fetch.ts` |
| Scheme and form | `https` only (a kill callback may use `http` only for an operator-allowlisted host in `AGENTPAY_KILL_CALLBACK_ALLOWED_HOSTS`, or in private-network development mode); URLs with embedded credentials or empty DNS labels are refused |
| Destination | Private, loopback, link-local, CGNAT, multicast, documentation, benchmarking, and metadata ranges are refused, including IPv4 addresses carried in IPv6 transition forms. Private-only names (`localhost`, `.internal`, `.local`, …) are refused before lookup |
| DNS rebinding | The host is resolved once; any private answer rejects it; the socket connects only to an address from that validated set |
| Redirects | Never followed automatically. Session fetches follow at most 5 same-origin, in-scope redirects through the same transport |
| Response size | A declared or streamed (decoded) body above 2 MiB is refused; bodies rendered into tool results are truncated at 1 MiB |
| Operator overrides | `AGENTPAY_ALLOWED_PRIVATE_HOSTS` (and `AGENTPAY_KILL_CALLBACK_ALLOWED_HOSTS` for the kill callback) permit named private hosts; `AGENTPAY_ALLOW_PRIVATE_NETWORK=1` relaxes the private-destination and `https` rules for development only |

### Untrusted text and bounded state

- Identity tools (`verify_agent_identity`, `get_reputation`, `verify_agent_uaid`) return a typed, validated summary; all registry free text is bounded and placed in one nonce-fenced untrusted block.
- OTel budget state is bounded: identifiers are at most 128 characters, windows at most 30 days, and policies, agents, tasks per agent, records, decisions, and span-dedupe entries have fixed caps. Registering a policy or spending for a new agent or task past capacity is refused (fail-closed); old spend records are compacted and old decisions dropped rather than refused. A replayed span ID is counted once while it is remembered (forgetting one can only over-count spend). This state is in memory and lost on restart.
- `add_custom_token` accepts only supported chains (Base mainnet and Base Sepolia), bounded strings, and at most 64 custom tokens per chain and 96 in total; `list_chain_tokens` is paginated (at most 100 per page).

### T10 — Identity Spoofing

**Threat:** A malicious agent impersonates a legitimate agent to gain access to payment infrastructure or services.

**Mitigations in AgentPay MCP:**

| Control | Implementation |
|---------|---------------|
| ERC-8004 identity verification | `verify_agent_identity` tool validates on-chain agent identity NFTs |
| Non-custodial key management | Agent private key stored locally; never transmitted to any server |
| On-chain reputation | `get_reputation` provides verifiable transaction history and trust score |
| Session token verification | x402 session tokens are ECDSA-signed; any verifier can independently validate |

## OAuth 2.1 + PKCE Compliance

MCP 2026 roadmap requires OAuth 2.1 with PKCE for server authentication in enterprise environments.

**Current status:**

- AgentPay MCP supports configuration via environment variables (`AGENT_PRIVATE_KEY`, `AGENT_WALLET_ADDRESS`) for direct deployment
- For enterprise SSO: Azure AD and Okta can broker OAuth 2.1 tokens that gate access to the MCP server process
- PKCE flow: supported when deployed behind an OAuth 2.1-compliant reverse proxy (e.g., Azure API Management, Auth0)
- The MCP server itself authenticates agents via their on-chain identity (ERC-8004) and wallet signature, which provides cryptographic authentication independent of OAuth

**Roadmap:**

- Native OAuth 2.1 token validation in the MCP server transport layer (aligned with MCP spec evolution)
- Mutual TLS option for server-to-server deployments

## Audit Logging

> **Correction (2026-08-16):** an earlier revision of this section stated that every tool invocation is logged with an ISO 8601 timestamp, tool name and parameters, outcome, and policy-evaluation result. That was inaccurate — AgentPay MCP has no per-tool-invocation audit log. This section now describes what is actually recorded.

**What is recorded — on-chain event history, plus in-memory x402 settlement receipts.** The `get_transaction_history` tool replays AgentAccountV2 contract events for the wallet:

- Transaction executions (recipient, value, executor)
- Queued transactions (queue ID, recipient, value)
- Approvals and cancellations (queue ID **only** — recipient and value appear solely on the earlier queued event, so SIEM exports must correlate approval/cancellation records with their queue event to attribute them; a queued event that falls outside the query window leaves its approval unattributable from this tool alone)
- On-chain spend-policy updates (token, per-tx limit, period limit)
- Operator changes

Each entry carries the event type, block number, and transaction hash. These on-chain event records are immutable and independently verifiable on any node or block explorer for the configured chain (Base by default), and can be exported to enterprise SIEM systems by querying the chain directly or via `get_transaction_history`.

**Process-lifetime x402 settlement receipts.** For unscoped `event_type: all` queries, `get_transaction_history` also lists successful `x402_pay` and `x402_session_start` settlements made by the running server process: the final URL that served the paid response (this may differ from the endpoint that issued the 402 if redirects differ between the two requests), plus the caller's requested URL when different, HTTP method, amount in base units, token, payee, tx hash, and replay count. These receipts live in memory only (at most 256), are lost on restart, are not shared across processes, and are omitted from queries scoped by `from_block`/`to_block` because they carry no block position. Each is labeled `broadcast (unconfirmed)`: it is recorded when the wallet returns a tx hash, without waiting for a receipt, so a dropped or reverted transfer can still appear. They are a convenience view, not an audit log; confirm the tx hash on-chain. Only the tx hash, amount, token and payee can be checked against the chain; the URL, method and replay count are process-local metadata, the replay count changes on retries, and none of it survives a restart.



**What is NOT recorded:**

- Tool invocations, tool names, or tool parameters — no MCP-level request log exists (the in-memory x402 settlement receipts above, and the spend-intent journal when `AGENTPAY_STATE_DIR` is set, are the only process-local records; the journal holds opaque intent keys and outcomes, not tool parameters)
- In-process policy evaluation results (approvals/rejections by the `set_spend_policy` engine)
- Payment attempts rejected or failed before a transaction reached the chain
- **Reverted on-chain transactions** — a mined-but-reverted attempt rolls back its event logs, so event-based history cannot show it; auditors needing reverted attempts must consult transaction receipts or an external indexer
- Read-only tool calls (balance checks, identity lookups, history queries)
- Wall-clock timestamps — on-chain entries are ordered by block number; derive times from block timestamps

Deployments that require per-invocation audit logging should run the MCP server behind a logging gateway or wrapper that captures the JSON-RPC request/response stream and forwards it to their SIEM. AgentPay MCP does not provide this natively today.

## Dependency Security

- **Zero LiteLLM dependency** — no exposure to the March 2026 PyPI supply chain compromise
- **Minimal npm dependency tree** — `viem`, `@modelcontextprotocol/sdk`, and auditable packages only; `npm audit --omit=dev` and `npm audit` report 0 vulnerabilities as of 2026-10-25
- **Pinned CI actions** — every third-party GitHub Action is pinned to a full commit SHA
- **No Python runtime required** — eliminates PyPI supply chain attack surface entirely
- **NVIDIA-validated** — security posture reviewed as part of [NVIDIA NeMo Agent Toolkit Examples PR #17](https://github.com/NVIDIA/NeMo-Agent-Toolkit-Examples/pull/17) merge process

## Contact

Security issues: see [SECURITY.md](../SECURITY.md) for responsible disclosure process.
