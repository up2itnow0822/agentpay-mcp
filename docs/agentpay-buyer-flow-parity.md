# AgentPay buyer-flow parity for one-command x402 tools

AgentScore Pay moved buyer-side x402 payments toward a single shell flow: discover, check, dry-run, pay, enforce local limits, preserve an idempotency key, and expose the flow through MCP tools. npm now shows `@agent-score/pay@0.1.0-rc.13`, one revision newer than the first 00:08 CT scan.

rc.13 raised the bar again. Its release commit added typed SDK errors, quota envelope surfacing from `X-Quota-*` headers on `assess`, deterministic recovery guidance, and payment-path security patches. That means buyer-side competition is no longer only "can the agent pay?" It is "can the agent recover safely when payment, token, quota, or spend policy checks fail?"

AgentPay MCP should not copy that CLI shape blindly. Its job is narrower and safer: make the payment decision auditable before an agent signs.

## Buyer flow AgentPay must prove

A buyer-agent payment path is acceptable only when these checks pass before signing:

1. Discover or inspect the protected endpoint.
2. Parse the HTTP 402 challenge from `payment-required`, `x-payment-required`, a trusted directory record, or a manual fixture.
3. Verify the offered network and asset against the buyer allowlist.
4. Verify `payTo` is non-zero and matches the expected recipient class.
5. Compare the required amount against the caller's max spend.
6. Produce a dry-run plan.
7. Require approval when policy says approval is needed.
8. Generate or verify a stable idempotency key from method, URL, body, and signer.
9. Classify typed payment errors into deterministic retry guidance.
10. Display quota and spend envelopes before retrying.
11. Preserve no-charge failure semantics for validation, quota, token, and spend-cap failures.
12. Record the audit destination, correlation ID, receipt sink, and payment result.
13. Run through MCP tools that are visible to the host.

The helper added in this response is `src/utils/x402-buyer-flow.ts`. It turns the checklist into a small fail-closed verifier:

```ts
import { verifyX402BuyerFlow } from './src/utils/x402-buyer-flow.js';

const result = verifyX402BuyerFlow({
  method: 'POST',
  url: 'https://paid.example.com/mcp/search',
  body: '{"query":"agent payments"}',
  signer: '0x2222222222222222222222222222222222222222',
  challengeSource: 'payment-required-header',
  challenge: {
    network: 'base-sepolia',
    asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    amountRequired: '10000',
    payTo: '0x1111111111111111111111111111111111111111',
  },
  allowedNetworks: ['base-sepolia'],
  allowedAssets: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
  maxSpendAtomic: '25000',
  dryRunCompleted: true,
  approvalState: 'approved',
  typedError: {
    name: 'PaymentRequiredError',
    noCharge: true,
  },
  quota: {
    limit: '100',
    remaining: '99',
    resetAt: '2026-05-02T10:00:00Z',
    sourceHeaders: {
      'X-Quota-Limit': '100',
      'X-Quota-Remaining': '99',
      'X-Quota-Reset': '2026-05-02T10:00:00Z',
    },
  },
  mcpTools: ['x402_pay', 'check_budget', 'set_spend_policy', 'get_transaction_history', 'queue_approval'],
  audit: {
    destination: 'otel',
    correlationId: 'tool-call-abc',
    receiptSink: 'transaction-history',
  },
});

if (!result.ok) throw new Error(result.failures.join('\n'));
```

The same helper now exposes `result.recovery` and `result.envelope`:

```ts
{
  recovery: {
    errorName: 'PaymentRequiredError',
    retryability: 'retry_after_payment',
    noCharge: true,
    quotaVisible: true,
  },
  envelope: {
    spend: {
      maxSpendAtomic: '25000',
      amountRequiredAtomic: '10000',
      remainingAfterPaymentAtomic: '15000',
    },
    quota: {
      limit: '100',
      remaining: '99',
      resetAt: '2026-05-02T10:00:00Z',
    },
  },
}
```

## Typed error recovery map

