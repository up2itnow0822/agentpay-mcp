# Payment-critical dependency pin policy

AgentPay MCP treats crypto verifier and signing dependencies as payment-critical infrastructure. A floating semver range is not acceptable when a fresh install can change the code path that parses a 402 challenge, derives an account, signs a payment, verifies a receipt, or maps a chain.

## Current pin

- `viem`: pinned exactly to `2.48.7`
- `package.json` dependency: `"viem": "2.48.7"`
- root npm override: `"viem": "2.48.7"`
- reason: `viem` `2.48.8` exposed a broken `@noble/curves` import path in the x402 payment ecosystem. AgentScore Pay rc.14 pinned `viem` `2.48.7`; AgentPay MCP follows the same buyer-safety posture and proves clean installs before release.

## Libraries covered by this policy

Pin exactly, or document an explicit hard override, for any package that touches:

- wallet/account derivation
- signature creation or verification
- x402 payment-required parsing
- receipt, transaction, or payment envelope validation
- chain metadata used to decide whether a payment can be signed
- crypto hash, curve, address, or ABI encoding paths

Today that includes `viem` and its crypto import surface. If AgentPay adds a direct dependency on `@noble/*`, `@scure/*`, `ox`, an x402 SDK package, or a facilitator client, that dependency must be reviewed under this policy before release.

## Release gate

Before publishing a package that changes x402 payment paths or crypto dependencies, run:

```bash
npm run build
npm run smoke:clean-install
```

The clean-install smoke creates a fresh temporary consumer project, installs the packed AgentPay MCP tarball, imports `viem`, `viem/accounts`, `viem/chains`, AgentPay's packaged `x402_pay` tool, and AgentPay's wallet client utility, then confirms the resolved `viem` version is exactly `2.48.7`.

A release must fail if:

- the root package uses `^`, `~`, `>=`, `latest`, or any non-exact range for `viem`
- the root override does not match the dependency pin
- a clean install resolves the x402 verifier path to a different `viem` version
- packaged AgentPay x402 imports fail in a fresh consumer project
- a payment path silently falls back to an unsupported chain or parser

## Upgrade process

1. Open a dependency-pin issue or PR explaining the market or security signal.
2. Change the exact dependency and override together.
3. Refresh `package-lock.json`.
4. Run typecheck, tests, build, pack dry-run, and clean-install smoke.
5. Preserve proof under `ops/proofs/` before publishing.
6. Publish only after the proof shows the same exact dependency version in a clean consumer install.

Do not relax this policy for convenience. Payment libraries can break buyer agents without changing AgentPay source code, so deterministic installs are part of the product contract.
