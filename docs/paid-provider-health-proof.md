# Paid-provider health proof checklist

A paid agent should not route work because a marketplace status page says the base service is up. It needs a machine-readable proof that answers a narrower question: which provider can receive paid work now, and what evidence says the payment path is safe?

Voidly Pay's public `pay-health/latest.json` is the right direction. On May 2, 2026, the feed reported base `health.ok: true`, but top-level `ok: false`: 5 providers probed, 2 ok, 3 failing, and `success_rate: 0.4`. Its `pay-health/stale.json` also showed stale failure streaks of 207, 207, and 312 for the failing capabilities. That is exactly why buyer agents need provider-level gates before paying.

AgentPay's buyer rule is fail closed. A provider is routable only when the health proof, receipt state, stale counter, and x402 payment metadata all pass policy.

## Required fields

Use [`paid-provider-health-proof.schema.json`](paid-provider-health-proof.schema.json) for a portable proof shape and [`fixtures/paid-provider-health-proof-voidly-2026-05-02.json`](fixtures/paid-provider-health-proof-voidly-2026-05-02.json) for a concrete failure fixture.

The proof must include:

- `generated_at` and `source` so buyers can reject stale or unauthenticated feeds.
- `health.ok` and top-level `ok` as separate values. Base service health does not prove provider routability.
- `summary.providers_probed`, `providers_ok`, `providers_failing`, and `success_rate`.
- Per-provider `status`, `stale_streak`, `receipt_state`, `receipt_id`, `verified`, and latency.
- Per-provider `x402_payment` metadata with `network`, `asset`, `payTo`, and amount fields.
- `routing.fail_closed: true` plus an explicit `decision` and reasons.

## Buyer routing policy

Before signing, the buyer should verify:

1. The proof is fresh enough for the task's risk level.
2. `summary.success_rate` meets the buyer's minimum.
3. `providers_ok + providers_failing` matches `providers_probed`.
4. Every selected provider has `status: ok`, `stale_streak` at or below policy, and a verified receipt state.
5. The x402 offer uses an allowed `network`, allowed `asset`, non-zero allowlisted `payTo`, and a positive amount.
6. `routing.fail_closed` is true. If the proof is missing or inconsistent, do not pay.

## TypeScript verification

```ts
import { verifyPaidProviderHealthProof } from 'agentpay-mcp/dist/utils/paid-provider-health-proof.js';
import proof from './paid-provider-health-proof-voidly-2026-05-02.json' assert { type: 'json' };

const result = verifyPaidProviderHealthProof(proof, {
  minimumSuccessRate: 0.95,
  maxProofAgeMs: 15 * 60 * 1000,
  maxProviderStaleStreak: 2,
  allowedNetworks: ['base-sepolia'],
  allowedAssets: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
  allowedPayTo: [
    '0x1111111111111111111111111111111111111111',
    '0x2222222222222222222222222222222222222222'
  ],
  requireVerifiedReceipt: true,
  requireX402PaymentMetadata: true
});

if (!result.ok) {
  // Fail closed: do not sign x402 payment yet.
  console.error(result.failures);
}
```

The May 2 Voidly-derived fixture is expected to fail with a strict production policy because success rate is 0.4 and three providers are stale. The two ok providers still show how a buyer validates receipt and x402 metadata once the network-level proof is healthy.

## Fail-closed routing guidance

Use these defaults for paid provider selection:

- Treat missing health proof as `deny`.
- Treat stale `generated_at` as `deny` unless a human explicitly approves degraded mode.
- Treat `health.ok: true` plus `ok: false` as `deny` for new paid work.
- Treat missing `x402_payment.network`, `asset`, or `payTo` as `deny`.
- Treat mismatched network, asset, or recipient as `deny` even if the provider's last receipt was verified.
- Log the proof hash, selected provider ID, receipt ID, x402 network, asset, payTo, amount, policy version, and approval ID before signing.

