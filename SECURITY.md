# Security Policy — agentpay-mcp

## Supported Versions

| Version | Supported |
|---------|-----------|
| 5.x     | ✅        |
| < 5.0   | ❌        |

Versions before 5.0.0 do not receive security fixes. They are affected by the
findings repaired in the October 2026 remediation below; upgrade to 5.x.

## Reporting a Vulnerability

Email security concerns to bill@ai-agent-economy.com with:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment

We aim to respond within 48 hours and patch critical issues within 7 days.

## Architecture: Why agentpay-mcp Mitigates CVE-2026-26118

### Background

CVE-2026-26118 (CVSS 8.8) is a server-side request forgery (SSRF) vulnerability in Azure MCP Server Tools, disclosed in Microsoft's March 2026 Patch Tuesday. The vulnerability allows attackers to send crafted inputs that exploit SSRF to steal managed identity tokens and escalate privileges. [Talos Intelligence](https://blog.talosintelligence.com/microsoft-patch-tuesday-march-2026/), [Tenable](https://www.tenable.com/blog/microsofts-march-2026-patch-tuesday-addresses-83-cves-cve-2026-21262-cve-2026-26127), and [TheHackerWire](https://www.thehackerwire.com/azure-mcp-server-ssrf-for-privilege-elevation-cve-2026-26118/) confirmed the vulnerability affects Azure MCP Server configurations that accept user-provided parameters without input validation.

### Why agentpay-mcp Is Not Affected

agentpay-mcp's architecture mitigates this class of vulnerability through three design choices:

1. **No managed identity dependency.** agentpay-mcp uses non-custodial wallet keys (ERC-6551 Token Bound Accounts), not cloud-managed identity tokens. There are no managed identity tokens to steal via SSRF because the system doesn't use them.

2. **Outbound destinations go through a safe transport.** Tool inputs are schema-validated, but a schema only checks that a URL is well formed; it cannot stop a caller from naming an internal host. Since 5.0.0, every outbound request to a caller-selected destination (`x402_pay`, `x402_quote`, the x402 session tools, and the OTel kill callback) goes through `src/utils/safe-fetch.ts`, which requires `https` (the kill callback also accepts `http`), refuses URLs with embedded credentials, refuses private, loopback, link-local, multicast and cloud-metadata destinations (including IPv4 addresses tunnelled in IPv6 forms), resolves DNS once and pins the socket to the validated answer (no DNS rebinding between check and connect), never follows redirects automatically, and caps response bodies at 2 MiB. Operators can permit specific private hosts with `AGENTPAY_ALLOWED_PRIVATE_HOSTS` (or `AGENTPAY_KILL_CALLBACK_ALLOWED_HOSTS` for the kill callback); `AGENTPAY_ALLOW_PRIVATE_NETWORK=1` relaxes the private-destination and `https` rules and is for development only. Versions before 5.0.0 did not have this transport and accepted any syntactically valid URL.

3. **Process isolation.** agentpay-mcp runs as a standalone MCP server process. It does not share memory, tokens, or credentials with other Azure services. Even if an attacker could craft a malicious input, the blast radius is limited to the agentpay-mcp process — which holds only the agent's non-custodial wallet key, not cloud infrastructure credentials.

### Enterprise MCP Security Recommendations

For organizations deploying MCP servers (including agentpay-mcp) in production:

- **Apply Microsoft's March 2026 patches** if running any Azure MCP Server Tools
- **Enforce MCP tool allowlists** — only expose the tools your agents actually need
- **Run MCP servers in isolated containers** — limit network access to required endpoints only
- **Audit MCP tool inputs** — log all tool invocations for security review
- **Use non-custodial wallet architectures** — avoid storing cloud credentials or managed identity tokens in MCP server processes

See our [enterprise MCP hardening guide](https://ai-agent-economy.hashnode.dev/enterprise-mcp-security-hardening-guide-march-2026) for detailed deployment recommendations.

## Dependency Security

As of 2026-10-25 (v5.0.0), `npm audit --omit=dev` and `npm audit` both report
0 vulnerabilities. Payment-critical packages are pinned under
[`docs/dependency-pin-policy.md`](docs/dependency-pin-policy.md). The earlier
`elliptic` / `@elizaos/core` advisory chain is no longer in the dependency tree.

## October 2026 remediation

v5.0.0 repairs all 18 findings (4 high, 13 medium, 1 low) of the October 2026
whole-repository static security review. The release is breaking: x402 payments
require `max_payment_eth` and `pay_to`, spend policy is default-deny without an
operator policy, and `set_spend_policy` can only tighten.
[`docs/security-remediation-2026-10.md`](docs/security-remediation-2026-10.md)
maps each finding to its repair and the test that proves it, and lists the
accepted residual risks.