| Error | Agent recovery | Retryability | No-charge rule |
|---|---|---|---|
| `PaymentRequiredError` | Obtain or approve payment, then retry with the same idempotency key | `retry_after_payment` | No charge until a valid signed payment is submitted |
| `QuotaExceededError` | Show quota limit, remaining units, reset time, and wait or change policy | `retry_after_quota_reset` when quota is visible, otherwise `operator_review` | No charge for quota rejection |
| `TokenExpiredError` | Refresh the buyer credential, then retry only after policy re-check | `refresh_token_then_retry` | No charge for expired-token rejection |
| `ValidationFailureError` | Do not retry automatically; fix recipient, chain, asset, amount, or challenge parsing | `do_not_retry` | No charge for validation failure |
| `SpendLimitExceededError` | Do not retry automatically; require operator or policy change | `do_not_retry` | No charge for local spend-cap rejection |
| `UnknownPaymentError` | Stop automation and route to operator review | `operator_review` | Treat charge state as unknown until audited |

## Quota and spend envelope display

Buyer-facing output should keep quota and spend in the same response object so an agent can decide without guessing:

- `quota.limit`, `quota.remaining`, and `quota.resetAt` from `X-Quota-*` headers or an equivalent trusted envelope.
- `spend.maxSpendAtomic`, `spend.amountRequiredAtomic`, and `spend.remainingAfterPaymentAtomic` from local policy plus the 402 challenge.
- `recovery.retryability` as a machine-readable value, not prose.
- `recovery.noCharge` as an explicit boolean for failed pre-payment checks.

If a quota error arrives without quota visibility, AgentPay should fail closed and return `operator_review`. If a typed payment error does not assert `noCharge: true`, the helper fails before retry logic can run.

## AgentScore Pay parity map

| Buyer need | AgentScore Pay signal | AgentPay MCP response |
|---|---|---|
| Discovery | `discover` queries x402 Bazaar and MPP services | Keep x402 Bazaar readback in docs and require a challenge source before pay |
| Check | `check` probes a protected endpoint | `verifyX402BuyerFlow` fails if network, asset, amount, or recipient is missing |
| Dry-run | `pay --dry-run` prints a plan | `dryRunCompleted` must be true before payment can pass verification |
| Spend cap | `--max-spend` and local limits | `maxSpendAtomic` and existing `set_spend_policy` / `check_budget` tools gate spend |
| Typed errors | `PaymentRequiredError`, `QuotaExceededError`, `TokenExpiredError` | `classifyX402PaymentError()` maps typed errors to deterministic retryability |
| Quota envelope | `X-Quota-*` surfacing on `assess` | `quota` keeps limit, remaining, reset, and source headers visible beside spend |
| No-charge failures | Deterministic recovery guidance | `typedError.noCharge` must be explicit before retry or operator action |
| Pay | One CLI command pays and retries | `x402_pay` stays the MCP payment tool, but only after policy checks pass |
| Idempotency | Stable `X-Idempotency-Key` for retries | `createX402IdempotencyKey()` derives the key from method, URL, body, and signer |
| MCP exposure | Every command can be an MCP tool | AgentPay exposes payment, budget, approval, session, and audit tools through MCP |
| Audit | Local history and structured output | `get_transaction_history`, receipt sink, and correlation ID make the result auditable |

## What AgentPay should not claim

- Do not claim AgentPay MCP has a one-command buyer CLI unless we ship that CLI.
- Do not claim Solana x402 signing support from this artifact. The verifier can detect allowlist mismatches, but AgentPay payment support remains tied to the configured supported network set.
- Do not treat MPP or opaque credits as the AgentPay default. The positioning stays x402-native buyer verification and non-custodial signing.
- Do not auto-retry quota, token, validation, or spend-limit failures unless the typed error, quota envelope, policy state, and audit trail make the retry safe.

## Validation proof

- Helper: `src/utils/x402-buyer-flow.ts`
- Tests: `tests/x402-buyer-flow.test.ts`
- README link: `README.md`
- Validation command: `npm test -- --run tests/x402-buyer-flow.test.ts`
