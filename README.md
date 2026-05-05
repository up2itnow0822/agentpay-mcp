# AgentPay MCP

[![npm version](https://img.shields.io/npm/v/agentpay-mcp.svg)](https://www.npmjs.com/package/agentpay-mcp)
[![Glama MCP Server](https://img.shields.io/badge/glama.ai-MCP%20server-1ee495?logo=githubsponsors&logoColor=1ee495&labelColor=0a0a0a)](https://glama.ai/mcp/servers/up2itnow0822/claw-pay-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-273%20passing-brightgreen.svg)](tests/)
[![Patent Pending](https://img.shields.io/badge/patent-pending-orange.svg)](https://uspto.gov)

**Compatible with x402 V1/V2 + Stripe MPP — protocol-agnostic spend controls.**

**agentpay-mcp is the human-first trust and policy layer above commodity execution rails (x402, ACP, UCP).** OWS-compatible trust layer -- works on top of [MoonPay Open Wallet Standard](https://github.com/nicholashudson2/open-wallet-standard). Protocol-agnostic trust layer -- works with x402 AND Stripe MPP. While x402 settles $600M annualized — with AI agents driving 40% of protocol activity (March 2026) — the missing piece isn't payment execution. It's governance: who approved it, how much can be spent, and what happens when the agent tries to exceed its budget. That's what agentpay-mcp provides.

> **ACP handles what agents SELL. agentpay-mcp handles what agents BUY.** ACP (Agent Commerce Protocol) enables agents to list services, negotiate, and receive payments. agentpay-mcp is the complementary layer — controlling what agents *spend* when consuming paid APIs, tools, and services. Different problems, compatible solutions.

When your agent hits HTTP 402 Payment Required, it needs to pay and retry — with your approval, within limits you set. AgentPay MCP is a Model Context Protocol server that gives Claude, Cursor, and any MCP-compatible agent a payment wallet with hard spend caps, human-approval mode, and a full on-chain audit trail.

The MCP ecosystem now has 97M+ monthly downloads and 10,000+ active servers — agentpay-mcp is the only MCP-native full payment execution layer.

✅ Integrated into **[NVIDIA/NeMo-Agent-Toolkit-Examples](https://github.com/NVIDIA/NeMo-Agent-Toolkit-Examples/pull/17)** (PR #17 merged) — payment infrastructure for NVIDIA's official agent toolkit.

📌 x402 ecosystem listing context is tracked in [`docs/x402-ecosystem-submission.md`](docs/x402-ecosystem-submission.md).

## Who Uses agentpay-mcp?

agentpay-mcp is built for three buyer personas who all share the same problem: autonomous agents spending money without controls.

| Persona | Problem | What They Use agentpay-mcp For |
|---------|---------|--------------------------------|
| **FinOps Practitioners** (Fortune 500 AI spend owners) | 98% of FinOps teams now manage AI spend (FinOps Foundation 2026) — but no governance layer exists for autonomous agents | Cost center attribution, per-agent budget caps, CFO-ready spend dashboards, policy-as-code enforcement |
| **Platform Engineers** (MCP / agent framework builders) | Agents call paid APIs at runtime with no native spend controls in x402, Stripe MPP, or MCP protocol | Drop-in spend governance middleware: daily caps, kill switches, per-task limits, audit trails |
| **Enterprise Compliance Teams** (EU AI Act, SOC 2, internal audit) | EU AI Act Article 14 (enforced Aug 2, 2026) requires runtime human oversight and decision-time enforcement for autonomous agents | Human-approval queues, runtime kill switches, full on-chain audit trail for compliance evidence |

> **FinOps teams:** agentpay-mcp is the first governance layer designed for your workflows — not just for developers. Budget caps, approval thresholds, and cost attribution that slot into your existing FinOps tooling.

---

## Why Trust Matters

McKinsey's 2026 AI Trust Maturity Survey quantifies what builders already feel: agent capability has outpaced agent governance.

| Finding | Stat |
|---------|------|
| Enterprises that formally approve agents before deployment | **14.4%** |
| Enterprises reporting at least one agent security incident | **88%** |
| Enterprises confident in agent IAM for payments | **18%** |

The trust gap is the deployment gap. Enterprises aren't saying agents don't work — they're saying the oversight infrastructure (approval workflows, spending guardrails, identity verification, audit trails) hasn't kept pace.

AgentPay MCP addresses this directly:

- **Human-approval mode** — transactions above your threshold require explicit human confirmation before executing
- **On-chain spend caps** — enforced by smart contract, not application code. The agent cannot override them.
- **Full audit trail** — every payment attempt logged with merchant, amount, timestamp, approval status
- **Fail-closed** — any policy engine error produces rejection, never approval
- **Non-custodial** — private keys never leave the local machine

When 88% of enterprises have had an agent security incident, "trust by default" is not a viable architecture. AgentPay MCP is built for "verify, then trust" — which is the only model that scales.

---

## Why Cost Governance Matters for MCP Agents

The Model Context Protocol gives agents access to powerful tools — but the protocol itself has no built-in mechanism for controlling what those tools cost. This isn't a theoretical gap. WorkOS's 2026 guide to MCP security explicitly identifies **rate limiting, cost attribution, and per-call spend caps** as unsolved problems at the MCP protocol level. Every MCP server can charge. No MCP client enforces budgets.

The result: an agent with access to 10 MCP servers can accumulate unbounded costs across sessions, with no standard way to attribute spend per tool, cap exposure per call, or halt runaway loops before they drain a wallet.

AgentPay MCP closes this gap at the infrastructure layer:

| MCP Cost Governance Gap | AgentPay MCP Solution |
|---|---|
| No per-call spend caps in the MCP spec | **On-chain per-transaction caps** — enforced by smart contract, not application logic |
| No cost attribution across MCP servers | **Full transaction history** with merchant, amount, timestamp, and tool context per call |
| No rate limiting for paid tool invocations | **Daily aggregate spend limits** — hard ceiling regardless of how many tools or sessions run |
| No human oversight mechanism in the protocol | **Human-in-the-loop approval** — transactions above threshold queue for explicit human review |
| No simulation/dry-run for cost estimation | **Simulation mode** — preview transaction cost and recipient before committing funds |

If you're building agents that interact with paid APIs, MCP spend limits and MCP cost governance aren't optional — they're the difference between a demo and a production deployment. AgentPay MCP is the open-source reference implementation for solving this at the protocol's edge.

---

## Security & Dependencies

AgentPay MCP is built for enterprise MCP deployments where supply chain security matters.

- **Zero LiteLLM dependency.** No direct or transitive dependency on LiteLLM or any heavyweight LLM routing layer. When LiteLLM versions 1.82.7-1.82.8 were [compromised on PyPI](https://github.com/berriai/litellm/issues) (March 2026), AgentPay MCP users were unaffected.
- **Auditable, minimal dependency tree.** The server runs on `viem`, `@modelcontextprotocol/sdk`, and a small set of auditable npm packages. No PyPI. No Python runtime required.
- **Enterprise trust signal.** Integrated into [NVIDIA's official NeMo Agent Toolkit Examples](https://github.com/NVIDIA/NeMo-Agent-Toolkit-Examples/pull/17) (PR #17, merged). NVIDIA's review process validated the security posture before merge.
- **Non-custodial architecture.** Private keys never leave the local machine. On-chain spend caps enforce limits even if the agent or its key is compromised.
- **Vercel deployment hardening.** If you deploy AI agents on Vercel, review the [Vercel deployment hardening checklist](docs/vercel-deployment-hardening.md) before reconnecting paid tools after any OAuth, dashboard, CI, or environment-variable exposure.
- **x402 scanner readiness.** For paid API demos that need scanner-readable x402 support, use the [x402 scanner-readiness recipe](docs/x402-scanner-readiness.md).
- **x402 Bazaar observability.** For paid MCP tools entering searchable Bazaar catalogs, use the [x402 Bazaar observability recipe](docs/x402-bazaar-observability.md) to cover WithBazaar search metadata, unified auth, and `EXTENSION-RESPONSES` readback.
- **x402 batch-settlement channels.** For repeat paid MCP calls that use deposit, voucher, refund, and claim flows, use the [x402 batch-settlement channel recipe](docs/x402-batch-settlement-channels.md) to keep channel storage, voucher caps, recovery, and off-chain settlement audit trails production-safe.
- **x402 multi-SDK batch-settlement parity.** For providers testing x402 TypeScript and Go batch-settlement clients, use the [multi-SDK batch-settlement parity recipe](docs/x402-multi-sdk-batch-settlement-parity.md) to prove shared channel state, phased e2e results, signer separation, refund/recovery visibility, and proof bundle shape.
- **x402 TVM readiness.** For TVM/TON exact-payment offers from emerging x402 examples, use the [x402 TVM readiness note](docs/x402-tvm-readiness.md) to confirm unsupported TVM requirements fail closed until deliberate signing, gas, jetton, and settlement support exists.
- **x402 MCP funding UX.** For hosted fund-link and managed-wallet comparisons, use the [x402 MCP funding UX benchmark](docs/x402-mcp-funding-ux-benchmark.md) to keep onboarding speed separate from approval gates, daily caps, auditability, and non-custodial controls.
- **Directory introspection readiness.** For Glama, Smithery, and other MCP catalogs, use the [directory introspection readiness note](docs/directory-introspection-readiness.md) for verified `npx`, Docker, MCP name, and non-custodial metadata paths.
- **x402 v2.11 paid MCP compatibility.** Use the [compatibility proof](docs/x402-v211-paid-mcp-compatibility.md) for `Payment-Signature`, `payment-response`, `mcp-session-id`, CORS exposed headers, Streamable HTTP initialize order, receipt links, and Base Sepolia to Base mainnet cutover.
- **Directory-grade metadata proof.** Use the [registry/listing proof](docs/mcp-registry-listing-proof.md), `docs/mcp-registry-listing.json`, `glama.json`, `smithery.yaml`, and `llms.txt` for catalog crawlers and buyer agents.
- **Chain-neutral x402 gateway profile.** Use the [chain-neutral gateway profile proof](docs/x402-chain-neutral-gateway-profile.md), schema, and fixture to document supported networks, facilitator/settlement metadata, trial/refund policies, and directory manifests without leaking Base-only assumptions into non-EVM discovery.
- **Multi-ledger x402 receipt normalization.** Use the [multi-ledger receipt normalization proof](docs/x402-multi-ledger-receipt-normalization.md), schema, and XRPL fixture to normalize ledger labels, assets, settlement targets, `Payment-Signature`, `payment-response`, verification status, non-custodial boundaries, and unsupported-ledger refusals before signing.
- **Wallet-action preflight profile.** Use the [wallet-action preflight profile](docs/wallet-action-preflight-profile.md) and TRON fixture to require simulation, chain/resource caps, allowlists, recipient and amount confirmation, nonce guidance, and approval copy before irreversible sends, swaps, or resource purchases.
- **Machine-payment directory listing pack.** Use the [directory listing pack](docs/agentpay-machine-payment-directory-listing-pack.md) and [listing JSON](docs/agentpay-machine-payment-directory-listing.json) for MPP and paid-MCP directories without claiming unsupported non-EVM signing.
- **Dynamic paid MCP manifest drift.** Use the [dynamic manifest drift proof](docs/x402-dynamic-paid-mcp-manifest-drift.md), schema, and Rug Munch fixtures to validate fresh `.well-known/x402` snapshots, stale-metadata warnings, no-trial/pricing clarity, supported networks, and directory endpoint freshness before buyer agents sign.
- **Smithery paid MCP installation.** Use the [Smithery install proof](docs/smithery-paid-mcp-installation.md) and [`examples/smithery-paid-mcp-installation`](examples/smithery-paid-mcp-installation/) for Smithery CLI, Vercel AI SDK MCP, `@smithery/api`, approval gates, spend-limit defaults, and fresh x402 manifest checks. Do not claim live Smithery verification until the listing is verified.
- **x402-native vs Stripe-proxy MCP.** For builders comparing AgentPay MCP with emerging Stripe-proxy MCP repos, use the [x402-native vs Stripe-proxy note](docs/x402-native-vs-stripe-proxy.md) to keep approval gates, spend caps, audit rows, and non-custodial signing separate from proxy billing claims.
- **Hosted x402 proxy verification.** Before an agent pays a hosted x402 MCP gateway, use the [hosted x402 proxy buyer checklist](docs/hosted-x402-proxy-verification.md) to verify `payment-required` headers, non-zero `payTo`, network and asset allowlists, approval state, spend cap, audit correlation, and pooled-token lock-in.
- **Paid MCP discovery and budget response.** For SettleGrid-style discovery, metering, and budget-platform comparisons, use the [paid MCP discovery and budget response](docs/settlegrid-paid-mcp-discovery-response.md) to separate directory discovery from x402 buyer authorization.
- **Buyer-flow parity for one-command x402 tools.** For AgentScore Pay-style buyer CLI comparisons, use the [AgentPay buyer-flow parity checklist](docs/agentpay-buyer-flow-parity.md) to prove discover, check, dry-run, pay, spend caps, typed payment errors, quota envelopes, no-charge failures, idempotency, MCP exposure, and audit before signing.
- **Paid MCP gateway hardening.** For create-mcpay-style Worker scaffolds, use the [paid MCP gateway hardening checklist](docs/paid-mcp-gateway-hardening.md) to test signup, challenge parsing, key minting, atomic billing, scope defaults, no-charge validation failures, and buyer audit rows.
- **Paid-provider health proof.** For Voidly-style public provider health feeds, use the [paid-provider health proof checklist](docs/paid-provider-health-proof.md) to verify provider success rate, stale streaks, receipt state, x402 network, asset, payTo, and fail-closed routing before signing.
- **Paid-tool quality thresholds.** For Strale-style scored catalogs, use the [paid-tool quality thresholds proof](docs/paid-tool-quality-thresholds.md) to verify fresh score fields, stale-score warnings, provider-health snapshots, minimum-quality rejection, and approval gates before x402 signing.
- **Authorized cybersecurity scans.** For AgentAegis-style paid security tools, use the [authorized cybersecurity-scan payment profile](docs/authorized-cybersecurity-scan-profile.md) to require target authorization, allowed-domain binding, per-target spend caps, scan-rate policy, approval prompts, and audit receipt language.
- **Post-quantum spend-envelope compatibility.** For PQSafe-style buyer questions, use the [post-quantum spend-envelope assessment](docs/post-quantum-spend-envelope-compatibility.md) to map spend limits, allowlists, x402 receipts, approval gates, and audit metadata without claiming ML-DSA implementation.
- **Payment-critical dependency pins.** For x402 verifier and signing paths, AgentPay pins `viem` exactly at `2.48.7`, enforces the same root override, and runs a clean-install smoke check before release. See the [dependency pin policy](docs/dependency-pin-policy.md).
- **WhatsApp and SMB agent controls.** For channel-native paid agents, use the [WhatsApp and SMB paid-agent controls recipe](docs/whatsapp-smb-agent-controls.md).
- **Channel-agent affiliate payout controls.** For Axon-style affiliate and referral revenue shares, use the [channel-agent affiliate controls spec](docs/channel-agent-affiliate-controls.md) to keep payout caps, per-contact approval, audit rows, and optional x402 settlement separate from paid tool spend approval.
- **x402 chain drift.** AgentPay MCP tracks the x402 Foundation paywall-template baseline with `viem` `2.48.7` exactly, and fails closed for unmapped chains. For PaymentWrapper and paywall template changes, follow the [x402 chain-drift compatibility note](docs/x402-chain-drift-compatibility.md).

If your security team is auditing MCP server dependencies after the LiteLLM incident, `npm ls` on agentpay-mcp gives you a short, reviewable tree with zero Python supply chain exposure.

---

## Trust & Governance — A2A Protocol Alignment

Google's [Agent2Agent (A2A) protocol](https://github.com/a2aproject/A2A) (v1.0.0) establishes how agents discover, authenticate, and collaborate across organizational boundaries. The spec is built around Agent Cards, security schemes, and human-in-the-loop task management — but it deliberately does not define *spending governance* at the protocol level.

agentpay-mcp fills that gap as a complementary governance layer. Here's how our controls map to A2A's architecture:

| A2A Concept | What the Spec Defines | What agentpay-mcp Adds |
|---|---|---|
| **Agent Cards** (`capabilities`, `securitySchemes`) | Agents declare what they can do and how to authenticate | agentpay-mcp adds *spend policy* as a discoverable capability — daily caps, per-tx limits, approval thresholds |
| **Human-in-the-loop** (`input-required` task state) | Tasks can pause for human input mid-execution | agentpay-mcp enforces this for payments: transactions above a configurable threshold queue for explicit human approval before executing |
| **Security schemes** (OAuth, API keys, mTLS) | Authentication between agents | agentpay-mcp provides the *authorization* complement — not just "is this agent allowed to connect?" but "is this agent allowed to spend $X?" |
| **Extensions** (spec §4.6) | Agents can expose additional structured data beyond core A2A | Spend caps, approval history, and transaction receipts can be surfaced as extension data in A2A task metadata |
| **Opaque execution** (guiding principle) | Agents collaborate without exposing internals | agentpay-mcp preserves opacity — the paying agent's private key and internal budget logic never leave the local machine |

### What This Means in Practice

When two A2A-compliant agents collaborate on a task that involves paid API calls:

1. **Discovery** — The calling agent reads the remote agent's Agent Card (A2A spec)
2. **Authentication** — Mutual authentication via declared security schemes (A2A spec)
3. **Spend governance** — agentpay-mcp enforces budget caps, logs transactions, and gates high-value payments on human approval (agentpay-mcp layer)
4. **Audit** — Full on-chain transaction trail provides compliance evidence independent of either agent's internal state

This positions agentpay-mcp as the **spend governance layer** for A2A-compliant agent ecosystems — complementing the protocol's identity and task management with the financial controls enterprises require before deploying autonomous agents.

> **Note:** The A2A v1.0.0 spec does not define a trust scoring or trust signals mechanism at the protocol level. agentpay-mcp's governance controls (spend caps, human approval, on-chain audit trails) are designed to be compatible with future trust-related extensions as the A2A ecosystem evolves.

---

## AI Agent Discovery

AgentPay MCP is designed to be discovered and used by AI agents. Compatible with:

- **[claude-mem](https://github.com/thedotmack/claude-mem)** - Payment state (transaction history, budgets, session tokens) persists as agent memory across sessions via claude-mem's observation layer
- **[AgentSkills](https://agentskills.io)** - Installable as a cross-framework skill in any AgentSkills-compatible harness (Claude Code, Cursor, Gemini CLI, Antigravity)
- **[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)** - Pairs as the payment layer for browser-native agents

### Install as a Skill

Add to any MCP-compatible harness config:

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

Works with Claude Code, Cursor, Gemini CLI, OpenClaw, Windsurf, and any MCP client.

---

## The 402 Flow — What This Actually Does

```
Agent calls a paid API
        │
        ▼
   HTTP 402 ←── "Payment required: 0.50 USDC on Base"
        │
        ▼
AgentPay MCP evaluates your policy:
  • Is 0.50 USDC under your per-tx cap?  ($5 limit → ✅)
  • Is this recipient allowlisted?        (api.example.com → ✅)
  • Require human approval?              (under $1 threshold → auto)
        │
        ▼
  Payment sent → API retried with payment proof → 200 OK
        │
        ▼
Agent gets the data. Full tx on basescan.org.
```

---

## agentpay-mcp vs x402-mcp — What's the Difference?

Both projects enable agent payments. They solve different problems at different layers.

| Capability | **agentpay-mcp** | **x402-mcp** (Coinbase) |
|---|---|---|
| **Payment execution** | ✅ x402 + Stripe MPP | ✅ x402 only |
| **On-chain spend caps** | ✅ Smart contract enforced | ❌ No caps |
| **Per-session budget limits** | ✅ Hard session ceiling | ❌ Unlimited per session |
| **Daily aggregate limits** | ✅ Configurable daily max | ❌ No daily limits |
| **Human-in-the-loop approval** | ✅ Threshold-based queue | ❌ Fully autonomous only |
| **Transaction simulation** | ✅ Dry-run before commit | ❌ Execute or nothing |
| **Multi-protocol support** | ✅ x402 V1/V2 + Stripe MPP | ⚠️ x402 only |
| **OWS wallet compatibility** | ✅ MoonPay Open Wallet Standard | ❌ Coinbase wallet only |
| **Audit trail** | ✅ Full tx history with merchant, amount, status | ⚠️ Basic tx log |
| **FinOps integration** | ✅ Cost attribution per session/agent | ❌ Not available |
| **Fail-closed policy engine** | ✅ Errors → rejection, never approval | ❌ No policy engine |
| **Non-custodial** | ✅ Keys never leave local machine | ✅ Keys never leave local machine |
| **Enterprise trust signal** | ✅ [NVIDIA NeMo Toolkit PR #17](https://github.com/NVIDIA/NeMo-Agent-Toolkit-Examples/pull/17) merged | — |

**When to use x402-mcp:** You want the simplest possible x402 payment integration with no governance requirements. Your agent operates with unlimited budget authority.

**When to use agentpay-mcp:** You need spend controls, budget enforcement, human approval workflows, or multi-protocol support. Your agents operate against real enterprise budgets where runaway spending is a deployment blocker.

> x402-mcp adds payments to your agent. agentpay-mcp adds *governed* payments — spend caps, session limits, human approval, and audit trails that enterprises require before deploying agents against production budgets.

---

## FAQ: x402-native AgentPay MCP vs Stripe-proxy MCP

Public MCP payment repos are starting to use x402 plus Stripe Agent wording for discovery. Treat that as a market signal, not as proof that every proxy has shipped complete spend control.

**What is the main difference?**

AgentPay MCP keeps the payment decision inside the agent's policy boundary. The agent requests `x402_pay`, AgentPay checks approval state and spend policy before signing, and the audit trail records the tool, amount, merchant, receipt, and policy result. A Stripe-proxy pattern usually puts a payment or billing proxy in front of a downstream service.

**Why not use a proxy for every paid MCP call?**

A proxy can help with billing and account aggregation. It does not automatically answer who approved the spend, whether the agent stayed inside its task budget, or whether a signature was blocked before policy approval. AgentPay MCP handles those controls before payment execution.

**What proof can a directory or buyer check today?**

- npm: `agentpay-mcp@4.1.9` or newer
- Glama: https://glama.ai/mcp/servers/up2itnow0822/claw-pay-mcp
- Catalog metadata: `glama.json` and `smithery.yaml`
- Install paths: `npx` and Docker
- Introspection: 27 MCP tools including `x402_pay`, `check_budget`, `set_spend_policy`, and `otel_evaluate_spend`

**How does this compare with Lightning Wallet MCP?**

Lightning Wallet MCP is a Bitcoin wallet MCP with Glama-facing badge work and x402 fallback positioning. AgentPay MCP is focused on x402 payment-tool governance: approval gates, hard spend caps, non-custodial local signing, directory metadata, and audit rows tied to paid tool calls.

For the full checklist, see [x402-native AgentPay MCP vs Stripe-proxy MCP patterns](docs/x402-native-vs-stripe-proxy.md).

For hosted paid-MCP gateways, use [Hosted x402 proxy buyer verification checklist](docs/hosted-x402-proxy-verification.md) before signing. It checks `payment-required` headers, `payTo`, chain, asset, spend cap, approval gate, audit log, and pooled-token lock-in.

For one-command buyer CLI comparisons, use [AgentPay buyer-flow parity checklist](docs/agentpay-buyer-flow-parity.md). It turns discover, check, dry-run, pay, spend cap, typed payment errors, quota envelopes, no-charge failures, idempotency, MCP exposure, and audit into a fail-closed fixture. For paid Worker templates, use [Paid MCP gateway hardening checklist](docs/paid-mcp-gateway-hardening.md) before treating a scaffold as production-ready.

---


## Quick Start

### 1. Install

```bash
npm install -g agentpay-mcp
```

### 2. Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "npx",
      "args": ["agentpay-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x...",
        "AGENT_WALLET_ADDRESS": "0x...",
        "CHAIN_ID": "8453"
      }
    }
  }
}
```

### 3. Configure Cursor

Add to `.cursor/mcp.json` or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "npx",
      "args": ["agentpay-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x...",
        "AGENT_WALLET_ADDRESS": "0x...",
        "CHAIN_ID": "8453"
      }
    }
  }
}
```

### 4. Set Spend Caps

Once running, tell your agent:

```
Set my spend policy: $1 per transaction, $10 per day, only send to allowlisted addresses.
```

Or call `set_spend_policy` directly:

```json
{
  "tool": "set_spend_policy",
  "arguments": {
    "perTxCapEth": "0.0004",
    "dailyLimitEth": "0.004",
    "allowedRecipients": ["0xapi-provider-address..."]
  }
}
```

Now your agent can pay for APIs — and can't spend more than $1 at a time or $10 in a day, regardless of what it's instructed to do.

---

## Human-Approval Mode (the Default)

By default, transactions above your auto-approve threshold queue for human review. The agent cannot bypass this.

```
$0.50 USDC request → under $1 threshold → auto-approved → paid → result returned
$5.00 USDC request → over $1 threshold → queued → you get notified → approve or reject
```

To approve a queued payment:

```json
{
  "tool": "queue_approval",
  "arguments": {
    "action": "approve",
    "tx_id": "0x..."
  }
}
```

To reject it:

```json
{
  "tool": "queue_approval",
  "arguments": {
    "action": "cancel",
    "tx_id": "0x..."
  }
}
```

The agent sees the outcome and decides what to do next (use cached data, ask user, abort).

---

## Value Packs — Three Production Workflow Patterns

### 1. Paid API Agent

**What it does:** Finds the right paid API for a data need, pays once, caches the result.

**When to use it:** Your agent needs data (market data, enrichment, geocoding) and you want it to handle payment automatically rather than failing with a 402.

```
Agent: "I need current options flow data for AAPL"
  │
  ├─ Tries free sources → insufficient data
  ├─ Finds paid API → gets 402 for $0.25 USDC
  ├─ Checks: $0.25 < $1 cap → auto-approved
  ├─ Pays with x402_pay → gets data
  ├─ Caches result at ~/.clawpowers/state/market:AAPL:options
  └─ Returns data + payment receipt
```

**Tools used:** `x402_pay`, `check_spend_limit`, `get_transaction_history`

**Example exchange:**
```
User: Get me the options flow for AAPL for the last 7 days.

Agent: Checking free sources... insufficient. Found paid API at data.example.com.
Cost: $0.25 USDC (under your $1 auto-approve cap). Paying now.
[x402_pay → 200 OK, paid 0.25 USDC, tx: 0xabc...]
Here's the options flow data: [results]
Total cost today: $0.25 of your $10 daily budget.
```

---

### 2. Research Agent

**What it does:** Gathers from free sources first, fills gaps with paid data, compiles a structured output.

**When to use it:** You need a comprehensive research report and want the agent to spend money only where free data is genuinely insufficient.

```
Agent: "Research competitive landscape for real-time flight tracking APIs"
  │
  ├─ Scrapes free sources (GitHub, HN, docs) → baseline data
  ├─ Identifies gaps: pricing data, SLA guarantees, enterprise contacts
  ├─ Proposes paid lookups totaling $2.75 USDC → presents for approval
  ├─ Human approves
  ├─ Pays for Apollo contact enrichment ($1.50) + Crunchbase data ($1.25)
  └─ Compiles: free data + paid data → structured report
```

**Tools used:** `x402_pay`, `x402_session_start`, `x402_session_fetch`, `check_budget`

**Example exchange:**
```
User: Research the real-time flight tracking API market. Budget up to $5.

Agent: Starting with free sources... [scrapes 12 sources, builds baseline]
Gaps identified:
  - Vendor pricing (not public for 3 of 5 vendors)
  - Contact info for enterprise sales at FlightAware
  - Recent funding data for two startups

To fill these I'd spend ~$2.75 USDC:
  - Apollo contact enrichment: $1.50
  - Crunchbase firmographics: $1.25

Approve? (y/n)

User: y

Agent: [pays, fetches, compiles]
Report ready. Spent $2.75 of your $5 budget. [structured report attached]
```

---

### 3. Automation Agent

**What it does:** Completes real tasks end-to-end, paying for whatever services are needed along the way.

**When to use it:** You want an agent that can actually finish work — book a call, run an enrichment pipeline, deploy something — not just research it.

```
Agent: "Enrich this list of 50 leads and add to CRM"
  │
  ├─ Processes first 10 free (from existing data)
  ├─ Remaining 40 need enrichment → $0.10/contact = $4.00 USDC
  ├─ Presents plan: 40 contacts × $0.10 = $4.00 total → user approves
  ├─ Runs enrichment in batches of 10 (staying under per-tx cap)
  ├─ Writes enriched data to CRM via API
  └─ Reports: 50 leads enriched, $4.00 spent, 47 successful
```

**Tools used:** `x402_pay`, `x402_session_start`, `set_spend_policy`, `get_transaction_history`

---

## Enterprise FinOps — Budget Cap Templates

Production agent deployments need spending governance that satisfies enterprise FinOps requirements. These templates show common patterns for controlling agent spend at the infrastructure layer.

### Per-Agent Department Budgets

```json
// Marketing agent — $50/day cap, restricted to approved data vendors
{
  "tool": "set_spend_policy",
  "arguments": {
    "perTxCapEth": "0.02",
    "dailyLimitEth": "0.02",
    "allowedRecipients": ["0xmarketingVendor1...", "0xmarketingVendor2..."]
  }
}

// Engineering agent — $200/day cap, broader vendor access
{
  "tool": "set_spend_policy",
  "arguments": {
    "perTxCapEth": "0.04",
    "dailyLimitEth": "0.08",
    "allowedRecipients": ["0xcloudProvider...", "0xapiVendor...", "0xdataSource..."]
  }
}
```

### Tiered Approval Thresholds

Map your org's approval matrix to agent spending tiers:

```
$0 - $1      -> auto-approved (routine API calls)
$1 - $25     -> auto-approved with logging (standard tool usage)
$25 - $100   -> queued for team lead approval via queue_approval
$100+        -> queued for finance team approval
```

Set the auto-approve ceiling with `set_spend_policy`, and transactions above the per-tx cap automatically queue for human review. No code changes needed — the smart contract enforces it.

### Budget Monitoring for FinOps Dashboards

Pull real-time spend data for your FinOps tooling:

```json
// Check remaining budget before starting expensive workflows
{ "tool": "check_budget", "arguments": {} }
// Returns: { "remaining": "142.50 USDC", "spent": "57.50 USDC", "limit": "200.00 USDC" }

// Pull transaction history for cost attribution
{ "tool": "get_transaction_history", "arguments": { "limit": 100 } }
// Each entry includes: merchant, amount, timestamp, tool context — ready for FinOps import
```

These patterns work with any FinOps platform (CloudHealth, Kubecost, Apptio) — export transaction history via the MCP tool and feed it into your existing cost attribution pipeline.

---

## Environment Variables

```bash
# Required
AGENT_PRIVATE_KEY=0x...          # Agent hot wallet key (0x-prefixed hex)
AGENT_WALLET_ADDRESS=0x...       # Deployed AgentAccountV2 contract address

# Optional
CHAIN_ID=8453                    # 8453 = Base Mainnet (default, recommended)
RPC_URL=https://mainnet.base.org # Custom RPC (Alchemy/Infura recommended for production)
SESSION_TTL_SECONDS=3600         # x402 session lifetime (default: 1 hour)
FACTORY_ADDRESS=0x...            # For deploy_wallet and create_escrow
NFT_CONTRACT_ADDRESS=0x...       # For deploy_wallet
```

---

## All 23 Tools

### Payments & 402 Flow

| Tool | What It Does |
|------|-------------|
| `x402_pay` | Fetch a URL, automatically pay 402, retry — the core use case |
| `x402_session_start` | Pay once, get reusable session token for a base URL |
| `x402_session_fetch` | Make calls within an active session (no new payment) |
| `x402_session_status` | Inspect active sessions and TTL |
| `x402_session_end` | Explicitly close a session |

### Wallet & Spend Control

| Tool | What It Does |
|------|-------------|
| `get_wallet_info` | Address, balances, spend limits, queue depth |
| `send_payment` | Send ETH or ERC-20 via the AgentAccountV2 contract |
| `check_spend_limit` | Remaining spend limit for current period |
| `set_spend_policy` | Configure daily limits, per-tx caps, recipient allowlists |
| `check_budget` | Query on-chain remaining budget |
| `queue_approval` | Approve or cancel a queued transaction |
| `get_transaction_history` | On-chain event logs with filtering |
| `deploy_wallet` | Deploy a new AgentAccountV2 smart contract wallet |

### Token Operations

| Tool | What It Does |
|------|-------------|
| `lookup_token` | Token address + decimals by symbol and chain |
| `add_custom_token` | Register a custom ERC-20 in the token registry |
| `list_chain_tokens` | All registered tokens for a chain |
| `send_token` | Send any registry token (resolves address + decimals automatically) |
| `get_balances` | Token balances across one or more tokens |

### DeFi

| Tool | What It Does |
|------|-------------|
| `swap_tokens` | Uniswap V3 swap on Base, Arbitrum, Optimism, or Polygon |
| `bridge_usdc` | CCTP V2 cross-chain USDC bridge (10 EVM chains, ~12s) |

### Identity & Trust

| Tool | What It Does |
|------|-------------|
| `verify_agent_identity` | ERC-8004 on-chain identity verification |
| `get_reputation` | On-chain reputation score and history |
| `create_escrow` | Mutual-stake USDC escrow — both parties lock collateral |

---

## Key Tool Examples

### `x402_pay` — The Core Tool

```json
// Request
{
  "tool": "x402_pay",
  "arguments": {
    "url": "https://api.example.com/premium-data",
    "max_payment_eth": "0.0002"
  }
}

// Response
{ "status": 200, "body": "{ ... }" }
```

If the cost exceeds `max_payment_eth`, the tool returns an error before paying — no surprise charges.

### `x402_session_start` — Pay Once for Multiple Calls

```json
// Request
{
  "tool": "x402_session_start",
  "arguments": {
    "endpoint": "https://api.example.com/",
    "ttl_seconds": 3600,
    "label": "market-data-session"
  }
}

// Response
{ "session_id": "sess_abc123", "token": "eyJ...", "expires_at": 1741000000 }
```

```json
// Subsequent calls — no new payment
{
  "tool": "x402_session_fetch",
  "arguments": {
    "url": "https://api.example.com/stocks/AAPL",
    "session_id": "sess_abc123"
  }
}
```

### `check_budget` — Know Before You Loop

```json
// Request — check before starting an expensive loop
{ "tool": "check_budget", "arguments": {} }

// Response
{
  "remaining": "7.50 USDC",
  "spent": "2.50 USDC",
  "limit": "10.00 USDC",
  "periodEnds": "2026-03-24T00:00:00Z"
}
```

---

## Supported Chains

| Chain | Chain ID | Recommended For |
|-------|----------|----------------|
| Base Mainnet | 8453 | Everything — lowest gas, most x402 activity |
| Arbitrum One | 42161 | High-throughput swaps |
| Optimism | 10 | Low-cost transfers |
| Polygon | 137 | High-frequency micro-payments |
| Ethereum Mainnet | 1 | Identity, large settlements |
| Avalanche | 43114 | Bridge, transfers |
| Linea / Unichain / Sonic / Worldchain | various | Bridge, transfers |
| Base Sepolia | 84532 | Testing |

---

## Security Model

**Non-custodial:** The agent signs all transactions locally with its private key. No third party holds or validates keys.

**On-chain enforcement:**
- Per-transaction caps — over-cap transactions queue for human approval via `queue_approval`
- Daily period limits — aggregate spending enforced by the AgentAccountV2 smart contract
- Recipient allowlists — restrict which addresses the agent can send to

**Role separation:**  
The agent's signing key (`AGENT_PRIVATE_KEY`) can only transact within limits set by the wallet owner. Even if the agent's key is leaked or the agent is compromised, an attacker can only spend up to the configured cap before the next reset.

**x402 sessions:**  
Session tokens are ECDSA-signed claims. Any x402 V2 server can independently verify them — no central session store required.

**Minimal dependency footprint:**  
AgentPay MCP has **zero LiteLLM dependency**. The entire server runs on `viem` (Ethereum client), `@modelcontextprotocol/sdk`, and a handful of auditable packages — no heavyweight LLM routing layers in the dependency tree. This matters: on March 24, 2026, LiteLLM versions 1.82.7 and 1.82.8 on PyPI were [confirmed compromised](https://github.com/berriai/litellm/issues) in a supply chain attack targeting AI agent infrastructure. Any MCP server that depends on LiteLLM (directly or transitively) was exposed. AgentPay MCP was not — because payment infrastructure should have the smallest possible attack surface.

---

## agentpay-mcp Already Supports Multiple Payment Rails

The agent payment landscape just split: Coinbase's x402 (open, permissionless, on-chain) vs Stripe's MPP (permissioned, Tempo-based, USDC). Developers building production agents face a choice — or they use agentpay-mcp, which already sits above both.

agentpay-mcp is **protocol-agnostic by design:**

| Payment Rail | Status | How agentpay-mcp Works With It |
|---|---|---|
| **x402 (Coinbase)** | ✅ Supported | Native x402 V1/V2 payment execution with on-chain spend caps |
| **Stripe MPP** | ✅ Compatible | MPP-compatible settlement layer separation — agentpay-mcp governs spend policy above MPP's settlement |
| **Future rails** | ✅ Ready | Neutral governance architecture — new rails plug in without code changes |

**Why this matters:** Neither x402 nor MPP ships spend governance. x402 wallets are unlimited by default. MPP offers human-set dashboard limits but no programmatic per-session or per-task enforcement. agentpay-mcp provides the budget circuit-breaker, approval workflows, and audit trail above both — regardless of which rail settles the transaction.

This isn't a wrapper around one protocol. It's a governance layer with a deliberate separation between **policy** (who approved it, what's the budget, should a human review this) and **settlement** (which blockchain or payment network moves the money). That separation is what makes agentpay-mcp rail-neutral — and what positions it as the governance standard as the protocol war plays out.

---

## Works with AWS AgentCore

AWS AgentCore provides enterprise-grade agent hosting with Cedar-based policy enforcement for access control. Cedar policies answer: "Is this agent allowed to call this API?" and "Can this agent access this resource?"

What Cedar does NOT provide: **spend limits.** There is no Cedar primitive for "this agent can spend at most $50 per session" or "halt the agent if cumulative spend exceeds $200 today." Access control and budget governance are different problems.

agentpay-mcp adds the budget circuit-breaker on top of AgentCore:

| Layer | Who Handles It | What It Controls |
|---|---|---|
| **Access Control** | AWS AgentCore (Cedar) | Which APIs the agent can call, which resources it can access |
| **Budget Governance** | agentpay-mcp | How much the agent can spend per transaction, per session, and per day |
| **Human Oversight** | agentpay-mcp | When autonomous operation pauses for human approval |
| **Audit Trail** | Both (complementary) | Cedar logs access decisions; agentpay-mcp logs spend decisions with on-chain receipts |

**Deployment pattern:** AgentCore runs the agent with Cedar policies controlling tool access. agentpay-mcp runs as an MCP server within the agent's tool set, enforcing spend caps on every payment action. Cedar says "you may call this paid API." agentpay-mcp says "you may spend up to $5 on this call."

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "npx",
      "args": ["agentpay-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x...",
        "AGENT_WALLET_ADDRESS": "0x...",
        "MAX_TRANSACTION_USDC": "5.00",
        "DAILY_LIMIT_USDC": "50.00"
      }
    }
  }
}
```

For enterprises running agents on AgentCore: Cedar handles the "can it?" question. agentpay-mcp handles the "should it spend this much?" question. Together, they provide the access + budget governance stack that production agent deployments require.

---

## Competitive Positioning

**The simplest way to think about it: ACP (Stripe) handles what agents SELL, agentpay-mcp handles what agents BUY.**

### Stripe MCP vs agentpay-mcp

Developers often ask: "Doesn't Stripe MCP already handle agent payments?" The answer is that **they solve different problems at different layers:**

| | Stripe MCP | agentpay-mcp |
|---|---|---|
| **Direction of money** | User pays merchant (through agent) | Agent pays API provider |
| **Use case** | Checkout, subscriptions, invoicing | API access, tool payments, agent-to-agent commerce |
| **Settlement** | Traditional card rails | On-chain (Base, EVM) or Stripe MPP |
| **Spend controls** | Customer-side (cart + checkout) | Agent-side (on-chain caps, human approval, session limits) |
| **Protocol** | ACP (Agent Commerce Protocol) | x402 (HTTP 402 Payment Required) |

**Stripe MCP** is a *merchant tool* — it helps businesses charge customers through agent interfaces. Think "buy this product" or "subscribe to that plan."

**agentpay-mcp** is an *agent procurement tool* — it lets agents pay for the APIs and tools they need to do their work. Think "access this premium data endpoint" or "use this compute resource."

Most production agents will need both layers: Stripe MCP for user-facing commerce, agentpay-mcp for the agent's own tool costs. They're complementary, not competing.

---

## MCP 2026 Compliance

AgentPay MCP aligns with the emerging MCP security standards for 2026, including CoSAI (Coalition for Secure AI) threat categories and OAuth 2.1 requirements.

**Security posture documentation:** See [`docs/security-posture.md`](docs/security-posture.md) for the full compliance matrix covering:

- **CoSAI T9 (Financial Fraud)** — On-chain spend caps, merchant allowlists, and human-approval gates mitigate unauthorized agent spending
- **CoSAI T10 (Identity Spoofing)** — ERC-8004 agent identity verification + non-custodial key management prevent identity-based attacks
- **OAuth 2.1 + PKCE** — MCP server authentication supports OAuth 2.1 with PKCE for enterprise SSO integration (Azure AD, Okta)
- **MCP Audit Logging** — Every tool invocation logged with timestamp, parameters, outcome, and transaction hash (where applicable)

For enterprise security teams evaluating MCP servers: the security posture document provides the artifact your audit process needs.

---

## Architecture

```
┌─────────────────────────────────────────┐
│  AI Agent (Claude / Cursor / Windsurf)  │
└────────────────┬────────────────────────┘
                 │  MCP (stdio / SSE)
┌────────────────▼────────────────────────┐
│           AgentPay MCP Server           │
│  ┌────────────┐  ┌────────────────────┐ │
│  │  23 Tools  │  │  Session Manager   │ │
│  └─────┬──────┘  └────────────────────┘ │
│        │                                │
│  ┌─────▼──────────────────────────────┐ │
│  │       agentwallet-sdk v6.0.0       │ │
│  │  TokenRegistry  SwapModule         │ │
│  │  BridgeModule   ERC8004Client      │ │
│  └─────┬──────────────────────────────┘ │
└────────┼────────────────────────────────┘
         │  viem + RPC
┌────────▼────────────────────────────────┐
│  AgentAccountV2 Smart Contract          │
│  SpendingPolicy  ·  Tx Queue            │
│  (12 chains — Base, ETH, ARB, OP, ...)  │
└─────────────────────────────────────────┘
```

Transport: `stdio` by default (Claude Desktop, Cursor, Windsurf). SSE available for remote deployments.

---

## Contributing

```bash
git clone https://github.com/up2itnow0822/agentpay-mcp
cd agentpay-mcp
npm install
npm run build
npm test
```

---

## Patent Notice

**Patent Pending** — USPTO provisional application filed March 2026: "Non-Custodial Multi-Chain Financial Infrastructure System for Autonomous AI Agents."

We support the open x402 standard. Our filing is defensive — to prevent hostile monopolization of open payment rails, not to restrict builders using open standards.

---

## Vercel x402-mcp Interop

agentpay-mcp is fully compatible with Vercel's [`x402-mcp`](https://www.npmjs.com/package/x402-mcp) package. If you're using Vercel's `paidTool()` to monetize MCP tools, agentpay-mcp works as the client-side payment layer — your agent pays x402 invoices from `paidTool()` endpoints automatically via `x402_pay`.

**What agentpay-mcp adds on top of x402-mcp:**
- **Multi-rail payments** — route through x402 (USDC on-chain) or Stripe Machine Payments Protocol (fiat) depending on the merchant
- **Spend governance** — per-tx caps, daily limits, and human-approval queues that `paidTool()` endpoints don't enforce client-side
- **Multi-chain x402 v2** — pay on Base, Solana, or Polygon (x402 v2 supports all three networks natively)

Use Vercel x402-mcp on the server side to monetize your tools. Use agentpay-mcp on the client side to pay for tools safely.

---

## Circle Nanopayments — Zero-Gas Settlement

agentpay-mcp supports [Circle Nanopayments](https://www.circle.com/nanopayments) as a settlement option for x402 v2 payments. Nanopayments enable gas-free sub-cent USDC transfers by batching small payments into single on-chain settlements.

**How it works with agentpay-mcp:**
- Agent makes an x402 payment via `x402_pay` as normal
- If the x402 v2 server supports Circle Nanopayments, settlement happens gas-free
- Sub-cent payments ($0.001, $0.0001) become economically viable for per-call API pricing
- Cross-chain support via Circle's Gateway — works on any EVM chain

This is especially useful for high-frequency agent workflows where gas costs would otherwise exceed the payment amount. See [Circle's announcement](https://www.mexc.com/news/971904) for protocol details.

---

## x402 Ecosystem — 75M+ Transactions, Cloudflare Native Support

agentpay-mcp is built on the [x402 HTTP payment standard](https://x402.org), which has now processed **75M+ transactions on Base mainnet** — primarily through Coinbase Agentic Wallets and developer integrations.

**Cloudflare has added native x402 support** to its Agents SDK and MCP server runtime, meaning any Cloudflare Worker-hosted agent can now make x402 payments natively. Google, Circle, and Stripe are all actively integrating x402 into their agent ecosystems.

agentpay-mcp is the **open-source governance layer** on top of this infrastructure: while x402 handles the payment protocol, agentpay-mcp adds the trust controls that production agents require — HITL approval queues, spend caps, recipient allowlists, and on-chain audit trails.

| x402 Ecosystem | Status |
|---|---|
| Base mainnet transactions | 75M+ |
| Cloudflare Agents SDK | ✅ Native support |
| Cloudflare MCP servers | ✅ Native support |
| Coinbase Agentic Wallets | ✅ Primary client |
| Google / Circle / Stripe | 🔄 Active integration |
| agentpay-mcp governance layer | ✅ Open-source |

---

## OpenAI Delegated Payment Spec Compatibility

OpenAI has published a **Delegated Payment Spec** that defines how AI agents handle payments on behalf of users: a scoped token with an allowance cap, compatible with Stripe Scoped Payment Tokens (SPTs). This is the precursor architecture to native payment tooling in OpenAI's Agents SDK.

**agentpay-mcp's spending cap model directly aligns with the Delegated Payment Spec pattern:**

| Delegated Payment Spec Concept | agentpay-mcp Implementation |
|---|---|
| **Scoped token** — agent receives limited-scope credential | `AGENT_PRIVATE_KEY` — agent signs within smart contract constraints, cannot exceed scope |
| **Allowance cap** — maximum the agent can spend | `set_spend_policy` — per-tx and daily caps enforced on-chain by AgentAccountV2 |
| **Human approval** — user delegates, then agent executes | `queue_approval` — transactions above threshold require explicit human sign-off |
| **Audit trail** — all delegated spend is logged | `get_transaction_history` — immutable on-chain event log per transaction |
| **Revocation** — user can revoke delegation at any time | Spend policy updates are instant; wallet owner can freeze the agent key |

The core pattern is identical: **human approves a budget → agent executes within that budget → all activity is auditable**. The difference is settlement layer: OpenAI's spec targets Stripe SPTs (fiat rails), while agentpay-mcp settles on-chain (USDC/ETH on Base, Arbitrum, and 8 other EVM chains).

For developers building OpenAI Agents SDK workflows that need on-chain settlement or multi-rail payment execution, agentpay-mcp serves as the MCP payment tool that implements the Delegated Payment Spec pattern with on-chain enforcement rather than application-level trust.

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

Add this MCP server to any OpenAI Agents SDK workflow via MCP bridge. The agent gets `x402_pay`, `check_budget`, and `set_spend_policy` — the same scoped-token + allowance-cap pattern, enforced by smart contract.

---

## Google AP2 Compatibility

agentpay-mcp complements Google's Agent2Agent Payment (AP2) protocol. AP2 — backed by 60+ organizations including Visa, Mastercard, and PayPal — handles agent payment *authorization*: verifying that a payment request is legitimate. agentpay-mcp operates at the governance layer above AP2, adding per-agent budget caps, daily spend limits, and human-approval thresholds that AP2 deliberately scopes as out-of-band. For enterprises deploying agents across multiple payment rails, agentpay-mcp provides the unified spend governance that no individual protocol covers.

---

## EU AI Act Compliance

**Enforcement deadline: August 2, 2026.** AI systems that execute or facilitate financial transactions are classified as **high-risk** under EU AI Act Annex III. High-risk classification requires:

- ✅ **Human oversight mechanisms** — mandatory human review and override capability
- ✅ **Transparency and explainability** — auditable transaction records
- ✅ **Access controls** — spend limits that cannot be bypassed by the agent
- ✅ **Technical documentation** — conformity assessment support

agentpay-mcp satisfies all four requirements out of the box:

| Requirement | agentpay-mcp Feature |
|---|---|
| Human oversight | `queue_approval` — transactions above threshold require explicit human approval before execution |
| Audit trail | `get_transaction_history` — full on-chain event log, immutable, verifiable on basescan.org |
| Spend controls | `set_spend_policy` — per-tx caps and daily limits enforced at the smart contract layer |
| Scope restriction | Recipient allowlists — agent cannot send to unapproved addresses regardless of instructions |

European enterprises deploying agent systems that touch payments have **~150 days** to implement compliant human oversight and audit controls. agentpay-mcp is the fastest path to EU AI Act compliance for MCP-compatible agent deployments.

> **Fines for non-compliance:** Up to €35M or 7% of global annual revenue. Germany published its national enforcement bill in February 2026.

---

## License

MIT © [AI Agent Economy](https://ai-agent-economy.com)

Built by **AI Agent Economy** — infrastructure for production agent workflows.
