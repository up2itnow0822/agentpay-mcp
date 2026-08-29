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
(`2.46.0` as of `agentwallet-sdk@6.2.1`). Without pinning, npm would install two
incompatible viem instances causing TypeScript type errors.

**Mitigation:** `package.json` pins `viem` exactly and forces the same version
everywhere via a root override:

```json
"dependencies": { "viem": "2.56.0" },
"overrides": { "viem": "2.56.0" }
```

This forces a single viem installation (currently `2.56.0`, overriding
`agentwallet-sdk`'s `2.46.0`). The pinned version is governed by the
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

**Description:** The `x402_pay` tool only supports payment via USDC on Base
network (`base:8453` and `base-sepolia:84532`). x402 endpoints that require
payment on other networks or in other tokens will not be paid and will return
the 402 response unchanged.

**Affected behavior:** If an x402 endpoint requires ETH-native payment (not
USDC), or payment on Ethereum Mainnet, the request will not be paid
automatically.

**Future fix:** Extend `X402ClientConfig.supportedNetworks` and
`supportedAssets` as the x402 ecosystem grows. The SDK is designed to support
this via config.

---

Last updated: 2026-08-29
