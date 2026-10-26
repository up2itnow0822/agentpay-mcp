# AGENTS.md -- AgentPay MCP

## Purpose

- This repository provides the canonical MCP server for policy-aware x402
  payment tools in the AI Agent Economy payment trial.

## Ownership

- AI Agent Economy owns the server, npm package, documentation, and release
  evidence.

## Local Contracts

- Preserve local signing, explicit policy checks, idempotency, and fail-closed
  handling of malformed or untrusted payment responses.
- Never use live funds or production credentials in default tests.
- Keep npm metadata, README commands, GitHub releases, and runtime behavior
  consistent.
- Treat `dist/`, coverage, dependency folders, and generated repair artifacts
  as outputs unless a closer contract says otherwise.
- Merge policy: a PR merges only with 100% green checks and every review
  comment resolved. The `main` ruleset enforces the `build` check and thread
  resolution; no direct pushes, force-pushes, or branch deletion.
- Every outbound HTTP request to a caller-influenced destination goes through
  `src/utils/safe-fetch.ts` (https, no private destinations, pinned DNS, no
  automatic redirects, capped bodies). Never call global `fetch` for it —
  this includes the value-pack examples, which import it directly.
- Every value-moving handler runs inside `withSpendIntent` and wraps wallet
  writes in `runClassifiedSpend`; failures after a possible broadcast lock the
  intent. Unresolved locks are never evicted; only the operator CLI clears them.
- x402 payment entry points require `max_payment_eth` and `pay_to`; the
  signed requirement must match the caller-approved terms. x402 intents carry
  a `lockScope` (canonical host + payee): a paid-but-undelivered payment,
  including a paid non-2xx response, blocks new x402 payments to that host
  and that payee until the operator CLI resolves it. Intents sharing a scope
  key run one at a time. Settled idempotency keys are never evicted; the
  spend journal is compacted only to live state (temp + fsync + rename).
- Operator reconciliation states the on-chain outcome: `resolve <id>
  settled` retires a keyed intent's key (tombstone), `unsettled` clears the
  lock. One process owns an `AGENTPAY_STATE_DIR` (`spend-intents.lock`:
  inode + nonce re-verified before every journal write; heartbeat through
  the owner's own descriptor; pid liveness trusted only within one host,
  boot and PID namespace; takeovers serialised). Never write the journal
  from a second process. Operator commands select intents by the `id:`
  handle (`spendIntentHandle`) or a shell-plain key, never by printed key
  text; keys are printed only through `displaySpendIntentKey`.
  `idempotencyKey` input rejects control, invisible-formatting and
  line-separator characters.
- Spend policy: the operator policy comes only from the environment; MCP
  callers may only tighten. No MCP tool may loosen policy or clear spend locks.
- Remote free text (HTTP bodies, registry metadata, error strings) reaches
  tool results only through `formatUntrustedBody` or sanitizers.
- Third-party GitHub Actions are pinned to full commit SHAs. Model-driven
  jobs (daily-review `analyze`, daily-repair `plan`) hold only read-only
  tokens and no persisted credential; deterministic jobs validate their
  artifacts and own every write. No workflow merges automatically. Every
  workflow declares `permissions`; CI that runs PR code is `contents: read`.
- `server.json` declares every environment variable the server reads.
- Codex review: the Codex review a PR gets in CI is the only Codex check;
  every Codex comment must be resolved (repaired or disposed of in writing).
  `review-gate` enforces a non-dismissed Codex review of the PR's current
  head SHA plus zero unresolved Codex threads. A review of an older commit
  does not count.
- The finding-to-fix map in `docs/security-remediation-2026-10.md` must stay
  accurate when any of these controls change.

## Work Guidance

- Make payment-safety and compatibility changes in reviewable slices.
- Keep public claims traceable to code, tests, or independent evidence.
- Keep daily review and repair automation separate from product CI health.

## Verification

- Run `npm run build`, `npm run typecheck`, and `npm test`.
- Run `npm run lint` and `npm run security`.
- Run `npm run smoke:clean-install` for package or release changes.
- Security regressions: `tests/safe-fetch.test.ts`,
  `tests/x402-onchain-write-fencing.test.ts` (real SDK, zero-write proofs),
  `tests/x402-session-start-idempotency.test.ts`,
  `tests/x402-payment-locks.test.ts`, `tests/spend-intent.test.ts`,
  `tests/spend-journal-compaction.test.ts`,
  `tests/spend-intent-reconciliation.test.ts` (real child processes),
  `tests/spend-state-lock-no-hardlinks.test.ts`,
  `tests/value-pack-safe-transport.test.ts`, `tests/value-pack-manifest.test.ts`,
  `tests/workflow-security-policy.test.ts`,
  `tests/daily-repair-publisher.test.ts` and
  `tests/daily-review-publisher.test.ts` (run the real workflow publishers
  against a git sandbox), `tests/review-gate-waiver.test.ts` (runs the real
  gate script against an in-memory GitHub), `tests/server-metadata.test.ts`.

## Child DOX Index

- No closer child contracts are currently defined.
