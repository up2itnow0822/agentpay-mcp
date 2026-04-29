# x402 Ecosystem Submission Notes

This document tracks the public ecosystem listing request for `agentpay-mcp` in the x402 Foundation website repository.

- **Upstream PR:** `x402-foundation/x402` PR #1562
- **Title:** `feat(ecosystem): add agentpay-mcp to client-side integrations`
- **Proposed category:** Client-Side Integrations
- **Package:** [`agentpay-mcp` on npm](https://www.npmjs.com/package/agentpay-mcp)

## Why this integration matters

`agentpay-mcp` is focused on the payer/client side of x402 workflows. It allows autonomous agents to detect `402 Payment Required` responses, execute the payment flow, and retry requests with policy controls.

## Merge blockers called out in the upstream PR

At the time these notes were captured, the upstream PR reported:

1. missing required reviewer approval from a maintainer with write access;
2. unsigned or unverified commit signature requirement not yet satisfied; and
3. a Vercel authorization gate for deployment preview.

These blockers are in the upstream repository and are not controlled by this repository's CI.
