# Smithery paid MCP installation and SDK proof

Status: PR-ready proof. Do not claim a live verified Smithery listing until Smithery listing verification succeeds.

## Why this exists

Rug Munch added a Smithery badge and then added copy-paste install paths for Smithery CLI, Vercel AI SDK MCP, and the Smithery TypeScript SDK on 2026-05-04. That is a signal for paid MCP providers: a directory badge and generated SDK example are now part of trust and onboarding, not decoration.

AgentPay MCP treats those install paths as payment-critical surfaces. A developer can connect through Smithery, but paid tools still need approval gates, spend-limit defaults, and a fresh x402 manifest check before any signing path runs.

## Verified surfaces in this package

- `smithery.yaml` declares the stdio start command and required wallet environment variables.
- `glama.json` and `docs/mcp-registry-listing.json` document catalog metadata.
- `docs/x402-dynamic-paid-mcp-manifest-drift.md` defines the stale-manifest check before buyer agents sign.
- This file defines Smithery, Vercel AI SDK MCP, and `@smithery/api` connection patterns with payment safety gates.

## Smithery CLI install path

Use this only after replacing the package slug with the live Smithery slug that Smithery verifies for AgentPay MCP. Until then, use the local npm or GitHub install path and keep this as a PR-ready Smithery install recipe.

```bash
# Install the Smithery CLI.
npm install -g smithery

# Create or select a namespace for the buyer app.
smithery namespace create agentpay-buyer-demo

# Add the AgentPay MCP server once the Smithery listing is verified.
smithery mcp add up2itnow0822/agentpay-mcp

# List tools before any paid call.
smithery tool list <connection>
```

Payment rule: the CLI path may discover tools, but it must not execute `x402_pay` until the server has an operator spend policy and the caller has approved the exact payee, network, asset, amount, and manifest snapshot. Use `x402_quote` to read the offered terms without paying.

## Required buyer environment

Server environment (read by AgentPay MCP; v5.0.0 refuses every spend without an operator policy):

```bash
export AGENT_PRIVATE_KEY="<local non-custodial test key>"
export AGENT_WALLET_ADDRESS="0xYourBuyerWallet"
export CHAIN_ID="84532"
export RPC_URL="https://sepolia.base.org"
export AGENTPAY_POLICY_PER_TX_CAP_ETH="1"
export AGENTPAY_POLICY_DAILY_LIMIT_ETH="5"
export AGENTPAY_X402_MAX_PAYMENT="1.00"
export AGENTPAY_STATE_DIR="$HOME/.agentpay-state"
```

Host-app settings (read by the example host code below, not by the server):

```bash
export AGENTPAY_DEFAULT_MAX_USDC="1.00"
export AGENTPAY_APPROVAL_MODE="human_required"
export AGENTPAY_MANIFEST_MAX_AGE_SECONDS="300"
```

Defaults for paid MCP onboarding:

- Start on Base Sepolia (`CHAIN_ID=84532`) until a mainnet cutover checklist passes.
- Set the per-call cap to `1.00` USDC or less for first-run demos. Every `x402_pay` call must pass `max_payment_eth`; `AGENTPAY_X402_MAX_PAYMENT` caps it server-side.
- Require human approval for every paid tool call in example apps.
- Reject manifests older than 300 seconds for dynamic paid MCP gateways.
- Fail closed if the x402 manifest omits network, asset, payTo, maxAmount, tool count, or trial policy.

## Vercel AI SDK MCP client setup

This example connects through Smithery transport, loads tools, then wraps payment tools with a host-side approval check before the model can execute them.

