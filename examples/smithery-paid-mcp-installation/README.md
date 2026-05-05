# Smithery paid MCP installation example

This example is intentionally documentation-first because the live Smithery listing for AgentPay MCP still needs external verification. It gives app teams the copy-paste shape for Smithery CLI, Vercel AI SDK MCP, and `@smithery/api` TypeScript usage while preserving AgentPay's payment-safety invariant.

## Install shape

```bash
npm install -g smithery
smithery namespace create agentpay-buyer-demo
smithery mcp add up2itnow0822/agentpay-mcp
smithery tool list <connection>
```

Do not run a paid tool from a directory-installed server until the host app has loaded a spend policy and captured a fresh `.well-known/x402` snapshot.

## Safety defaults

```bash
export CHAIN_ID="84532"
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

// Check manifest freshness and request human approval before calling agentpay.tools.x402_pay.
```

See `docs/smithery-paid-mcp-installation.md` for the full proof and acceptance checklist.
