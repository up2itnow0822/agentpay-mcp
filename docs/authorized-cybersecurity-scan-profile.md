# AgentPay MCP authorized cybersecurity-scan payment profile

Paid cybersecurity MCP tools are different from normal paid APIs. A bad call can scan the wrong target, burn a budget, and create a compliance problem.

AgentPay's buyer-side profile requires proof before signing:

- target authorization attestation,
- allowed-domain binding,
- allowed scan category,
- per-target spend cap,
- scan-rate policy,
- explicit human approval,
- audit receipt language that keeps target authorization, spend cap, and x402 receipt metadata together.

## Proof shape

The fixture at `docs/fixtures/authorized-cybersecurity-scan-profile-agentaegis-2026-05-04.json` models an AgentAegis-style paid scan.

Important fields:

- `scan.target_domain`: the actual domain under test.
- `authorization.allowed_domains`: domains the owner authorized.
- `authorization.allowed_scan_categories`: categories permitted for that target.
- `spend_policy.per_target_cap_usd`: hard cap for the target.
- `spend_policy.spent_for_target_usd`: current spend for that target.
- `rate_limit.scans_used_in_window`: anti-abuse rate state.
- `approval_gate.approved`: human approval before x402 signing.
- `audit_receipt.language`: receipt text retained for audit.

## Failure rules

The helper in `src/utils/authorized-cybersecurity-scan-profile.ts` denies payment when:

- authorization is expired or not active yet,
- target domain is missing from the attestation,
- target domain is outside buyer policy,
- requested scan category is not authorized,
- requested cost exceeds buyer policy,
- the request would exceed the per-target cap,
- rate limit is exhausted,
- human approval is missing,
- audit retention is too short,
- receipt language does not mention authorized target, spend cap, and x402 receipt.

This keeps paid security tools usable without letting an agent turn x402 into an unauthorized scanner.

## Verification

Run:

```bash
npm run typecheck
npm test -- authorized-cybersecurity-scan-profile
```

Expected behavior: unauthorized targets, expired attestations, cap overruns, exhausted rate limits, and missing approvals all fail closed.
