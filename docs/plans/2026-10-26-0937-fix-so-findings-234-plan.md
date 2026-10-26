---
title: "fix: Security Officer findings 2, 3, and 4"
date: 2026-10-26-0937
type: fix
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
origin: uploads/agentpay-mcp-90-91.md
---

# fix: Security Officer findings 2, 3, and 4

## Goal Capsule

Objective: A maintainer merging a PR cannot treat an old or dismissed Codex review as current review-gate evidence; Daily Repair cannot be redirected onto a self-hosted runner that would persist REPAIR_TOKEN; leftover workflow backups no longer sit next to live workflow files.

Means: Tighten the existing in-workflow review-gate evaluator to the current head SHA, hard-code GitHub-hosted runners and non-persisted checkout credentials on Daily Repair, and git-mv the `.bak` files to `archive/workflows-bak/` (KTD1, KTD2, KTD5, KTD7).

Authority: user request (exact scope a/b/c and hard limits) > this plan's labeled session-settled decisions > existing tests that extract and run the real workflow scripts.

Stop: do not enable or disable workflows; do not change triggers, permissions, or secrets beyond persist-credentials on the REPAIR_TOKEN checkout; do not make review-gate required; do not touch rulesets or repo settings; no version bump, tag, release, or npm publish; do not edit `package.json` version; never push to main, force-push, or merge; never comment on #90 or #91; never add or remove `codex-waived` on any PR.

Execution profile: test-first. Write the failing assertions, then change the workflow or move the files.

Who ships: this pipeline opens one ready PR from `cloud/so-findings-2-3-4-9377` onto `main` at `81fadb0`. Merge stays with the user.

## Product Contract

### Summary

