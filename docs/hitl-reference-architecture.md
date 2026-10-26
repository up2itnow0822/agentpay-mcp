# AgentPay MCP: HITL Reference Architecture for Payment Authorization

> The reference implementation for human-in-the-loop payment workflows in MCP-compatible agents.

## Why HITL Matters

McKinsey's 2026 AI Trust Maturity Survey found that only **14.4% of enterprises formally approve AI agents before deployment**, while **88% report at least one agent security incident**. For payment operations specifically, just **18% of enterprises are confident in their agent IAM**.

The implication is clear: autonomous agent payments without human oversight are a non-starter for enterprise adoption. The question isn't whether HITL is needed — it's how to implement it without destroying the autonomy that makes agents valuable.

## The Pattern: Suggest → Approve → Execute

AgentPay MCP implements a three-phase payment authorization pattern:

```
Phase 1: SUGGEST
  Agent encounters a paid API (HTTP 402)
  AgentPay MCP evaluates spending policy
  If amount > human_approval_threshold:
    → Payment is BLOCKED (not executed)
    → Human receives approval request

Phase 2: APPROVE
  Human reviews: merchant, amount, context
  Human decides: approve or reject
  Decision is logged with timestamp

Phase 3: EXECUTE
  If approved → payment executes on-chain
  If rejected → agent receives rejection, adapts
  Full audit trail recorded regardless
```

### Code Example: Human-Approval Payment Flow

```python
from smolagents import CodeAgent, InferenceClientModel
from smolagents.x402_payment_tool import X402PaymentTool, SpendingPolicy, PaymentMode

# Configure HITL: auto-approve under $1, require human approval above
payment_tool = X402PaymentTool(
    spending_policy=SpendingPolicy(
        mode=PaymentMode.LIVE,
        max_per_transaction=10.00,
        rolling_cap=100.00,
        require_human_approval=True,
        human_approval_threshold=1.00,
        merchant_allowlist=["api.example.com", "data.provider.io"],
    )
)

agent = CodeAgent(
    tools=[payment_tool],
    model=InferenceClientModel(),
)

# Agent workflow:
# 1. Agent calls api.example.com → gets HTTP 402 for $0.50
#    → Auto-approved (under $1 threshold) → paid → data returned
#
# 2. Agent calls data.provider.io → gets HTTP 402 for $3.50
#    → BLOCKED → human sees:
#      "Agent wants to pay $3.50 to data.provider.io — approve? [y/n]"
#    → Human approves → paid → data returned
#    → OR human rejects → agent receives error, tries alternative
```

### MCP Server Configuration

```json
{
  "mcpServers": {
    "agentpay": {
      "command": "npx",
      "args": ["agentpay-mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "0x...",
        "AGENT_WALLET_ADDRESS": "0x...",
        "AGENTPAY_POLICY_PER_TX_CAP_ETH": "0.004",
        "AGENTPAY_POLICY_DAILY_LIMIT_ETH": "0.04",
        "AGENTPAY_POLICY_ALLOWED_RECIPIENTS": "0x...",
        "AGENTPAY_X402_MAX_PAYMENT": "1"
      }
    }
  }
}
```

The operator policy above is read from the server environment and cannot be changed through MCP. Since v5.0.0, AgentPay MCP refuses every spend when no operator policy is configured (unless the operator sets `AGENTPAY_ALLOW_UNPOLICED_SPEND=1`).

The agent, or the host on its behalf, can narrow that policy further for a task with the `set_spend_policy` tool:

```json
{
  "tool": "set_spend_policy",
  "arguments": {
    "scopeKey": "research-task",
    "perTxCapEth": "0.001",
    "dailyLimitEth": "0.01",
    "allowedRecipients": ["0x..."]
  }
}
```

`set_spend_policy` can only tighten. A call that raises a limit, omits a limit the scope already has, or adds a recipient outside the allowlist in force is refused, and earlier layers keep their rolling-window accounting. Loosening requires an operator restart.

Each paid call names the approved terms. Read them first with `x402_quote` (no payment), get the human's approval, then pay:

```json
{
  "tool": "x402_pay",
  "arguments": {
    "url": "https://api.example.com/premium",
    "max_payment_eth": "0.50",
    "pay_to": "0x<payee approved from x402_quote>",
    "network": "base:8453"
  }
}
```

A 402 that names a different payee, network, or asset, or asks for more than `max_payment_eth`, is refused before anything is signed.

The human-approval threshold itself is not a `set_spend_policy` setting. In AgentPay MCP the human gates are (1) the host or human approving the quoted terms before `x402_pay` is called, (2) payments above the in-process per-transaction cap being refused as drafts, and (3) transactions above the AgentAccountV2 on-chain limits being queued for owner approval through `queue_approval`.

## Why This Architecture Works

### 1. Graduated Autonomy

Not every payment needs human review. The threshold model lets agents handle routine micropayments autonomously while escalating significant transactions. This preserves agent utility without sacrificing oversight.

### 2. Layered Enforcement

The `set_spend_policy` and operator caps are enforced in the MCP server process, and the agent cannot loosen them. The tamper-resistant layer is the AgentAccountV2 smart contract: limits the wallet owner configures directly on the contract hold even if the agent, the MCP server, or the host application is compromised. Configure both; see [security-posture.md](security-posture.md) for what each layer guarantees.

### 3. Audit Trail for Compliance

AgentPay MCP records on-chain AgentAccountV2 events and, in memory, the x402 settlements made by the running process (`get_transaction_history`). It does not log rejected attempts, policy evaluation results, or human decisions; capture those in the host application or a logging gateway in front of the MCP server. See [Audit Logging](security-posture.md#audit-logging) for exactly what is and is not recorded.

## MCP 2026 Roadmap Alignment

The MCP specification is evolving toward mandatory security controls for financial operations:

- **CoSAI T9 (Financial Fraud):** AgentPay MCP's HITL pattern directly addresses this threat category
- **OAuth 2.1 + PKCE:** Enterprise authentication for MCP server access (see [security-posture.md](security-posture.md))
- **Standardized approval UX:** The `queue_approval` tool provides a consistent interface that MCP clients (Claude Desktop, Cursor, etc.) can render as native approval dialogs

## Production Reference

This HITL payment architecture is already in production:

- **[NVIDIA NeMo Agent Toolkit Examples PR #17](https://github.com/NVIDIA/NeMo-Agent-Toolkit-Examples/pull/17)** — x402 payment tool merged into NVIDIA's official agent toolkit catalog
- **[smolagents PR #2123](https://github.com/huggingface/smolagents/pull/2123)** — Native x402 payment tool with HITL support, addressing community request [#2112](https://github.com/huggingface/smolagents/issues/2112) for human-in-the-loop payment authorization

## Related Documentation

- [Security Posture](security-posture.md) — CoSAI alignment and OAuth 2.1 compliance
- [README](../README.md) — Full AgentPay MCP documentation
- [SECURITY.md](../SECURITY.md) — Responsible disclosure process
