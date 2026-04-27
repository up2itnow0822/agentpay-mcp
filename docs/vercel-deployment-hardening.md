# Vercel deployment hardening for AgentPay MCP

Vercel's April 2026 security bulletin changed the threat model for agent teams. The incident started through a compromised third-party AI tool OAuth grant, then moved into Google Workspace and Vercel systems. Vercel reported that a limited set of non-sensitive environment variables were enumerated and decrypted, and it told affected customers to rotate readable env vars, review activity and deployments, and move secrets into sensitive environment variables.

AgentPay MCP should be deployed as if the host can leak readable configuration. Keep payment authority isolated, make every paid tool fail closed, and treat OAuth app grants as production access.

## 10-minute incident response checklist

Use this first if you deployed AgentPay MCP or any x402-capable agent on Vercel before April 24, 2026.

1. Rotate every readable Vercel environment variable that can reach money, data, or infrastructure. Include `AGENT_PRIVATE_KEY`, `AGENT_WALLET_ADDRESS`, `RPC_URL`, model provider keys, database URLs, OAuth client secrets, webhook secrets, and any internal API tokens.
2. Move secrets into Vercel sensitive environment variables. Anything that signs, pays, authenticates, deploys, or reads private data should not be readable from the dashboard or API after creation.
3. Audit Google Workspace OAuth grants for AI tools. Remove any app you don't recognize or can't tie to an owner. Vercel published the OAuth app ID `110671459871-30f1spbu0hptbs60cb4vsmv79i7bbvqj.apps.googleusercontent.com` as an indicator of compromise.
4. Review Vercel activity logs for environment variable reads, token changes, project setting changes, team membership changes, and unusual API access.
5. Review recent deployments. Delete deployments you didn't initiate, don't recognize, or can't explain from a linked commit and CI run.
6. Rotate Deployment Protection bypass tokens if they exist. Treat them like exposed credentials.
7. Verify Deployment Protection is at least Standard for every production project.
8. Re-deploy from a known clean commit after rotation. Don't trust a deployment that was built with stale credentials.
9. Re-run AgentPay MCP approval validation before reconnecting agents to paid tools.
10. Keep the old credentials disabled. Don't keep them as fallback values in preview or development projects.

## Vercel environment variable policy

Classify AgentPay MCP configuration by blast radius:

| Variable | Classification | Vercel setting | Rotation trigger |
| --- | --- | --- | --- |
| `AGENT_PRIVATE_KEY` | x402 signing key | Sensitive env var only | Any host, OAuth, CI, or dashboard compromise |
| `AGENT_WALLET_ADDRESS` | Public identifier | Readable allowed | Wallet migration or key rotation |
| `RPC_URL` with provider key | Paid infrastructure credential | Sensitive env var only | Any provider, Vercel, or CI exposure |
| `AGENTPAY_MCP_TOKEN` | MCP transport auth | Sensitive env var only | Any agent, app, or host compromise |
| Model provider API keys | Paid tool and data access | Sensitive env var only | Any env var read or OAuth compromise |
| Database URLs | Production data access | Sensitive env var only | Any env var read, deployment anomaly, or DB alert |

Rules:

- Don't store owner keys in Vercel. AgentPay MCP should use an agent hot wallet with on-chain spend limits, not the owner's treasury key.
- Don't put signing keys in client-side env vars. In Vercel, avoid any `NEXT_PUBLIC_` prefix for payment, API, OAuth, or database secrets.
- Don't copy production secrets into preview projects unless the preview deployment is protected and tied to the same incident response process.
- Use separate keys for development, preview, and production. A preview leak shouldn't become a production payment incident.

## x402 signing key isolation

AgentPay MCP is safest when the Vercel app does not hold unrestricted signing authority.

Recommended pattern:

1. Deploy AgentPay MCP as a separate service behind HTTPS with an auth token or mTLS-equivalent gateway.
2. Give the Vercel AI app only an `AGENTPAY_MCP_TOKEN` and MCP endpoint URL.
3. Keep `AGENT_PRIVATE_KEY` in the AgentPay MCP service, a KMS, or an HSM-backed signer. If it must run on Vercel, mark it as a sensitive environment variable and bind it to the smallest possible project scope.
4. Use an agent hot wallet with on-chain spend caps, recipient allowlists, and daily limits.
5. Keep owner or treasury keys outside the Vercel runtime entirely.
6. Log every signing attempt with `agent_id`, `task_id`, `tool_call_id`, amount, recipient, policy version, approval ID, and x402 receipt ID.

The invariant is simple: a leaked model key can burn credits; a leaked signing key can move funds. Treat them differently.

## Fail-closed paid tools with Vercel AI SDK approvals

The Vercel AI SDK approval flow is the correct place to stop paid tools before x402 signing. Use `needsApproval: true` or a dynamic `needsApproval` function for any tool that can spend money, change billing state, or call a paid API.

AgentPay MCP v4.1.3 already documents the native AI SDK approval bridge. Preserve this signing rule in production:

- `tool-approval-response` with `approved: true`: allow policy checks, then signing
- denied response: block signing
- missing response: block signing
- approval engine error: block signing
- policy engine error: block signing
- amount, recipient, chain, or payment header mismatch: block signing

Never let a model retry a denied paid tool until a human creates a new approval. Add a system instruction such as: `When a tool execution is not approved, do not retry the same paid call.`

Run the validation example before deploy:

```bash
cd examples/vercel-ai-sdk-http-elicitation
npm install
npm run validate
```

The validation must show that decline, cancel, missing approval, and incomplete approval do not call the signing callback.

## Activity and deployment review

After a Vercel security event, review these records before turning agents back on:

- Vercel account activity log for env var reads, project changes, team changes, token changes, and unusual API access
- deployment list for unexpected deploys, build sources, commit SHAs, domains, and aliases
- GitHub repository audit log for OAuth app grants, webhooks, deploy keys, and branch protection edits
- Google Workspace connected apps and OAuth grants for AI tools
- npm publish history if the deployment consumes internal packages
- AgentPay MCP transaction history for unexpected x402 attempts, blocked approvals, and policy denials

If the app paid anything during the exposure window, reconcile the x402 receipt IDs against approval IDs and policy versions. Any payment without an approval record should be treated as an incident until disproven.

## Pre-deploy gate

Do not ship a Vercel-hosted agent with paid tools until all of these pass:

- every secret value is sensitive, scoped by environment, and rotated after any exposure
- owner keys are absent from Vercel
- agent signing key is isolated to AgentPay MCP or a dedicated signer
- Vercel Deployment Protection is enabled for production
- Google Workspace OAuth grants have an owner and a business reason
- activity logs and deployment logs were reviewed after the last rotation
- AI SDK paid tools require approval before execution
- AgentPay MCP validation proves x402 signing is blocked until approval
- spend caps, recipient allowlists, daily limits, and kill switches are active
- audit records join approval ID, tool call ID, policy version, and x402 receipt ID

## References

- Vercel April 2026 security incident bulletin: https://vercel.com/kb/bulletin/vercel-april-2026-security-incident
- Vercel sensitive environment variables: https://vercel.com/docs/environment-variables/sensitive-environment-variables
- Vercel activity logs: https://vercel.com/docs/cli/activity
- Vercel AI SDK tool execution approval: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling#tool-execution-approval
- AgentPay MCP Vercel AI SDK approval example: ../examples/vercel-ai-sdk-http-elicitation
