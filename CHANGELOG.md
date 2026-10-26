# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [5.0.0] - 2026-10-25

Security release. Repairs all 18 findings (4 high, 13 medium, 1 low) of the
October 2026 whole-repository static security review. Finding numbers below
(F1–F18) refer to
[`docs/security-remediation-2026-10.md`](docs/security-remediation-2026-10.md),
which maps each finding to its repair and proving test.

### Breaking
- `x402_pay` and `x402_session_start` require `max_payment_eth` and `pay_to`.
  The asset is always bound (default: the chain's USDC; override with
  `asset`); `network` can be bound. The cap covers principal plus the 0.77%
  protocol fee. `AGENTPAY_X402_MAX_PAYMENT` is USDC-denominated. A 402 naming
  another payee, asset or network, or above the cap, is refused before any
  wallet write (F3).
- `add_custom_token` verifies `decimals()` on-chain and registers only on the
  configured chain (F2).
- Spend policy is default-deny. Value movement requires an operator policy
  (`AGENTPAY_POLICY_*`) or an explicit `AGENTPAY_ALLOW_UNPOLICED_SPEND=1` (F11).
- `set_spend_policy` can only tighten. Requests that raise a limit, drop a
  constraint, or widen an allowlist are refused; earlier layers keep their
  accounting; the `operator` scope is reserved (F11).
- Outbound requests require `https` and refuse private, loopback, link-local
  and metadata destinations; redirects are not followed automatically
  (F9, F15).
- `send_payment` `token_decimals` is an assertion, not an override; a mismatch
  is refused (F2).
- `list_chain_tokens` is paginated; `add_custom_token` accepts only supported
  chains and bounded input (F18).

### Security
- F1: `x402_session_start` is serialised per canonical host; a payment that
  settles without a delivered response (including a paid request answered
  with any non-2xx status) locks every new x402 payment to that host — any
  path, port or host alias — and to that payee behind any host, until an
  operator reconciles it. The lock scope is journaled on the intent's begin
  record, before the wallet call.
- F2: Token decimals come from the registry, native ETH, or on-chain
  `decimals()`.
- F3, F5: Mandatory cap and approved terms checked against the SDK-selected
  requirement; the zero address is refused as payee and as `pay_to`.
- F4: Value-pack examples use exact 6-decimal USDC caps (principal plus the
  0.77% protocol fee) and a single-use approval record bound to the final
  offer; a paid body that fails mid-read is a payment-aware error; every
  request (probe, paid retry, free fetch) uses the server's safe transport;
  mainnet requires an explicit opt-in.
- F6, F13, F17: Workflow actions pinned to full commit SHAs; review-gate
  passes once Codex has reviewed the PR (any commit, after the last retarget)
  and every Codex review thread is resolved — no second Codex pass is required
  after pushes; `codex-waived` waivers are bound to the exact head and the live
  base tip; the daily-review analysis job is
  read-only and a deterministic job owns the single issue write, validating
  every schema field including optional metrics. Daily repair uses the same
  split: the model plans with a read-only token, a deterministic publisher
  (the only holder of `REPAIR_TOKEN`) validates its patch and opens PRs, and
  nothing is ever merged by automation. Every workflow declares
  `permissions`; CI that runs PR code is `contents: read` with no persisted
  credential.
- F7: Identity tools return a typed summary plus one nonce-fenced untrusted
  block.
- F8, F15: New safe transport (`src/utils/safe-fetch.ts`) for every
  caller-selected destination: DNS resolved once and pinned, `Host` and TLS
  SNI derived only from the validated URL (caller authority and framing
  headers are dropped), response bodies capped at 2 MiB (decoded), 1 MiB
  rendered.
- F9, F10: OTel kill callback uses the pinned transport; OTel identifiers,
  policies, ledgers, decisions and span dedupe are bounded; a span refused at
  capacity is not remembered as counted, so its replay is refused too.
- F12: Spend classification uses `AsyncLocalStorage` on a once-hooked wallet
  client, so concurrent spends cannot be misattributed.
- F14: Unresolved spend-intent locks are never evicted; new spends are refused
  at capacity; settled idempotency keys are never forgotten (compact digests;
  new keyed spends are refused at a ceiling instead); the journal survives a
  torn final line and is compacted crash-safely to its live state, so it
  cannot grow without bound.
- x402 payments that share a host or payee run one at a time, so a second
  payment cannot settle while the first is still being delivered.
- review-gate fails closed when the repository activity feed (the only
  unforgeable base timestamp) is unavailable.
- F11: A malformed operator policy — including an allowlist variable that
  names no address, or any operator policy with no constraint — denies all
  spending and is reported at startup.
- F2, F18: `add_custom_token` registration is serialised (decide, on-chain
  `decimals()` check and write are atomic), so concurrent registrations
  cannot overwrite each other or overrun the quota.
