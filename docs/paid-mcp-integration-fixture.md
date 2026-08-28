# Paid MCP Integration Fixture

This fixture gives AgentPay MCP a stable x402 Foundation paid-MCP target for
developing and testing `x402_mcp_call`.

It is intentionally a live public server instead of a mock. Use it when you
need to verify that a client can discover a remote MCP server, call a free
tool, receive an x402 payment challenge from a paid tool, apply policy before
signing, retry with payment metadata, and preserve the settlement receipt.

## Fixture

| Field | Value |
| --- | --- |
| Server | Satoshi API paid MCP fixture |
| Origin | `https://mcp.bitcoinsapi.com` |
| Health | `GET https://mcp.bitcoinsapi.com/healthz` |
| Status | `GET https://mcp.bitcoinsapi.com/status` |
| Transport | MCP over SSE |
| SSE endpoint | `GET https://mcp.bitcoinsapi.com/sse` |
| Message endpoint | `POST https://mcp.bitcoinsapi.com/messages?sessionId=...` |
| Network | Base Sepolia, `eip155:84532` |
| Facilitator | CDP x402 facilitator |
| Price | `0.001` USD test USDC per paid tool call |

## Tools

| Tool | Cost | Purpose |
| --- | ---: | --- |
| `get_current_fee_snapshot` | Free | Returns the current Bitcoin fee recommendation. |
| `get_wallet_access_profile` | Auth only | Exercises SIWX-style wallet auth and reusable access grants. |
| `plan_merchant_payout_batch` | Paid | Returns a merchant payout timing plan backed by live Bitcoin fee data. |
| `plan_expedited_payout_batch` | Paid | Prices the immediate-send tradeoff for the same merchant payout profile. |

## Acceptance-Test Shape

`x402_mcp_call` should pass this fixture when it can:

1. Connect to `https://mcp.bitcoinsapi.com/sse`.
2. List tools and see `plan_merchant_payout_batch`.
3. Call `get_current_fee_snapshot` without signing a payment.
4. Call `plan_merchant_payout_batch` without payment metadata and detect the
   x402 payment challenge.
5. Run AgentPay policy checks before producing any payment payload.
6. Decline cleanly when the request is over cap, missing metadata, or not
   approved by the human approval path.
7. Retry only after approval with `_meta["x402/payment"]`.
8. Preserve `_meta["x402/payment-response"]` in AgentPay history and in the
   tool result summary.

## Suggested Manual Probe

```bash
curl -fsS https://mcp.bitcoinsapi.com/status
```

Expected: JSON with `ok: true`, `transport: "sse"`, and the four tools listed
above.

## Notes

- This fixture is a testnet payment target. Do not use it for mainnet spend
  accounting.
- The public status response exposes only public service metadata. Keep private
  keys, buyer wallet details, and local logs out of docs and issue comments.
- If `/status` returns a Cloudflare `502`, the public tunnel is alive but the
  local MCP listener behind it is down. Retest once the server owner confirms
  the listener has restarted.
