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
- `main` is protected by a GitHub ruleset: changes land only through a pull
  request with the `build` check green and every review thread resolved.
  No direct pushes, force-pushes, or branch deletion.
- Every outbound HTTP request to a caller-influenced destination goes through
  `src/utils/safe-fetch.ts` (https, no private destinations, pinned DNS, no
  automatic redirects, capped bodies). Never call global `fetch` for it.
- Every value-moving handler runs inside `withSpendIntent` and wraps wallet
  writes in `runClassifiedSpend`; failures after a possible broadcast lock the
  intent. Unresolved locks are never evicted; only the operator CLI clears them.
- x402 payment entry points require `max_payment_eth` and `pay_to`; the
  signed requirement must match the caller-approved terms.
- Spend policy: the operator policy comes only from the environment; MCP
  callers may only tighten. No MCP tool may loosen policy or clear spend locks.
- Remote free text (HTTP bodies, registry metadata, error strings) reaches
  tool results only through `formatUntrustedBody` or sanitizers.
- Third-party GitHub Actions are pinned to full commit SHAs; model-driven
  workflows hold no write token.
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
  `tests/x402-session-start-idempotency.test.ts`, `tests/spend-intent.test.ts`,
  `tests/workflow-security-policy.test.ts`.

## Child DOX Index

- No closer child contracts are currently defined.