```typescript
import { createMCPClient } from "@ai-sdk/mcp";
import { generateText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createConnection } from "@smithery/api/mcp";
import { z } from "zod";

const { transport } = await createConnection({
  mcpUrl: process.env.AGENTPAY_SMITHERY_MCP_URL!,
});

const mcpClient = await createMCPClient({ transport });
const mcpTools = await mcpClient.tools();

const approvePaidCall = tool({
  description: "Approve one x402 paid MCP call after manifest and spend-policy checks pass.",
  parameters: z.object({
    merchant: z.string(),
    network: z.enum(["base", "base-sepolia"]),
    asset: z.literal("USDC"),
    amountUsd: z.number().max(1),
    manifestFetchedAt: z.string(),
  }),
  execute: async (request) => {
    const fresh = Date.now() - Date.parse(request.manifestFetchedAt) <= 300_000;
    if (!fresh) return { approved: false, reason: "x402 manifest is stale" };
    return { approved: true, maxUsd: 1, approvalMode: "human_required" };
  },
});

const { text } = await generateText({
  model: anthropic("claude-sonnet-4-20250514"),
  tools: { ...mcpTools, approvePaidCall },
  prompt: "List the AgentPay MCP payment tools, then ask for approval before any paid call.",
});

await mcpClient.close();
```

Production rule: if a host app uses AI SDK native tool approval, keep AgentPay MCP server-side approval enabled too. Client approval is user experience. Server-side policy is the signing guard.

## `@smithery/api` TypeScript connection

This path is useful when Smithery generates a typed SDK for the listing. The typed client still needs an AgentPay approval wrapper before it calls a paid tool.

```typescript
import Smithery from "@smithery/api";
import { AgentpayMcp } from "https://api.smithery.ai/sdks/typescript/up2itnow0822/agentpay-mcp/latest";

const smithery = new Smithery({ apiKey: process.env.SMITHERY_API_KEY });

const conn = await smithery.connections.create("agentpay-buyer-demo", {
  mcpUrl: process.env.AGENTPAY_SMITHERY_MCP_URL!,
});

const agentpay = new AgentpayMcp({
  smithery,
  namespace: "agentpay-buyer-demo",
  connectionId: conn.connectionId,
});

const manifest = await fetch(`${process.env.AGENTPAY_PROVIDER_URL}/.well-known/x402`).then((r) => r.json());
if (Date.now() - Date.parse(manifest.generated_at) > 300_000) {
  throw new Error("Refusing paid MCP call because x402 manifest is stale");
}

// Read the live 402 terms without paying. The server returns validated
// offers (pay_to, asset, network, amount_base_units) for the configured network.
const quote = await agentpay.tools.x402_quote({ url: manifest.example_paid_url });
const offer = pickApprovedOffer(quote, manifest); // must match manifest.payTo / asset / network

const approval = await requestHumanApproval({
  merchant: offer.pay_to,
  network: offer.network,
  asset: offer.asset,
  amountUsd: "1.00",
  tool: "x402_pay",
});

if (!approval.approved) {
  throw new Error("Payment blocked before signing");
}

const result = await agentpay.tools.x402_pay({
  url: manifest.example_paid_url,
  max_payment_eth: "1.00", // whole units of the selected asset (1.00 USDC)
  pay_to: offer.pay_to,    // a 402 naming any other payee is refused before signing
  asset: offer.asset,
  network: offer.network,
  idempotencyKey: `smithery-demo-${manifest.snapshot_id}`,
});
```

## Freshness gate for paid MCP manifests

Before routing through any Smithery-installed paid MCP server, capture this proof bundle:

```json
{
  "listing": "smithery",
  "package": "agentpay-mcp",
  "manifest_url": "https://provider.example/.well-known/x402",
  "manifest_fetched_at": "2026-05-04T10:35:00Z",
  "max_manifest_age_seconds": 300,
  "network": "base-sepolia",
  "asset": "USDC",
  "pay_to_present": true,
  "trial_policy_present": true,
  "spend_policy": {
    "approval_mode": "human_required",
    "per_call_cap_usdc": "1.00",
    "daily_cap_usdc": "5.00"
  },
  "decision": "approved_for_demo_only"
}
```

Reject the connection if any field is missing or stale. A Smithery badge proves the install path is visible. It does not prove the buyer approved payment.

## Acceptance checklist

- Smithery CLI install instructions are present but do not claim live listing verification.
- Vercel AI SDK MCP setup shows `@smithery/api/mcp` transport and a paid-call approval tool.
- `@smithery/api` TypeScript setup shows typed SDK connection with a stale-manifest rejection.
- Spend defaults are capped for first-run demos, and the server has an operator spend policy.
- `x402_pay` examples pass `max_payment_eth` and `pay_to` taken from an approved `x402_quote` offer.
- The signing invariant is explicit: no approval means no x402 signing.
