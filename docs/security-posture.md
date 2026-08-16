# AgentPay MCP — Security Posture

> Last updated: 2026-08-16

This document maps AgentPay MCP's security controls to the CoSAI (Coalition for Secure AI) threat taxonomy and MCP 2026 authentication requirements. It is intended for enterprise security teams evaluating MCP servers for production deployment.

> **Correction (2026-08-16):** Earlier revisions of this document overstated several controls. Specifically, they described the `set_spend_policy` limits, merchant allowlist, and policy engine as "enforced by the AgentAccountV2 smart contract / on-chain — cannot be overridden," and described a per-tool-invocation audit log. Neither claim was accurate. The policy configured via `set_spend_policy` is enforced **in the MCP server process**, not on-chain; on-chain limits exist only if the wallet owner has configured them directly on the AgentAccountV2 contract, which `set_spend_policy` does **not** do. The audit trail is on-chain event history only — there is no per-tool-invocation log. The sections below state what each control actually guarantees.

## CoSAI Threat Alignment

### T9 — Financial Fraud

**Threat:** An AI agent is manipulated (via prompt injection, tool poisoning, or logic error) into making unauthorized payments.

**Mitigations in AgentPay MCP:**

| Control | Implementation | Bypass Resistance |
|---------|---------------|-------------------|
| Per-transaction spending cap (in-process) | `set_spend_policy` stores a per-tx cap in the MCP server process; the payment path checks it via the in-process policy engine (`enforceSpendPolicy` — see version note below) | Process-level only — **not** on-chain. Enforced inside the MCP server; can be bypassed by code that skips the check, by a compromised server process, or **by the agent itself**: `set_spend_policy` is an ordinary unauthenticated tool, so a manipulated agent can simply call it again to raise or clear its own caps and allowlist |
| Rolling period limits (in-process) | `set_spend_policy` daily limit (24-hour rolling window), held and checked in the MCP server process; resets if the server restarts | Same — process-level only, not smart-contract enforcement |
| Merchant allowlist (in-process) | `allowedRecipients` in `set_spend_policy` restricts recipient addresses as part of the same in-process policy | Process-level only — the allowlist is **not** written to or enforced by the smart contract |
| On-chain per-tx and period limits | AgentAccountV2 smart contract limits, configured by the wallet owner directly on the contract (out-of-band — `set_spend_policy` does not write them). Readable via `check_budget` / `get_wallet_info` | On-chain — cannot be overridden by application code or the agent, **provided the owner has actually configured limits on the contract** |
| Human-approval gate | Transactions above the on-chain limits are queued by AgentAccountV2 for review; releasing one requires an owner-privileged approval transaction (`queue_approval`) | Queuing of over-limit transactions is on-chain and cannot be skipped. It is only a *human* gate if the owner key is held by a human and kept separate from the agent key |
| Fail-closed policy engine (in-process) | Any error while evaluating the in-process spend policy rejects the payment (default-deny) | Fail-closed applies within the policy check itself; a code path that never invokes the check is not covered by it |
| Audit trail | On-chain AgentAccountV2 events (executions, queued transactions, approvals, cancellations, on-chain policy updates, operator changes), retrievable via `get_transaction_history` | Immutable on-chain record — but it covers on-chain wallet operations only; see [Audit Logging](#audit-logging) for what is not recorded |

> **Version note (in-process policy enforcement):** wiring of the in-process policy engine (`enforceSpendPolicy`) into the payment path lands with PR [#29](https://github.com/up2itnow0822/agentpay-mcp/pull/29). On releases **before** that change, `set_spend_policy` records the policy but the payment path does not consult it — on those versions, treat the in-process rows above as configuration-only and rely on the on-chain AgentAccountV2 limits. Verify your installed version includes the enforcement wiring before depending on the in-process policy.

**Defense-in-depth guidance:** treat the in-process policy as a convenience guardrail and the on-chain AgentAccountV2 limits as the tamper-resistant control. `set_spend_policy` carries no authentication or privilege gate — the same agent the policy is meant to constrain can call it to weaken or clear that policy, which is exactly the capability a prompt-injected agent (the T9 threat) would exploit. Each `set_spend_policy` call also constructs a fresh policy instance, so re-calling it **resets the 24-hour rolling-spend accumulator** even if the submitted limits are unchanged. Enterprise deployments should configure on-chain limits on the contract itself and not rely solely on `set_spend_policy`.

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

**What is recorded — on-chain event history only.** The `get_transaction_history` tool replays AgentAccountV2 contract events for the wallet:

- Transaction executions (recipient, value, executor)
- Queued transactions, approvals, and cancellations (queue ID, recipient, value)
- On-chain spend-policy updates (token, per-tx limit, period limit)
- Operator changes

Each entry carries the event type, block number, and transaction hash. These records are immutable and independently verifiable on any node or block explorer for the configured chain (Base by default), and can be exported to enterprise SIEM systems by querying the chain directly or via `get_transaction_history`.

**What is NOT recorded:**

- Tool invocations, tool names, or tool parameters — no MCP-level request log exists
- In-process policy evaluation results (approvals/rejections by the `set_spend_policy` engine)
- Payment attempts rejected or failed before a transaction reached the chain
- Read-only tool calls (balance checks, identity lookups, history queries)
- Wall-clock timestamps — on-chain entries are ordered by block number; derive times from block timestamps

Deployments that require per-invocation audit logging should run the MCP server behind a logging gateway or wrapper that captures the JSON-RPC request/response stream and forwards it to their SIEM. AgentPay MCP does not provide this natively today.

## Dependency Security

- **Zero LiteLLM dependency** — no exposure to the March 2026 PyPI supply chain compromise
- **Minimal npm dependency tree** — `viem`, `@modelcontextprotocol/sdk`, and auditable packages only
- **No Python runtime required** — eliminates PyPI supply chain attack surface entirely
- **NVIDIA-validated** — security posture reviewed as part of [NVIDIA NeMo Agent Toolkit Examples PR #17](https://github.com/NVIDIA/NeMo-Agent-Toolkit-Examples/pull/17) merge process

## Contact

Security issues: see [SECURITY.md](../SECURITY.md) for responsible disclosure process.
