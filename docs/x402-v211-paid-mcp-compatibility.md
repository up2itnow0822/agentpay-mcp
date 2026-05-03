# AgentPay MCP x402 v2.11 paid MCP compatibility proof

Toolstem's May 3 paid MCP updates made a subtle problem visible: a payment can settle and the MCP call can still fail if the client, gateway, or browser uses the wrong header contract.

AgentPay MCP treats the following as the v2.11 paid MCP baseline for buyer agents and hosted gateways.

## Header contract

- Payment request header from client to gateway: `Payment-Signature`
- Deprecated header: `X-Payment`
- Receipt header from gateway to client: `payment-response`
- MCP session continuity header from gateway to client: `mcp-session-id`
- Browser-readable CORS expose value: `payment-response, mcp-session-id`

Do not accept `X-Payment` as the primary path in new paid MCP integrations. Keep it only as a migration alias when a legacy upstream requires it, and log that downgrade as compatibility debt.

## Browser and Streamable HTTP gateway rule

If a paid MCP gateway serves browser-based clients, set this response header on initialize and paid tool responses:

```http
Access-Control-Expose-Headers: payment-response, mcp-session-id
```

Without it, browser clients may pay successfully and still be unable to read the receipt or session identifier. That breaks audit trails, retries, and follow-up `tools/call` requests.

## Streamable HTTP initialize sequence

Paid Streamable HTTP clients should use this order:

1. Send MCP `initialize` first. If the gateway charges for initialize, sign the request with `Payment-Signature`.
2. Read `payment-response` and `mcp-session-id` from exposed response headers.
3. Send `notifications/initialized` only after initialize succeeds.
4. Call `tools/list` after the initialized notification is accepted.
5. Call `tools/call` with `mcp-session-id` when the gateway requires session continuity.

Do not call `tools/call` before initialize. Do not hide receipt or session headers behind browser CORS. Do not let a model retry a paid call when initialize failed or the session header is missing.

## AgentPay MCP client behavior

`x402_pay` remains the direct paid-fetch tool for one-off x402 endpoints. Use it when the buyer already has a target URL, a spend cap, and no reusable session requirement.

`x402_session_start` is the better choice when the paid endpoint supports session semantics or the buyer expects repeated calls under one paid entitlement.

Do not use either tool when the offered network is outside the configured Base mainnet or Base Sepolia x402 policy. AgentPay MCP fails closed instead of guessing a rail.

## Network-aware receipt links

AgentPay MCP uses the configured `CHAIN_ID` to turn transaction hashes into the right receipt link:

| Chain ID | Network | Receipt base URL |
|----------|---------|------------------|
| `84532` | Base Sepolia | `https://sepolia.basescan.org/tx/<txHash>` |
| `8453` | Base mainnet | `https://basescan.org/tx/<txHash>` |

A receipt proof must store the chain ID with the transaction hash. A hash without network context is not enough for buyer auditability.

## Base Sepolia to Base mainnet cutover checklist

Use this checklist before moving a paid MCP gateway from testnet to Base mainnet:

1. Change `CHAIN_ID` from `84532` to `8453`.
2. Change `RPC_URL` from `https://sepolia.base.org` or a Sepolia provider endpoint to a Base mainnet endpoint.
3. Replace testnet USDC or test payment assets with the production Base asset address accepted by the gateway.
4. Confirm `payTo` is the production recipient and not a test wallet.
5. Keep `Payment-Signature` as the signing header. Do not revert to `X-Payment` during cutover.
6. Expose `payment-response` and `mcp-session-id` through CORS for browser clients.
7. Run initialize, `notifications/initialized`, `tools/list`, and one capped `tools/call` on mainnet with a small spend cap.
8. Store receipt links with `chainId=8453` and verify the links point to `basescan.org`, not `sepolia.basescan.org`.
9. Update README, registry metadata, and any directory listing notes from Base Sepolia examples to Base mainnet production status.
10. Keep a rollback note that returns the gateway to `84532` only for test traffic.

## Verification artifact

The constants and receipt-link helper live in `src/utils/x402-v211-compatibility.ts`. Tests in `tests/x402-v211-compatibility.test.ts` assert the header names, CORS exposure value, Streamable HTTP sequence, and Base Sepolia/Base mainnet receipt links.
