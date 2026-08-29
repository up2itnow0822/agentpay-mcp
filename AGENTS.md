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

## Work Guidance

- Make payment-safety and compatibility changes in reviewable slices.
- Keep public claims traceable to code, tests, or independent evidence.
- Keep daily review and repair automation separate from product CI health.

## Verification

- Run `npm run build`, `npm run typecheck`, and `npm test`.
- Run `npm run lint` and `npm run security`.
- Run `npm run smoke:clean-install` for package or release changes.

## Child DOX Index

- No closer child contracts are currently defined.
