# Budget Governance Example (agentpay-mcp + aixyz)

This example shows how to layer **operator-controlled budget governance** on top of native x402 pricing.

## What this demonstrates

- Session cap enforcement (default: `$5`)
- Per-call payment cap (default: `$1`)
- Category caps:
  - `data`: `$3`
  - `compute`: `$2`
  - `infra`: `$1`
- Velocity cap (default: `100 payments/hour`)

## Files

- `budget-state.ts` — in-memory governance engine (replace with MCP-backed state in production)
- `tools/check-budget.ts` — tool that returns remaining budget and limits
- `tools/request-payment.ts` — tool that enforces governance before payment execution
- `agent.ts` — minimal runnable walkthrough of approved + denied payment flows
- `aixyz.config.ts` — example aixyz wiring for governance-aware tools

## Run

```bash
cd examples/budget-governance
npm install
npm run start
```

## Why this matters

x402 sets the **price** for a call; governance sets the **maximum spend policy** for the session.
They are complementary controls:

- x402 (developer-defined): “This tool costs $0.005.”
- governance (operator-defined): “This session can spend at most $5 total.”
