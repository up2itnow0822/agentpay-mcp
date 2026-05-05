# AgentPay MCP paid-tool quality thresholds

Strale's May 4 launch signal is clear: paid MCP buyers are going to ask for score gates, not only catalog listings.

A paid tool directory can be useful and still be unsafe for wallet signing. The buyer needs four checks before any x402 call:

1. A fresh tool-quality score with the exact field used by the directory.
2. A provider-health snapshot for the provider that will receive payment.
3. A minimum-quality policy owned by the buyer, not the seller.
4. A fail-closed approval gate that blocks signing when the proof is stale, below threshold, or missing x402 metadata.

## Proof shape

The fixture at `docs/fixtures/paid-tool-quality-threshold-strale-2026-05-04.json` uses:

- `score.current`, `score.min_required`, `score.measured_at`, and `score.stale_after_seconds`.
- dimension scores for reliability, availability, receipt integrity, and policy fit.
- `provider_health.status`, `success_rate_24h`, `stale_streak`, and `receipt_state`.
- x402 payment metadata: network, asset, payTo, and max amount.
- `approval_gate.fail_closed=true` plus a buyer approval decision.

## Buyer policy

AgentPay treats the buyer policy as the final authority. If a directory says `min_required=75` and the buyer policy says `minimumScore=85`, the buyer policy wins.

The helper in `src/utils/paid-tool-quality-threshold.ts` denies payment when:

- the score or proof is older than the buyer's maximum age,
- the score is older than the proof's own stale window,
- the score falls below the buyer threshold,
- provider health is degraded or below the required success rate,
- receipt state is not verified when verified receipts are required,
- x402 network, asset, or payTo are outside the allowlist,
- human approval is required but missing.

That gives AgentPay parity with score-threshold catalogs while keeping signing authority on the buyer side.

## Verification

Run:

```bash
npm run typecheck
npm test -- paid-tool-quality-threshold
```

Expected behavior: stale or below-threshold proofs return `decision: "deny"` and never permit x402 signing.