- `create_escrow` runs under the same spend-intent contract (idempotency key,
  replay, lock on ambiguous broadcast); its keyless identity covers only
  on-chain terms, so rewording the off-chain `terms` cannot mint a second
  vault.
- Kill callbacks to public hosts require `https`; `http` is accepted only for
  operator-allowlisted hosts.
- The spend-intent journal fails closed: an fsync or read failure refuses value
  movement; admission counts in-flight intents against the lock ceiling.
- `send_token` releases its policy reservation on a definite pre-broadcast
  failure.
- F16: `send_payment` supports `idempotencyKey`, replays identical retries, and
  locks on an ambiguous broadcast.
- `npm audit --omit=dev` and `npm audit` report 0 vulnerabilities.

### Added
- `x402_quote` tool: reads an endpoint's x402 terms without paying (28 MCP
  tools in total).
- `agentpay-mcp spend-intents list | resolve <key>` operator CLI for
  reconciling locked spend intents. It is deliberately not an MCP tool.
- `server.json` declares every environment variable the server reads
  (previously `AGENT_WALLET_ADDRESS` was missing and `BASE_RPC_URL` was
  declared though the server reads `RPC_URL`).
- Environment variables: `AGENTPAY_POLICY_DAILY_LIMIT_ETH`,
  `AGENTPAY_POLICY_PER_TX_CAP_ETH`, `AGENTPAY_POLICY_ALLOWED_RECIPIENTS`,
  `AGENTPAY_ALLOW_UNPOLICED_SPEND`, `AGENTPAY_X402_MAX_PAYMENT`,
  `AGENTPAY_STATE_DIR` (fsync'd append-only spend-intent journal replayed at
  startup), `AGENTPAY_ALLOWED_PRIVATE_HOSTS`, `AGENTPAY_ALLOW_PRIVATE_NETWORK`
  (development only).

## [4.3.0] - 2026-10-23

Lifts the security-maintenance pause.

