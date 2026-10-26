# Security remediation — October 2026 (v5.0.0)

This document maps every finding of the October 2026 whole-repository static
security review (revision `3290e4b5b2bc3e3808734a945dfccd52e5299211`, 18
findings: 4 high, 13 medium, 1 low) to the change that repairs it and the test
that proves it. It is the source of truth for the v5.0.0 breaking changes.

## Breaking changes for integrators

| Area | Before (≤ 4.3.0) | Now (5.0.0) |
| --- | --- | --- |
| `x402_pay`, `x402_session_start` | `max_payment_eth` optional; any payee the 402 named was paid | `max_payment_eth` **and** `pay_to` are **required**. The asset is always bound (default: the chain's USDC; override with `asset`); `network` can be bound. The cap bounds principal **plus** the 0.77% fee. A 402 naming another payee, asset or network, or above the cap, is refused before any write. A settled-but-undelivered payment locks new payments to that origin. |
| New tool `x402_quote` | — | Reads an endpoint's 402 terms without paying, so they can be approved and passed to the paid tools. |
| Outbound requests | Any syntactically valid URL; global `fetch` | `https` only; private, loopback, link-local and metadata destinations refused; DNS resolved once and the socket pinned to the validated address; no automatic redirects; response bodies capped (2 MiB hard, 1 MiB rendered). |
| Spend policy | Default allow; `set_spend_policy` could replace, loosen or clear itself | Default **deny** without an operator policy (env `AGENTPAY_POLICY_*`), or explicit `AGENTPAY_ALLOW_UNPOLICED_SPEND=1`. `set_spend_policy` can only **tighten**; earlier layers keep their accounting. |
| `send_payment` | `token_decimals` overrode the registry; no idempotency | `token_decimals` is an assertion (mismatch is refused); unknown tokens read `decimals()` on-chain; `idempotencyKey` supported; ambiguous broadcasts lock. |
| Identity tools | Free-text registry metadata inline in JSON | Typed, validated summary + one nonce-fenced untrusted block. |
| `add_custom_token` / `list_chain_tokens` | Unbounded | Bounded strings, supported chains only, quotas, paginated listing. |
| OTel tools | Unbounded state | Bounded identifiers, policies, ledgers, decisions; replayed spans counted once. |

## Operator configuration

| Variable | Effect |
| --- | --- |
| `AGENTPAY_POLICY_DAILY_LIMIT_ETH`, `AGENTPAY_POLICY_PER_TX_CAP_ETH`, `AGENTPAY_POLICY_ALLOWED_RECIPIENTS` | Immutable operator spend policy. Not changeable through MCP. |
| `AGENTPAY_ALLOW_UNPOLICED_SPEND=1` | Run without an operator policy, relying solely on on-chain AgentAccountV2 limits. Off by default. |
| `AGENTPAY_X402_MAX_PAYMENT` | Operator ceiling, in USDC, applied on top of every per-call x402 cap. While set, x402 payments in any other asset are refused. |
| `AGENTPAY_STATE_DIR` | Journal spend intents (fsync'd, append-only) so ambiguous-payment locks and keyed settlements survive restarts and crashes. Reconcile with `agentpay-mcp spend-intents list` / `resolve <key>`. |
| `AGENTPAY_ALLOWED_PRIVATE_HOSTS` | Comma-separated hosts whose private address is intentionally allowed for outbound requests. |
| `AGENTPAY_ALLOW_PRIVATE_NETWORK=1` | Development only: permit private destinations and plain http. |

## Finding-by-finding

| # | Sev | Finding | Repair | Proof |
| --- | --- | --- | --- | --- |
| 1 | High | Session start can pay twice | Starts serialised per origin with re-check; origin-scoped spend intent (in-flight dedupe); a post-settlement failure locks **every** new x402 payment (session or one-off) to that origin until reconciled; every failure after `onPaymentComplete` (body read, signing, storage) is `PostSettlementSpendError` and locks; receipt recorded at payment time. `src/tools/session.ts`, `src/utils/spend-intent.ts` | `tests/x402-session-start-idempotency.test.ts` |
| 2 | High | Caller decimals amplify transfers | Registry/native/on-chain `decimals()` is authoritative; a differing `token_decimals` is refused before policy or signing; `add_custom_token` verifies `decimals()` on-chain so the registry cannot be poisoned. `src/tools/payments.ts`, `src/tools/tokens.ts` | `tests/payments.test.ts` (F2 block), `tests/custom-token-decimals.test.ts` |
| 3 | High | x402 lacks mandatory cap and bound terms | Required `max_payment_eth` + `pay_to`; asset always bound (default USDC); fee-inclusive cap; USDC-denominated operator ceiling; all compared to the SDK-selected requirement inside `onBeforePayment`. `src/utils/x402-client.ts`, `src/utils/payment-cap.ts` | `tests/x402-onchain-write-fencing.test.ts` (real SDK, zero writes) |
| 4 | High | Value-pack examples mis-scale USDC caps | Exact 6-decimal conversion; single-use immutable approval record compared to the final offer; explicit mainnet opt-in. `examples/value-packs/` | `tests/value-pack-cap-binding.test.ts` |
| 5 | Medium | Zero address accepted as payee | `assertPayableX402Recipient` refuses `0x0…0` (and as `pay_to`). | `tests/x402-onchain-write-fencing.test.ts` (F5) |
| 6 | Medium | Mutable action tags | Every third-party action pinned to a full commit SHA; Dependabot for `github-actions`. `.github/workflows/` | `tests/workflow-security-policy.test.ts` |
| 7 | Medium | Identity metadata unfenced | Typed validated summary; all registry free text bounded and nonce-fenced. `src/tools/identity.ts` | `tests/identity-untrusted-fencing.test.ts` |
| 8 | Medium | Unbounded response buffering | Transport caps declared and streamed (decoded) bytes; handlers use `readLimitedText`. `src/utils/safe-fetch.ts` | `tests/safe-fetch.test.ts` |
| 9 | Medium | OTel callback DNS rebinding | Kill callback goes through the pinned transport: one resolution, socket pinned to validated answers. `src/tools/otel-budget.ts` | `tests/otel-bounds.test.ts`, `tests/safe-fetch.test.ts` |
| 10 | Medium | Unbounded OTel state | Identifier/window caps; policy, agent, task, record, decision, span-dedupe limits (dedupe keyed per agent/task, replays count only cost increases); compacting rings; O(1) lifetime totals; fail-closed at capacity. | `tests/otel-bounds.test.ts` |
| 11 | Medium | Caller can weaken its own policy | Operator policy from env (immutable, default deny; a malformed value denies everything and is reported at startup); caller updates layer and may only tighten; scope/layer caps. `src/tools/budget.ts` | `tests/budget.test.ts` (F11 block) |
| 12 | Medium | Classification race on shared client | Wallet client hooked once; `AsyncLocalStorage` attributes each write to its own spend. No swap/restore. | `tests/spend-intent.test.ts` (F12 block, incl. exact original interleaving) |
| 13 | Medium | review-gate ignores base advances | Ordinary review evidence bound to the exact base SHA. `.github/workflows/review-gate.yml` | `tests/workflow-security-policy.test.ts` |
| 14 | Medium | Capacity eviction re-enables settlement | Unresolved locks never evicted; new spends refused at capacity; operator reconciliation CLI; optional crash-safe journal (torn-tail safe, directory fsync); evicted keyed settlements tombstoned; `send_token` pre-write failures classified definite. | `tests/spend-intent.test.ts`, `tests/spend-intents-cli.test.ts`, `tests/transfers.test.ts` |
| 15 | Medium | Unrestricted outbound requests | Safe transport on every caller-selected destination (x402, quote, sessions, kill callback). | `tests/safe-fetch.test.ts`, `tests/x402-session-start-idempotency.test.ts` |
| 16 | Medium | `send_payment` has no idempotency | Spend-intent identity, optional `idempotencyKey`, reserved policy, classified broadcast, settlement-hash requirement. `create_escrow` brought under the same contract. | `tests/payments.test.ts` (F16 block), `tests/escrow.test.ts` |
| 17 | Medium | Write-capable daily-review agent reads untrusted text | Analysis job is read-only and writes a local report; a deterministic, schema-validating publish job owns the single issue write. `.github/workflows/daily-review.yml` | `tests/workflow-security-policy.test.ts` |
| 18 | Low | Unbounded custom-token registry | Bounded strings, supported chains, per-chain/global quotas, O(1) lookups, paginated listing. `src/tools/tokens.ts` | `tests/token-registry-bounds.test.ts` |

## Residual risk (accepted, documented)

- Spend-intent state is process-local unless `AGENTPAY_STATE_DIR` is set.
  Operators running long-lived production servers should set it.
- Tombstones for evicted keyed settlements are capped (16,384); beyond that,
  very old idempotency keys may be accepted as new.
- On-chain AgentAccountV2 limits remain the tamper-resistant control; the
  application policy is defence in depth that the agent can no longer weaken.
- The MCP stdio channel is still the caller boundary: any process that can
  speak to the server can invoke its tools within the limits above.

## Independent review

An independent adversarial review of the first fix set (separate reviewer,
probe tests against the real SDK and real sockets) refuted six repairs as
partial: decimals poisoning through `add_custom_token` (F2), an unbound asset
and fee-exclusive cap (F3), an endpoint-scoped post-settlement lock (F1), a
torn journal tail swallowing the next record (F14), a malformed operator
policy degrading to "no policy" (F11), and a span dedupe that under-counted
(F10). All six were repaired with regression tests reproducing the probes,
alongside two hardening items (IPv4-translated IPv6, `create_escrow` spend
intents). The UAID resolver still reads its fixed broker URL with the SDK's
own fetch; the destination is not caller-selected.

## Codex review of PR #90

Codex reviewed `1138030` and raised seven findings; all were repaired:

| Finding | Repair | Proof |
| --- | --- | --- |
| P1 review-gate activity time field | Accepts `timestamp` (GitHub schema) or `pushed_at`; an activity feed that answers without the base tip now fails closed instead of falling back to a fakeable commit date | workflow policy test, `node --check` on all gate scripts |
| P2 future-dated base commit | Commit-date bound clamped to the run's observation time | as above |
| P1 http kill callbacks | Public kill-callback hosts require `https`; `http` only for operator-allowlisted hosts or private-network dev mode | `tests/otel-bounds.test.ts` |
| P1 journal fsync errors swallowed | File fsync failures abort the spend before any wallet write; only directory fsync is best-effort | `tests/spend-journal-fsync.test.ts` |
| P1 journal marked loaded before replay | Marked loaded only after a successful replay; an unreadable journal refuses all value movement | `tests/spend-intent.test.ts` |
| P2 send_token committed policy before broadcast | Uses reserve → commit / release / lock, so a definite pre-broadcast failure frees the allowance | `tests/send-token-reservation.test.ts` (fails on `1138030`, passes now) |
| P2 in-flight intents not counted at admission | Admission counts in-flight intents, so locks can never exceed the ceiling | `tests/spend-intent.test.ts` |

