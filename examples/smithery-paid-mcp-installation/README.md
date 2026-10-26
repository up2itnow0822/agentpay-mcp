# Smithery paid MCP installation example

This example is intentionally documentation-first because the live Smithery listing for AgentPay MCP still needs external verification. It gives app teams the copy-paste shape for Smithery CLI, Vercel AI SDK MCP, and `@smithery/api` TypeScript usage while preserving AgentPay's payment-safety invariant.

## Install shape

```bash
npm install -g smithery
smithery namespace create agentpay-buyer-demo
smithery mcp add up2itnow0822/agentpay-mcp
smithery tool list <connection>
```

Do not run a paid tool from a directory-installed server until the server has an operator spend policy and the host app has captured a fresh `.well-known/x402` snapshot.

## Safety defaults

Server environment (AgentPay MCP v5.0.0 refuses every spend without an operator policy):

```bash
export CHAIN_ID="84532"
export AGENTPAY_POLICY_PER_TX_CAP_ETH="1"
export AGENTPAY_POLICY_DAILY_LIMIT_ETH="5"
export AGENTPAY_X402_MAX_PAYMENT="1.00"
```

Host-app settings used by the example code:

```bash
export AGENTPAY_DEFAULT_MAX_USDC="1.00"
export AGENTPAY_APPROVAL_MODE="human_required"
export AGENTPAY_MANIFEST_MAX_AGE_SECONDS="300"
```

## Vercel AI SDK MCP shape

```typescript
import { createMCPClient } from "@ai-sdk/mcp";
import { createConnection } from "@smithery/api/mcp";

const { transport } = await createConnection({
  mcpUrl: process.env.AGENTPAY_SMITHERY_MCP_URL!,
});

const client = await createMCPClient({ transport });
const tools = await client.tools();

// Wrap paid tools with host-side approval before calling x402_pay.
console.log(Object.keys(tools));
await client.close();
```

## TypeScript SDK shape

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

// Check manifest freshness, read the terms with x402_quote (no payment),
// and request human approval before calling x402_pay.
const quote = await agentpay.tools.x402_quote({ url: process.env.AGENTPAY_PAID_URL! });
// ...human approves one validated offer from `quote`...
const result = await agentpay.tools.x402_pay({
  url: process.env.AGENTPAY_PAID_URL!,
  max_payment_eth: "1.00",          // required cap, whole units of the selected asset
  pay_to: "0x<approved-payee>",     // required; must match the approved offer
  network: "base-sepolia:84532",
});
```

See `docs/smithery-paid-mcp-installation.md` for the full proof and acceptance checklist.
