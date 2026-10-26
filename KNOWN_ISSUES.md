# Known Issues — ClawPay MCP

This file documents known issues that cannot be fixed without breaking
functionality or depend on upstream changes.

---

## 1. vitest Sourcemap Warning (Dev Only)

**Severity:** Low (development only, zero user impact) **Status:** Upstream
issue **Message:**
`Sourcemap for ".../agentwallet-sdk/dist/index.js" points to missing source files`

**Description:** When running tests, vitest emits a warning that
`agentwallet-sdk`'s dist bundle references sourcemap files that weren't included
in the npm package. This is a packaging oversight in `agentwallet-sdk`.

**Impact:** None on test correctness or production behavior. The full test suite
still passes.

**Fix:** Needs to be addressed in `agentwallet-sdk` by including sourcemap files
in the `files` array of its `package.json`. A PR/issue has been filed upstream.

**Workaround:** None needed. Ignore the warning — it's purely cosmetic.

---

## 2. Dual viem Version (Pinned as Mitigation)

**Severity:** None (mitigated) **Status:** Resolved via `overrides`

**Description:** `agentwallet-sdk` declares its own exact `viem` dependency
(`2.57.4` as of `agentwallet-sdk@7.0.0`). Without pinning, a future SDK
release could install a second viem instance and break TypeScript types on
the x402 verifier path.

**Mitigation:** `package.json` pins `viem` exactly and forces the same version
everywhere via a root override:

```json
"dependencies": { "viem": "2.57.4" },
"overrides": { "viem": "2.57.4" }
```

This forces a single viem installation (currently `2.57.4`, matching
`agentwallet-sdk@7.0.0`). The pinned version is governed by the
[payment-critical dependency pin policy](docs/dependency-pin-policy.md) and
verified by `tests/dependency-pin-policy.test.ts` and
`npm run smoke:clean-install`. The version in this file, `package.json`,
`docs/dependency-pin-policy.md`, and `scripts/clean-install-x402-smoke.mjs` must
all match.

**Action Required:** When `agentwallet-sdk` publishes a new minor/major version,
verify the `viem` version it uses still type-checks against the pinned override,
and bump the pin through the pin-policy upgrade process if needed.

---

## 3. x402 Protocol: EVM-Only Payment Support

**Severity:** Low (by design) **Status:** By design — not a bug

**Description:** The `x402_pay` and `x402_session_start` tools only pay on
the configured Base network (`base:8453` or `base-sepolia:84532`). x402
endpoints that offer only other networks are not paid: the call fails closed
with an "Unsupported x402 Payment Requirement" error and signs nothing.
`x402_quote` lists only offers on the configured network.

**Affected behavior:** If an x402 endpoint requires ETH-native payment (not
USDC), or payment on Ethereum Mainnet, the request will not be paid
automatically.

**Future fix:** Extend `X402ClientConfig.supportedNetworks` and
`supportedAssets` as the x402 ecosystem grows. The SDK is designed to support
this via config.

---

## 4. Residual risks after the October 2026 remediation (v5.0.0)

**Severity:** Accepted, documented **Status:** By design. See
[`docs/security-remediation-2026-10.md`](docs/security-remediation-2026-10.md).

- **Spend-intent state is process-local by default.** Locks on ambiguous
  payments and keyed settlements are lost on restart unless
  `AGENTPAY_STATE_DIR` is set. Operators running long-lived production
  servers should set it, and reconcile locks with
  `agentpay-mcp spend-intents list` / `resolve <key>` while the server is
  stopped.
- **Settled idempotency keys are never forgotten, so their number has a
  ceiling.** Each one is kept as a compact digest. After 1,048,576 settled
  keys, new spends that carry an `idempotencyKey` are refused (keyless spends
  still work); an old key is never forgotten to make room.
- **Application policy is defence in depth.** On-chain AgentAccountV2 limits
  remain the tamper-resistant control. The in-process policy can no longer be
  weakened by the agent, but it is lost on restart and is only as trustworthy
  as the server process and its environment.
- **The MCP stdio channel is the caller boundary.** Any process that can speak
  to the server can invoke its tools within the limits above.

---

Last updated: 2026-10-25

## 5. Daily repair automation ships disabled

`.github/workflows/daily-repair.yml` now uses the same privilege split as
`daily-review.yml`: the model runs in a read-only `plan` job and can only
produce an artifact; a deterministic `publish` job, the only holder of
`REPAIR_TOKEN`, validates it and opens PRs. Nothing is ever merged by
automation. It still ships off (`repair_enabled: false` in
`.github/repair-exclusions.yml`); turning it on is a maintainer decision.
Residual risk when enabled: repair PRs contain model-written code, so every
one needs a careful human review; CI runs that code with a read-only token
and no secrets. On a self-hosted runner, use ephemeral runners so the plan
job's workspace cannot persist into the publish job.