### Fixed
- Upgraded to agentwallet-sdk 7.0.0, which fixes the CCTP V2 attestation bug (#44 upstream) behind `bridge_usdc`, plus the x402 and escrow fund-safety fixes. The 4.2.2 known issue is resolved.
- fast-uri override 3.1.9 (moderate advisories); npm audit clean.
- A burn whose submission outcome is unknown (SDK `BURN_SUBMISSION_UNKNOWN`) is held as unknown, not released for retry.

## [4.2.2] - 2026-10-23

### Security
- @modelcontextprotocol/sdk 1.32.2, zod ^4.6.7, ip-address and body-parser overrides; npm audit clean.
- Control-character rejection re-applied before zod 4 URL normalization (would otherwise silently pass).

### Known issue
- The bridge tool depends on agentwallet-sdk's CCTP bridge, which has an open attestation bug (#44 upstream). Do not use the bridge tool until a fixed SDK is released.

## [4.2.0] — 2026-10-11

### Changed

- Bump `agentwallet-sdk` to **6.3.0** (outcomes API, SpendingPolicy
  `reserve` / `commit` / `release` / `lock` / `applyOutcome`, viem 2.57.4).
- Pin `viem` exactly to **2.57.4** (dependency + override) so the x402
  verifier path and the SDK share one install. The previous `2.56.0` pin
  and older `ws` trees are gone; `npm audit --audit-level=high` is clean.
- Adopt the SDK spend-outcome helpers (`classifySpendError`, `isEvmTxHash`)
  instead of a local hash regex and ad-hoc error taxonomy.
- Route in-process policy through SpendingPolicy `reserve` → `commit` |
  `release` | `lock` instead of `check()` plus a private spend-window pop.
- Store and compare spend-policy caps in 9-decimal ETH-equivalent units
  (1 whole token = 1e9). 18-decimal wei overflows `MAX_SAFE_INTEGER` for
  ordinary USDC sizes under SDK 6.3.0 `toSafeIntegerAmount`.
- Share one `createAgentPayX402Client` factory between `x402_pay` and
  `x402_session_start` (payTo/amount/cap guards + reservation lifecycle).
- Runtime MCP / CLI version strings continue to read `package.json` (the
  `--help` / `--version` path from [#25](https://github.com/up2itnow0822/agentpay-mcp/pull/25)).

### Fixed

- Confirmed on `main` before this release:
  - [#25](https://github.com/up2itnow0822/agentpay-mcp/pull/25) — `--help` /
    `--version` exit without starting the stdio server.
  - [#67](https://github.com/up2itnow0822/agentpay-mcp/pull/67) for
    [#44](https://github.com/up2itnow0822/agentpay-mcp/issues/44) — value-pack
    examples do not retry `fetchWithPayment` after settlement.
  - [#82](https://github.com/up2itnow0822/agentpay-mcp/pull/82) — persist
    `x402_pay` settlements in `get_transaction_history`.
- Lock unused spend reservations after ambiguous x402 failures that may
  already have broadcast; release only definite pre-broadcast outcomes.
  Release earlier multi-scope holds if a later `policy.reserve` throws.

---

## [4.0.0] — 2026-03-22

### Added

- **11 new MCP tools:**
  - `lookup_token` — look up token address and decimals by symbol + chain ID
  - `add_custom_token` — register custom ERC-20 tokens in the global token registry
  - `list_chain_tokens` — list all registered tokens for a given chain
  - `send_token` — send any ERC-20 token using symbol-based registry resolution
  - `get_balances` — fetch balances for multiple tokens on a chain
  - `swap_tokens` — token swaps via Uniswap V3 (Base, Arbitrum, Optimism, Polygon)
  - `bridge_usdc` — cross-chain USDC bridging via Circle CCTP V2
  - `set_spend_policy` — configure daily limits, per-tx caps, and recipient allowlists
  - `check_budget` — query on-chain remaining budget for a token/spender
  - `verify_agent_identity` — verify agent ERC-8004 on-chain identity
  - `get_reputation` — fetch agent reputation score and interaction history
  - `create_escrow` — create mutual-stake USDC escrow vaults
- Full **agentwallet-sdk v6.0.0** integration across all new tools
- **TokenRegistry** support — 100+ pre-loaded tokens, custom token registration at runtime
- **Multi-token transfers** — any ERC-20 or native gas token via `send_token`
- **Uniswap V3 swap support** via `SwapModule` (Base, Arbitrum, Optimism, Polygon)
- **CCTP V2 cross-chain USDC bridging** via `BridgeModule` (10 EVM chains)
- **Spending policy management** with in-process enforcement via `SpendingPolicy`
- **ERC-8004 agent identity verification** via `ERC8004Client`
- **Agent reputation scoring** via `ReputationClient`
- **Mutual stake escrow creation** via `MutualStakeEscrow`
- 42 new tests (149 total)
- 99.6% type coverage

### Changed

- Upgraded `agentwallet-sdk` dependency from v5.x to **v6.0.0**
- Version bump from 3.1.0 → 4.0.0

---

## [3.1.0] — 2026-03-15

### Added

- `queue_approval` tool — approve or cancel queued transactions that exceed per-tx cap
- `check_spend_limit` tool — check remaining allowance for a given token in the current period
- Budget forecast and wallet health endpoints via `getBudgetForecast` and `getWalletHealth`
- Utilization badge display (🟢 / 🟡 / 🔴) in `get_wallet_info` output
- Pending approvals management via `getPendingApprovals`, `approveTransaction`, `cancelTransaction`
- `get_transaction_history` event type filter: `policy_update`, `operator_update`

### Changed

- `get_wallet_info` now includes period utilization %, spend forecast, and queue depth
- Improved error messages with chain-specific explorer links

### Fixed

- Decimal precision handling for ERC-20 tokens with non-18 decimals in `send_payment`

---

## [1.1.0] — 2026-03-01

### Added

- **x402 V2 session payment support** — pay once, reuse token N times:
  - `x402_session_start` — establish a session by paying the endpoint once
  - `x402_session_fetch` — make calls within an active session (no new payment)
  - `x402_session_status` — inspect active sessions and TTL remaining
  - `x402_session_end` — explicitly close a session
- Session Manager (`src/session/manager.ts`) — in-memory session store with TTL enforcement
- Auto-session detection in `x402_pay` — injects session headers automatically if a valid session covers the URL
- `skip_session_check` parameter on `x402_pay` to force fresh payment
- Session scope options: `"prefix"` (covers all sub-paths) and `"exact"`

---

## [1.0.0] — 2026-02-15

### Added

- Initial release of AgentPay MCP Server
- Core MCP tools:
  - `deploy_wallet` — deploy a new AgentAccountV2 smart contract wallet via factory
  - `get_wallet_info` — retrieve wallet address, balance, and spend limit info
  - `send_payment` — send ETH or ERC-20 tokens via the AgentAccountV2 contract
  - `check_spend_limit` — check current period spend allowance
  - `queue_approval` — approve or cancel queued transactions
  - `x402_pay` — auto-pay x402 paywalled URLs
  - `get_transaction_history` — query on-chain event logs
- MCP stdio transport (compatible with Claude Desktop, Cursor, Windsurf)
- Non-custodial design — agent signs locally, owner controls limits via NFT ownership
- On-chain spend limits enforced by AgentAccountV2 contract
- Zod-validated input schemas for all tools
- TypeScript + viem + agentwallet-sdk foundation
- MIT License
