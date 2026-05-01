# x402 chain-drift compatibility note and test plan

x402 paywall templates are moving faster than static client examples. The risk is simple: a paid-agent demo assumes yesterday's chain list, then a PaymentWrapper or paywall update emits payment metadata for a chain the client does not recognize.

AgentPay MCP must not silently coerce unknown x402 chains to Base. The package now depends on `viem` `^2.47.12`, matching or exceeding the x402 Foundation paywall-template baseline that added Mezo, MegaETH, Stable, and Radius chain definitions.

## Current boundary

AgentPay MCP `4.1.4` supports Base Mainnet and Base Sepolia for the core configured wallet client. Other tools in the repo support broader token, bridge, and swap surfaces, but x402 payment execution should treat unsupported chains as a fail-closed condition until the chain is explicitly mapped, tested, and funded.

This is safer than guessing. A failed payment is recoverable. A wrong-chain signature is not.

## Chains to watch

Track x402 Foundation paywall and PaymentWrapper changes for these chain definitions:

- Mezo
- MegaETH
- Stable
- Radius
- Any new `viem/chains` entry that appears in x402 paywall templates before AgentPay MCP docs or tests mention it

## Compatibility requirements

- Parse the chain or network value from x402 payment metadata without assuming Base.
- Match known networks to explicit AgentPay MCP chain configuration.
- Reject unknown networks with a clear error that names the unsupported chain.
- Never fall back to `8453` when the server requested a different chain.
- Keep docs, tests, and package examples aligned with the current x402 Foundation template set.

## Test coverage

`tests/chain-drift.test.ts` is the current smoke gate. It verifies that the installed `viem/chains` baseline exposes Mezo, MegaETH, Stable, and Radius, then verifies that AgentPay MCP still rejects those chain IDs instead of routing them through Base.

Future fixture-driven tests for x402 payment metadata should use this shape:

```ts
const paymentRequirements = [
  { network: "base", chainId: 8453, shouldPay: true },
  { network: "base-sepolia", chainId: 84532, shouldPay: true },
  { network: "mezo", shouldPay: false },
  { network: "megaeth", shouldPay: false },
  { network: "stable", shouldPay: false },
  { network: "radius", shouldPay: false },
];
```

Expected results:

- `base` and `base-sepolia` route only when the configured wallet, token registry, RPC URL, and policy allow them.
- Mezo, MegaETH, Stable, and Radius return `Unsupported x402 network` until explicit support lands.
- The error includes the requested network and the configured network.
- Tests assert that the signing function is not called for unsupported networks.

## Release gate

Before any future AgentPay MCP release claiming new x402 chain support:

1. Update the chain map and explorer map.
2. Add payment metadata fixtures from the current x402 Foundation paywall templates.
3. Run unit tests for accept, deny, cancel, cap exceeded, and unknown chain paths.
4. Run `npm run typecheck`, `npm test`, `npm run build`, and `npm pack --dry-run`.
5. Update this document with the supported network set and validation date.
