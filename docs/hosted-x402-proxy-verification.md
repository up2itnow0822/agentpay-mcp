# Hosted x402 proxy buyer verification checklist

Hosted paid-MCP gateways are useful. They let an agent hit a no-signup endpoint, receive HTTP 402, pay, and keep moving.

That speed is also the risk. Before an agent signs, the buyer needs proof that the 402 challenge points to the expected recipient, chain, asset, amount, and proxy model.

## Verified market signal

On 2026-05-01, Toolstem moved from a minimal proxy README to public Cloudflare Worker code for x402-protected `/mcp/finance` and `/mcp/sec` endpoints. The Intelligence scan verified:

- `https://mcp.toolstem.com/` returned HTTP 200
- `https://mcp.toolstem.com/health` returned HTTP 200
- `POST /mcp/finance` returned HTTP 402 with x402 payment-required details
- the payment challenge used Base Sepolia USDC during the 16:03 CT check

That is a live gateway signal. It is not a claim about production maturity, custody quality, downstream data quality, or spend-control depth.

A follow-up check from this implementation run also returned a `payment-required` header where `payTo` decoded to the zero address. Treat that as preflight evidence, not a broad verdict on Toolstem. It is exactly why a buyer-side verifier should fail closed before signing.

## The buyer checklist

Do not let an agent pay a hosted x402 MCP proxy until these checks pass:

1. **Payment-required header exists.** Require `payment-required` or `x-payment-required` on the HTTP 402 response. Body-only metadata is too easy for scanners and buyers to miss.
2. **`payTo` is present and non-zero.** Reject missing recipients, malformed addresses, and `0x0000000000000000000000000000000000000000`.
3. **Network is allowlisted.** For AgentPay MCP today, that usually means Base mainnet or Base Sepolia, depending on the wallet config and test path.
4. **Asset is allowlisted.** Treat "USDC-like" as insufficient. Match the exact asset address or known native-asset encoding.
5. **Amount is under the spend cap.** Validate `amount` or `maxAmountRequired` before signing. The cap check must happen before `x402_pay` sends a proof.
6. **Approval gate is satisfied.** If the policy requires human approval, the current state must be `approved`, not merely requested.
7. **Audit log is ready.** Record endpoint, tool call, recipient, amount, network, asset, approval state, policy version, and receipt.
8. **Pooled-token lock-in is explicit.** If the proxy uses operator-held upstream credentials, the buyer must accept that model on purpose. Unknown is not accepted by default.

## Test path in AgentPay MCP

`src/utils/hosted-proxy-verification.ts` adds a buyer-side verification helper. It validates the remote 402 challenge and the local buyer controls before payment.

Minimal use:

```ts
import { verifyHostedProxyPaymentRequirement } from 'agentpay-mcp/dist/utils/hosted-proxy-verification.js';

const result = verifyHostedProxyPaymentRequirement({
  status: 402,
  headers: { 'payment-required': paymentRequiredHeader },
  allowedNetworks: ['base-sepolia'],
  allowedAssets: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
  maxAmountRequired: '25000',
  approvalGate: { required: true, state: 'approved' },
  auditLog: { required: true, destination: 'otel', correlationId: 'tool-call-123' },
  upstreamCredentialMode: 'buyer-owned',
});

if (!result.ok) {
  throw new Error(result.failures.join('\n'));
}
```

The tests cover the failure cases buyers care about:

- missing or body-only payment-required metadata
- zero or malformed `payTo`
- network drift
- asset mismatch
- amount over the spend cap
- pending approval
- missing audit correlation
- unresolved operator-pooled upstream tokens

Run:

```bash
npm test -- --run tests/hosted-proxy-verification.test.ts
```

## AgentPay position

AgentPay MCP is not trying to be every hosted data proxy. It is the buyer-side payment-control layer: verify the 402, enforce policy, gate approval, sign locally, and write the audit row.

Use hosted proxies when they save setup time. Keep spend authority in AgentPay before the signature exists.