Close three Security Officer findings on `up2itnow0822/agentpay-mcp` at `81fadb0` (post #90 / #91) with one PR. Finding 1 (approval policy) and Finding 5 (unpublished 5.0.0) stay out.

### Problem Frame

#90 relaxed review-gate so any Codex review of any commit still on the PR counts. After later pushes, a stale review still greens the gate. Daily Repair still accepts `vars.MAINTAINER_RUNNER` and can persist `REPAIR_TOKEN` in `.git/config` on a writable checkout. Two `.bak` workflow files sit in `.github/workflows/` on main.

### Key Decisions

- KD1. Gate evidence is the current head SHA only. (session-settled: user-directed — chosen over keeping the "Codex reviews a PR once" any-commit policy: F2 says an old-commit review must not pass)
  Governs R1, R2, R3, R4.
- KD2. `codex-waived` stay as they are. (session-settled: user-directed — chosen over rewriting waiver binding or applying/removing the label: F2 does not require waiver changes, and the user forbids label mutation)
  Governs R5.
- KD3. Daily Repair runners are a literal `ubuntu-latest`. (session-settled: user-directed — chosen over a protected `repair` environment or keeping the variable fallback: F3 names hard-coding at all four sites)
  Governs R6.
- KD4. The REPAIR_TOKEN checkout does not persist credentials. (session-settled: user-directed — chosen over leaving persist-credentials true on live runs: F3 names `persist-credentials: false`)
  Governs R7.
- KD5. Archive the `.bak` files; do not delete them. (session-settled: user-directed — chosen over `docs/archive` from the SO note: the user named `archive/workflows-bak/` and `git mv`)
  Governs R8.

### Requirements

- R1. A non-dismissed, non-pending Codex bot review whose `commit_id` is the PR's current full head SHA, newer than the last retarget, still passes (threads still must be resolved).
- R2. A Codex review whose `commit_id` is an older commit of the same PR fails the gate (Waiting for Codex review), even when that commit is still in `listCommits`.
- R3. A dismissed Codex review on the current head SHA fails the gate.
- R4. A Codex clean-pass summary comment counts only when it attests the current head SHA. An older SHA in the summary table does not pass.
- R5. Waiver evaluation, `WAIVER_ACTORS`, and `codex-waived` semantics stay unchanged. This work never adds or removes that label on any live PR.
- R6. All four Daily Repair jobs (`preflight`, `plan`, `publish`, `audit`) use a hard-coded `runs-on: ubuntu-latest`. None of them interpolates `vars.MAINTAINER_RUNNER`.
- R7. The publish-job checkout that sets `token: ${{ secrets.REPAIR_TOKEN }}` sets `persist-credentials: false` as a literal, not an expression.
- R8. `.github/workflows/daily-repair.yml.bak` and `.github/workflows/daily-review.yml.bak` move to `archive/workflows-bak/` via `git mv` and remain in the tree.

### Acceptance Examples

- AE1. When head is H and Codex reviewed earlier commit P1, evaluate publishes failure titled `Waiting for Codex review`.
- AE2. When head is H and Codex has a `DISMISSED` review on H, evaluate publishes failure titled `Waiting for Codex review`.
- AE3. When head is H and Codex has a non-dismissed, non-pending review on H after the last retarget, with no unresolved Codex threads, evaluate publishes success titled `Codex reviewed PR`.
- AE4. Parsing `daily-repair.yml` finds exactly four job `runs-on` lines, each `ubuntu-latest`, and the REPAIR_TOKEN checkout block contains `persist-credentials: false`.

### Scope Boundaries

In scope: review-gate evaluator pass condition and its comments/tests; Daily Repair runner lines and REPAIR_TOKEN persist-credentials; archive of the two `.bak` files; one ready PR listing each finding.

Out of scope: F1 approval/CODEOWNERS/required-check changes; F5 version/publish; enabling or disabling workflows; triggers, permissions, secrets other than persist-credentials; making review-gate required; rulesets; repo settings; `package.json` version; comments on #90/#91; adding or removing `codex-waived`; Daily Review runner redirect (not named).

Deferred to Follow-Up Work: if `persist-credentials: false` leaves `git push origin` without a checkout-stored token, a later change may teach the publisher to authenticate the push from `GH_TOKEN`. Do not change the publisher in this PR.

### Success Criteria

- The three named tests (old commit fails, dismissed head fails, head review passes) exist and pass against the real extracted script.
- A YAML-parse test asserts R6 and R7.
- `git ls-files` shows the `.bak` files only under `archive/workflows-bak/`.
- Existing waiver tests still pass.

## Planning Contract

### Key Technical Decisions

- KTD1. Match Codex reviews to `headSha`, not `prCommits`. (session-settled: user-directed — chosen over any-commit-of-this-PR: that is the F2 hole at review-gate.yml:784-791)
  The existing filter already excludes `DISMISSED` and `PENDING` and requires `isCodexUser` plus a full SHA and a post-retarget timestamp. Replace `prCommits.has(review.commit_id.toLowerCase())` with equality to `headSha.toLowerCase()`. Keep `prCommits.add(headSha)` only if still needed for the clean-pass path; otherwise drop the listCommits fetch if nothing else uses it.
- KTD2. Tighten the clean-pass summary the same way. (session-settled: user-directed — chosen over leaving a summary-on-old-SHA hole: "ONLY on … CURRENT head SHA" would still be bypassed)
  In the summary-table loop, require `sha === headSha.toLowerCase()` (and still not in `dismissedShas`). Update the header comments that currently say "one of the PR's commits".
- KTD3. Do not restyle waiver logic. (session-settled: user-directed — chosen over also rebinding waivers: F2 is review evidence, and R5 forbids label and waiver-semantic edits)
- KTD4. Prefer extending `tests/review-gate-waiver.test.ts` (or a sibling that reuses `gateScript` / `world`). (session-settled: user-directed — chosen over a from-scratch harness: the file already runs the real Evaluate script against an in-memory GitHub)
  Flip the current "earlier commit passes after later pushes" case to expect failure. Flip the clean-pass-on-P1 success case to expect `Waiting for Codex review`. Update `tests/workflow-security-policy.test.ts` string assertions that pin "any commit" / `prCommits.has(sha)`.
- KTD5. Hard-code the four `runs-on` lines and literal `persist-credentials: false` on the publish checkout. (session-settled: user-directed — chosen over environments or keeping the dry-run expression: F3 names those two edits)
  Do not change `GH_TOKEN` on the publisher step. Update the header comment that still advertises `MAINTAINER_RUNNER` only enough that it does not lie.
- KTD6. Put the Daily Repair assertions in a new test (or a new describe in `tests/workflow-security-policy.test.ts`) that reads the YAML text. (session-settled: user-directed — chosen over relying on live Actions: the user asked for a parse-the-YAML test)
  Reuse the existing line-based `jobBlocks` / `nestedBlock` helpers if the test lives in that file. Assert every job's `runs-on` is the literal `ubuntu-latest` and that `vars.MAINTAINER_RUNNER` is absent from the file. Locate the checkout step that contains `secrets.REPAIR_TOKEN` and assert `persist-credentials: false` in that step, not merely somewhere in the workflow (plan job already has false).
- KTD7. `git mv` the two backups to `archive/workflows-bak/`. (session-settled: user-directed — chosen over delete or `docs/archive`)
  Create the directory if needed. Do not enable, disable, or rename live workflows.

### Assumptions

- A1. Clean-pass comments are review evidence and must follow the same head-SHA rule as reviews (inferred from "ONLY … CURRENT head SHA"; user tests named reviews only).
- A2. Leaving Daily Review's `MAINTAINER_RUNNER` fallback alone is correct (not in scope).
- A3. `persist-credentials: false` plus existing `GH_TOKEN: secrets.REPAIR_TOKEN` is the required hardening even if `git push` later needs a follow-up. Daily Repair is inert today (token unset).
- A4. Archiving `.bak` files does not change `workflowFiles` discovery, which already filters to `.yml` / `.yaml`.

### Implementation Constraints

- No version, tag, release, or `package.json` version edit.
- No workflow enable/disable, trigger, permission, or secret changes except persist-credentials on the REPAIR_TOKEN checkout.
- One PR, ready, body lists each finding and the fix.
- Style: no semicolons, single quotes, existing vitest patterns.

### Sequencing

U1 failing tests, then U2 gate fix, then U3 failing YAML test, then U4 Daily Repair edits, then U5 archive. Tests stay red until their unit lands.

## Implementation Units

### U1. Review-gate head-SHA failing tests

Goal: Pin F2 before changing the evaluator.

Requirements: R1, R2, R3, R4. Approach cites KTD4.

Files: `tests/review-gate-waiver.test.ts`; `tests/workflow-security-policy.test.ts` only if a sibling is not used.

Approach: Extend the existing in-memory GitHub harness. Keep waiver describes untouched. Add or rewrite cases so an old-commit review fails, a dismissed review on H fails, and a non-dismissed review on H passes. Align the clean-pass-on-P1 case with R4. Execution note: land these assertions first and confirm they fail on current `81fadb0` behavior (the any-commit success case at the "earlier commit passes" test).

Test scenarios:
- Old commit: `prCommits: [P1, H]`, review `commit_id: P1`, waived false → published title `Waiting for Codex review`, conclusion `failure`.
- Dismissed head: review on H with `state: 'DISMISSED'` → `Waiting for Codex review`.
- Head pass: review on H, `COMMENTED` or `APPROVED`, after retarget bound, no unresolved Codex threads → conclusion `success`, title `Codex reviewed PR`.
- Clean-pass old SHA: summary table attests P1, head is H → `Waiting for Codex review`.
- Waiver regression: existing live-base waiver cases still expect the same titles.

Verification: `npx vitest run tests/review-gate-waiver.test.ts` fails on the new old-commit assertion until U2.

Dependencies: none.

### U2. Review-gate evaluator head-SHA bind

Goal: The extracted script implements R1–R4.

Requirements: R1–R5. Approach cites KTD1, KTD2, KTD3.

Files: `.github/workflows/review-gate.yml`; comments at the file head and above `codexReviews`; `tests/workflow-security-policy.test.ts`.

Approach: In `evaluate`, accept a Codex review only when `commit_id` equals `headSha`. Accept a clean-pass summary only when the attested SHA equals `headSha` and is not dismissed. Do not change waiver, draft, usage-limit, thread, or binding paths. Update comments that claim any-commit / no second pass. Update `tests/workflow-security-policy.test.ts` F13 string pins that would break (`prCommits.has(sha)`, "any commit").

Test scenarios: U1 cases now pass. Foreign-commit, retarget, unresolved-thread, GraphQL-fail, and waiver cases stay as they are.

Verification: `npx vitest run tests/review-gate-waiver.test.ts tests/workflow-security-policy.test.ts`.

Dependencies: U1.

### U3. Daily Repair YAML failing test

Goal: Pin F3 before editing the workflow.

Requirements: R6, R7. Approach cites KTD6.

Files: `tests/daily-repair-runner-policy.test.ts` (new) or a new describe in `tests/workflow-security-policy.test.ts`.

Approach: Read `.github/workflows/daily-repair.yml` as text. Parse jobs. Assert four `runs-on` values are exactly `ubuntu-latest` and the file has no `MAINTAINER_RUNNER`. Find the checkout `with:` block that contains `secrets.REPAIR_TOKEN` and assert it contains `persist-credentials: false` and does not contain the dry-run expression. Execution note: confirm this test fails on current main.

Test scenarios:
- `preflight`, `plan`, `publish`, `audit` each have `runs-on: ubuntu-latest`.
- `vars.MAINTAINER_RUNNER` does not appear.
- The REPAIR_TOKEN checkout step includes `persist-credentials: false`.

Verification: the new test fails until U4.

Dependencies: none (parallel with U1).

### U4. Daily Repair runner and persist-credentials

Goal: Implement F3.

Requirements: R6, R7. Approach cites KTD5.

Files: `.github/workflows/daily-repair.yml`.

Approach: Replace the four `runs-on: ${{ vars.MAINTAINER_RUNNER || 'ubuntu-latest' }}` lines with `runs-on: ubuntu-latest`. On the checkout named for REPAIR_TOKEN, set `persist-credentials: false`. Leave `token: ${{ secrets.REPAIR_TOKEN }}`, `GH_TOKEN`, triggers, permissions, and job structure alone. Trim the header runner comment so it no longer documents a self-hosted override.

Test scenarios: U3 now passes. Existing `tests/daily-repair-publisher.test.ts` still pass (publisher script unchanged).

Verification: `npx vitest run tests/daily-repair-runner-policy.test.ts tests/daily-repair-publisher.test.ts tests/workflow-security-policy.test.ts`.

Dependencies: U3.

### U5. Archive stray workflow backups

Goal: Implement F4 without deleting history.

Requirements: R8. Approach cites KTD7.

Files: `.github/workflows/daily-repair.yml.bak` → `archive/workflows-bak/daily-repair.yml.bak`; `.github/workflows/daily-review.yml.bak` → `archive/workflows-bak/daily-review.yml.bak`.

Approach: `mkdir -p archive/workflows-bak && git mv` both files. Do not delete. Do not touch live `daily-repair.yml` or `daily-review.yml` except U4. No workflow enable/disable.

Test scenarios: `git ls-files '.github/workflows/*.bak'` is empty; both paths exist under `archive/workflows-bak/`. Existing workflow discovery still lists the five live yml files and not `.bak`.

Verification: `npx vitest run tests/workflow-security-policy.test.ts` (already asserts no `.bak` among `*.yml`).

Dependencies: none (parallel after U4 to avoid checkout noise).

## Verification Contract

Repo commands from `AGENTS.md`:

- `npx vitest run tests/review-gate-waiver.test.ts tests/workflow-security-policy.test.ts tests/daily-repair-publisher.test.ts` plus the new Daily Repair YAML test
- `npm test` (full suite; existing tests must still pass)
- `npm run build` and `npm run typecheck` (tsc, 0 errors)
- `npm run lint` and `npm run security` if time after the targeted suite is green

Do not run `npm run smoke:clean-install` (no package or release change). Do not publish. Do not use live funds.

CI watch: one wait or one subscription after the PR exists. Two-failure stop on the same problem: mark the PR draft and report.

## Definition of Done

Global:
- U1–U5 landed on `cloud/so-findings-2-3-4-9377` from `origin/main` @ `81fadb0`.
- Targeted tests and `npm test` / `npm run build` / `npm run typecheck` pass locally.
- One ready PR against `main` whose body lists F2, F3, F4 and the fix for each.
- No `package.json` version edit, no comments on #90/#91, no `codex-waived` mutation, no push to main.
- Abandoned-attempt code is not in the diff.

Per unit:
- U1: new/rewritten cases fail on pre-U2 tree, then pass after U2.
- U2: extracted script matches head SHA only; waiver tests unchanged in intent.
- U3: YAML test fails on pre-U4 tree, then passes after U4.
- U4: four literal `ubuntu-latest` runners; REPAIR_TOKEN checkout persist-credentials false.
- U5: both `.bak` files exist only under `archive/workflows-bak/`.

## Appendix

### Trace (single-pass)

`evaluate(prNumber)` in `.github/workflows/review-gate.yml` loads reviews via `pulls.listReviews`, builds `prCommits` from `pulls.listCommits`, and treats a Codex review as evidence when the commit is in that set. Clean-pass comments parse a 40-hex SHA from the Codex summary table and accept any SHA in `prCommits` that is not dismissed. Waivers are a separate path bound to `{pr, head, live base tip, label event}` and are not part of F2. Drafts fail closed. Unresolved Codex threads fail a review that otherwise counts.

Daily Repair jobs `preflight` (L67), `plan` (L230), `publish` (L334), `audit` (L597) all use `vars.MAINTAINER_RUNNER || ubuntu-latest`. Plan checkout already has `persist-credentials: false`. Publish checkout (L341-347) sets `token: secrets.REPAIR_TOKEN` and `persist-credentials: ${{ !(inputs.dry_run == true) }}` (true on live runs). The publisher then `git push origin` using checkout credentials and `gh pr create` using `GH_TOKEN`.

### Bake-off

Not run. The HOW is user-settled; no structurally distinct mechanism remained.

### External research

Skipped. Approach and file list were given; local tests already execute the real scripts.
