# Dynamic paid MCP manifest drift proof

Paid MCP discovery metadata is no longer a static launch note. On May 4, Rug Munch changed its live `.well-known/x402` surface during launch night: the advertised MCP tool count moved to 184, the service count remained 28, the explicit trial policy changed to no free trials, and directory/framework endpoints remained live.

AgentPay treats that as a buyer-safety requirement. A buyer agent should refresh the live manifest before routing paid work, then validate the fields that can affect payment decisions.

## What buyers must validate before signing

- Snapshot age: the `.well-known/x402` snapshot must be recent enough for routing. AgentPay uses a 24 hour default stale threshold.
- Tool and service counts: `mcp.totalTools` and `mcp.totalServices` can change without a package version bump. Do not hardcode launch-night counts.
- Trial policy: `trial.enabled` and `trial.description` are the source of truth. If a capability string still says `free_trial` while the explicit policy says no trials, treat that as drift and refresh the directory card.
- Pricing fields: each paid endpoint should expose `price` and `priceAtomic`; no-trial services need pricing clarity before buyer automation pays.
- Supported networks: network descriptors must be explicit and include gateway URLs. Multi-network manifests cannot leak Base-only assumptions into Solana or future non-EVM rails.
- Directory endpoints: `.well-known/x402`, MCP catalog, OpenAPI, docs, and framework endpoint URLs should be HTTPS and refreshed together.

## AgentPay proof artifacts

- TypeScript validator: `src/utils/x402-dynamic-paid-mcp-manifest-drift.ts`
- JSON Schema: `docs/x402-dynamic-paid-mcp-manifest-drift.schema.json`
- Latest Rug Munch fixture: `docs/fixtures/dynamic-paid-mcp-manifest-rugmunch-2026-05-04.json`
- Baseline Rug Munch fixture: `docs/fixtures/dynamic-paid-mcp-manifest-rugmunch-2026-05-04-baseline.json`
- Tests: `tests/x402-dynamic-paid-mcp-manifest-drift.test.ts` and `tests/x402-dynamic-paid-mcp-manifest-drift-docs.test.ts`

## Current Rug Munch drift captured

The latest fixture captures commit `ab67483adb2585e475b5e2bcf37389a739e2ad97` and live `https://x402-sol.cryptorugmuncher.workers.dev/.well-known/x402` metadata:

- `mcp.totalTools`: 184
- `mcp.totalServices`: 28
- `trial.enabled`: false
- `trial.description`: `No free trials - pay per call from $0.01 USDC`
- `supportedNetworks`: Base mainnet and Solana mainnet
- `facilitator`: PayAI facilitator URL present
- `pricing`: 30 HTTP endpoints with `price` and `priceAtomic` fields in the sampled manifest
- `directories`: `.well-known/x402`, OpenAPI, docs, MCP catalog, and OpenAI, Anthropic, Gemini, LangChain, and MCP framework endpoints

The baseline fixture records the earlier launch-night position of 175 tools and one trial call. The drift test proves buyer code notices that tool count and trial policy changed instead of assuming static discovery metadata.

## AgentPay routing rule

AgentPay MCP should sign only after the buyer has a fresh manifest snapshot, a local spend policy approval, supported-network validation, pricing clarity, and an audit row tying the payment to the exact manifest snapshot. If any of those fields are missing or stale, routing fails closed.
