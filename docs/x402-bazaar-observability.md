# x402 Bazaar observability for paid MCP tools

x402 Bazaar is moving from passive discovery metadata to searchable catalog behavior. AgentPay MCP should treat that as a production contract: paid MCP tools need searchable metadata, shared facilitator auth, and visible extension outcomes after verify and settle.

This recipe tracks the x402 Foundation Apr 29 signal: WithBazaar SDK wrappers now support search, unified auth, and Python parity, and PR #2161 adds EXTENSION-RESPONSES header readback for verify and settle.

## Production goal

A paid MCP tool is Bazaar-ready only when all four checks pass:

1. The 402 response carries a `bazaar` extension with MCP search metadata.
2. The facilitator client can list and search Bazaar resources with the same auth provider used for `verify`, `settle`, and `supported`.
3. The client reads `EXTENSION-RESPONSES` from verify and settle responses.
4. AgentPay MCP writes sanitized audit rows for catalog status, policy approval, and settlement.

If any check fails, AgentPay MCP should still fail closed for payment signing. Discovery failure must not become silent spend authority.

## Bazaar metadata for MCP tools

For each paid MCP tool, the 402 response should include a `bazaar` extension under `extensions`.

```json
{
  "extensions": {
    "bazaar": {
      "info": {
        "input": {
          "type": "mcp",
          "tool": "agentpay.x402_pay",
          "description": "Pay an x402-protected API after AgentPay MCP policy approval",
          "transport": "streamable-http",
          "inputSchema": {
            "type": "object",
            "properties": {
              "resource": { "type": "string" },
              "maxAmountRequired": { "type": "string" },
              "network": { "type": "string" },
              "payTo": { "type": "string" }
            },
            "required": ["resource", "maxAmountRequired", "network", "payTo"]
          },
          "example": {
            "resource": "https://api.example.com/research/report",
            "maxAmountRequired": "100000",
            "network": "eip155:8453",
            "payTo": "0x0000000000000000000000000000000000000000"
          }
        },
        "output": {
          "type": "json",
          "example": {
            "approved": true,
            "transaction": "0x...",
            "policy_version": "agentpay-policy-2026-04-30"
          }
        }
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "required": ["input"],
        "properties": {
          "input": {
            "type": "object",
            "required": ["type", "tool", "inputSchema"],
            "properties": {
              "type": { "const": "mcp" },
              "tool": { "type": "string" },
              "description": { "type": "string" },
              "transport": { "enum": ["streamable-http", "sse"] },
              "inputSchema": { "type": "object" },
              "example": { "type": "object" }
            },
            "additionalProperties": false
          },
          "output": { "type": "object" }
        }
      }
    }
  }
}
```

Required AgentPay fields:

- `input.type`: `mcp`
- `input.tool`: MCP tool name passed to `tools/call`
- `input.description`: one sentence with the paid action and policy boundary
- `input.transport`: `streamable-http` by default, `sse` only when the server uses SSE
- `input.inputSchema`: the same schema the MCP tool advertises
- `input.example`: a safe example that does not include a real private key, API token, wallet secret, or customer identifier
- `output.example.policy_version`: the policy revision attached to the approval decision

For MCP resources, the catalog key is the tuple `resource.url` plus `input.tool`. Do not assume one MCP endpoint maps to one paid capability.

## Search checks with WithBazaar

AgentPay MCP should be discoverable by a Bazaar search query, not only by a raw list call.

```ts
import { HTTPFacilitatorClient } from "@x402/core/http";
import { withBazaar } from "@x402/extensions";

const facilitator = new HTTPFacilitatorClient({
  url: process.env.X402_FACILITATOR_URL,
  createAuthHeaders: async () => ({
    verify: { Authorization: `Bearer ${process.env.X402_FACILITATOR_TOKEN}` },
    settle: { Authorization: `Bearer ${process.env.X402_FACILITATOR_TOKEN}` },
    supported: { Authorization: `Bearer ${process.env.X402_FACILITATOR_TOKEN}` },
    bazaar: { Authorization: `Bearer ${process.env.X402_FACILITATOR_TOKEN}` }
  })
});

const client = withBazaar(facilitator);

const matches = await client.extensions.bazaar.search({
  query: "approval gated x402 MCP payment tool",
  type: "mcp",
  network: "eip155:8453",
  scheme: "exact",
  extensions: "bazaar",
  limit: 10
});
```

The `bazaar` auth header must use the same auth source as `verify`, `settle`, and `supported`. Divergent auth is a bad production signal because the agent may be able to pay but not prove catalog status.

## EXTENSION-RESPONSES readback

Facilitators may return an `EXTENSION-RESPONSES` header from `verify` or `settle`. The value is base64-encoded JSON keyed by extension name.

Example decoded value:

```json
{
  "bazaar": {
    "status": "success"
  }
}
```

Rejected example:

```json
{
  "bazaar": {
    "status": "rejected",
    "rejectedReason": "info failed schema validation"
  }
}
```

AgentPay MCP should parse the header, keep only allowlisted fields, and write the result into the payment audit row. Never log full request bodies, auth headers, private keys, payment signatures, or customer contact data.

Allowlisted fields:

- `status`
- `rejectedReason`
- `reason`
- `code`

## Audit row shape

Paid MCP tool audit rows should include enough state to debug Bazaar cataloging without leaking secrets.

```json
{
  "event_type": "x402_paid_mcp_tool_settled",
  "agent_id": "agent_123",
  "task_id": "task_456",
  "mcp_tool": "agentpay.x402_pay",
  "resource": "https://api.example.com/research/report",
  "network": "eip155:8453",
  "asset": "USDC",
  "max_amount_required": "100000",
  "pay_to_hash": "sha256:...",
  "policy_version": "agentpay-policy-2026-04-30",
  "approval_id": "approval_789",
  "verify_extension_responses": {
    "bazaar": { "status": "processing" }
  },
  "settle_extension_responses": {
    "bazaar": { "status": "success" }
  },
  "settlement_tx": "0x...",
  "created_at": "2026-04-30T05:14:00Z"
}
```

`pay_to_hash` is preferred for public logs. Internal systems can keep the raw address in encrypted storage when reconciliation needs it.

## Failure handling

- Missing Bazaar search result: payment can proceed only if the normal AgentPay policy approves it, but write `bazaar_catalog_status: missing`.
- Missing `EXTENSION-RESPONSES`: write `extension_response_status: absent`, not `success`.
- Malformed `EXTENSION-RESPONSES`: ignore the raw header, write `extension_response_status: malformed`, and keep the payment state separate.
- `bazaar.status: rejected`: surface the rejection reason to the operator and flag the MCP metadata for repair.
- Auth failure on Bazaar search: do not downgrade verify or settle auth. Fix the `bazaar` auth header path.

## Acceptance checklist

- [ ] 402 response includes `extensions.bazaar.info.input.type = "mcp"`.
- [ ] `input.tool` matches the MCP `tools/call` name.
- [ ] `input.inputSchema` matches the MCP tool schema.
- [ ] `withBazaar(...).search({ type: "mcp", extensions: "bazaar" })` returns the paid tool or a clear miss.
- [ ] `createAuthHeaders` includes `verify`, `settle`, `supported`, and `bazaar` entries.
- [ ] Verify and settle read `EXTENSION-RESPONSES` when present.
- [ ] Logs keep only `status`, `rejectedReason`, `reason`, and `code` from extension response payloads.
- [ ] Payment signing remains gated by AgentPay policy approval even when Bazaar metadata is valid.
