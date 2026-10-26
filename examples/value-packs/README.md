# AgentPay Drop-in Value Packs

**Copy. Run. Customize.**

Three fully working TypeScript scripts that show exactly how to build AI agents that pay for APIs using the [x402 protocol](https://x402.org). No stubs, no mocks for core logic — every function does what it says. Pick the pattern that fits your use case, run it, and swap in your own APIs.

---

## What's Included

| Pack | File | What it demos |
|------|------|---------------|
| **Paid API Agent** | `paid-api-agent.ts` | 402 detection → human approval → payment → cache |
| **Research Agent** | `research-agent.ts` | Free-first strategy, gap analysis, markdown report |
| **Automation Agent** | `automation-agent.ts` | Task planning, cost estimation, retry + fallback |

All three share utilities from `shared/`:
- `x402-client.ts` — 402 detection, approval-bound payment execution, retry logic
- `usdc-approval.ts` — exact USDC cap parsing, USDC/network allowlist, single-use approval records
- `spending-policy.ts` — daily cap, per-tx cap, approval threshold
- `cache.ts` — file-based TTL cache (avoid double-paying)
- `ui.ts` — colored console output, cost display, approval prompts

---

## Quick Start

### 1. Install dependencies

```bash
cd examples/value-packs
npm install
```

### 2. Set wallet credentials (for paid endpoints)

Free endpoints work without any credentials. For 402-gated paid endpoints you need an [AgentWallet](https://agentpay.dev):

```bash
export AGENT_PRIVATE_KEY=0xYOUR_AGENT_HOT_WALLET_KEY
export AGENT_WALLET_ADDRESS=0xYOUR_AGENT_ACCOUNT_ADDRESS
```

> **Testnet first:** The packs default to Base Sepolia so you can test without real money.
>
> **Base Mainnet moves real USDC** and needs two settings together. With only one of them, the packs refuse to start:
>
> ```bash
> export CHAIN_ID=8453
> export VALUE_PACK_ALLOW_MAINNET=1   # explicit, deliberate opt-in
> ```
>
> Any other `CHAIN_ID` value is rejected.

### 3. Run a pack

```bash
# Pack 1 — Paid API Agent
npm run paid-api

# Pack 2 — Research Agent
npm run research -- "AI payment protocols"
npm run research -- "x402 protocol" --no-paid   # free sources only

# Pack 3 — Automation Agent
npm run automation -- "get BTC price and sentiment analysis"
npm run automation -- "research AI payment protocols"
npm run automation -- "monitor crypto market overview"
```

Or run directly:
```bash
npx tsx paid-api-agent.ts
npx tsx research-agent.ts "AI payment protocols"
npx tsx automation-agent.ts "get BTC price and sentiment"
```

---

## Pack 1: Paid API Agent

**`paid-api-agent.ts`** — Fetches data from a mix of free and 402-gated endpoints. Shows the core x402 payment loop: detect → approve → pay → cache → retry.

### Example Output

```
══════════════════════════════════════════════════════════
  Paid API Agent — x402 Value Pack Demo
══════════════════════════════════════════════════════════

── Wallet Config ──
  Wallet key:         ✓ set (redacted)
  Wallet addr:        ✓ set
  Chain:              Base Sepolia (testnet)

── Spending Policy ──
  Daily cap:     $5.00
  Per-tx cap:    $1.00
  Approval gate: $0.50+
  Spent today:   $0.0000
  Remaining:     $5.0000

── Fetching Data ──
  Endpoints: 4 (3 free, 1 paid)

[1/4] BTC Price (CoinGecko)
  [FREE] Live crypto prices from CoinGecko (free tier)
  ✓ Got 3 data point(s)

[2/4] Weather (wttr.in)
  [FREE] Current weather data for Chicago
  ✓ Got 6 data point(s)

[3/4] GitHub Trending (API)
  [FREE] Trending AI agent repos on GitHub
  ✓ Got 1 data point(s)

[4/4] Market Data Pro (x402)
  Type:              💳 x402-gated (may require payment)
  Probing:           https://x402-demo.vercel.app/api/market-data

┌─ Payment Approval Required ────────────────────────────┐
│  Action:   x402 Payment
│  Details:  Premium crypto market data with sentiment
│  Endpoint: https://x402-demo.vercel.app/api/market-data
│  Cost: $0.0100 USD
└────────────────────────────────────────────────────────┘
  Approve? [y/N] y
  ✓ Approved — proceeding with payment.
  ✓ Data received — 5 field(s), cost: $0.0100

── Data Summary ──

  ✓ BTC Price (CoinGecko) [free]
      BTC: $95,432 (+2.31% 24h)
      ETH: $3,215 (+1.87% 24h)
      SOL: $178 (+4.12% 24h)

  ✓ Weather (wttr.in) [free]
      location: Chicago, IL
      temp_f: 52°F
      condition: Partly cloudy

  ✓ Market Data Pro (x402) [$0.0100]
      btc_price: 95432
      sentiment: bullish
      fear_greed: 68

── Cost Summary ──
  Free sources:       3 call(s)
  Paid sources:       1 call(s)
  Total spent:        $0.0100

  Budget: [██░░░░░░░░░░░░░░░░░░] $0.0100 / $5.00
```

### Key Patterns

```typescript
// SpendingPolicy with daily cap
const policy = new PolicyGuard({ dailyCapUsd: 5.0, approvalThresholdUsd: 0.50 });

// Cache check before any request (prevents double-paying)
const cached = cache.get<DataType>('my-endpoint-key');
if (cached) return cached; // No payment needed

// Human approval for paid requests
const approved = await requestApproval({ action, description, costUsd, endpoint });
if (!approved) return; // User said no

// Probe → bind → pay. The cap is an exact USD decimal string, never a float.
const info = await probeEndpoint(url);              // verified USDC offer or { payable: false }
const approval = approveProbedPayment(info!, '0.05'); // frozen, single-use; throws if offer > cap
const result = await fetchWithPayment(wallet, url, { approval });
cache.set('my-endpoint-key', result); // Cache after paying
```

---

## Pack 2: Research Agent

**`research-agent.ts`** — Builds a structured research report using a free-first strategy. Always tries free sources (Wikipedia, GitHub, HackerNews, npm) before estimating the cost of paid sources and asking for approval.

### Example Output

```
══════════════════════════════════════════════════════════
  Research Agent — "AI payment protocols"
══════════════════════════════════════════════════════════

── Phase 1: Free Sources ──
  Fetching background data — no payment required

[1/4] Fetching...
  [FREE] Wikipedia — background overview
  ✓ Wikipedia: AI payment protocols (312 words)

[2/4] Fetching...
  [FREE] GitHub — related open-source projects
  ✓ GitHub: found 5 related repositories

[3/4] Fetching...
  [FREE] HackerNews — community discussions
  ✓ HackerNews: 5 discussions found

[4/4] Fetching...
  [FREE] npm — related packages
  ✓ npm: 5 packages found

── Phase 2: Gap Analysis ──
  Found 1 gap(s) that paid sources can fill:

  [PAID $0.0100] Market Sentiment Analysis via x402 Premium Data API
    Reason: No quantitative sentiment data gathered from free sources

── Phase 3: Paid Sources — Budget Planning ──

┌─ Execution Plan ────────────────────────────────────────┐
│  1. Overview                              FREE
│  2. Related Open-Source Projects          FREE
│  3. Community Discussions                 FREE
│  4. Related npm Packages                  FREE
│  5. Market Sentiment Analysis             $0.0100
│
│  Total estimated cost: $0.0100
│  Daily cap: $5.00
└────────────────────────────────────────────────────────┘

  Execute this plan? [y/N] y

── Report Preview ──
  # Research Report: AI payment protocols
  > Generated by agentpay-value-packs on 2026-03-23T15:42:11Z
  ...

── Cost Summary ──
  Free sources:       4 call(s)
  Paid sources:       1 call(s)
  Total spent:        $0.0100

Report written to: ./reports/ai-payment-protocols-2026-03-23T15-42-11.md
```

### Key Patterns

```typescript
// Free-first: always exhaust free sources before asking to pay
const freeSections = await Promise.all([
  fetchWikipedia(topic),
  fetchGitHubProjects(topic),
  fetchHackerNewsDiscussions(topic),
]);

// Gap analysis: identify what free sources couldn't cover
const gaps = identifyGaps(freeSections, topic);

// Estimate total before asking
const totalCost = gaps.reduce((sum, g) => sum + g.estimatedCostUsd, 0);
const approved = await requestPlanApproval({ steps, totalCostUsd: totalCost, dailyCapUsd: 5 });

// Only spend if approved
if (approved) {
  for (const gap of gaps) {
    const section = await fetchPaidSentimentAnalysis(topic, wallet);
    // ...
  }
}
```

---

## Pack 3: Automation Agent

**`automation-agent.ts`** — Interprets a natural-language task, builds an execution plan, shows cost upfront, and executes step by step. Includes retry with exponential backoff, fallback to free alternatives, and clean Ctrl+C handling.

### Example Output

```
══════════════════════════════════════════════════════════
  Automation Agent — "get BTC price and sentiment analysis"
══════════════════════════════════════════════════════════

── Task Planning ──

  Task type: Market Analysis + Sentiment Analysis
  Steps: 4 planned

┌─ Execution Plan ────────────────────────────────────────┐
│  1. Connectivity Check                    FREE
│  2. Fetch Crypto Prices                   FREE
│  3. Market Sentiment Analysis (x402)      $0.0100
│  4. Aggregate Results                     FREE
│
│  Total estimated cost: $0.0100
│  Daily cap: $5.00
└────────────────────────────────────────────────────────┘

  Execute this plan? [y/N] y

── Executing Steps ──

[1/4] Connectivity Check 🆓 (free)
  ✓ Connectivity Check: done in 423ms

[2/4] Fetch Crypto Prices 🆓 (free)
  ✓ Fetch Crypto Prices: done in 891ms

[3/4] Market Sentiment Analysis (x402) 💳 (~$0.0100)
  ✓ Market Sentiment Analysis (x402): done in 1203ms ($0.0100)

[4/4] Aggregate Results 🆓 (free)
  ✓ Aggregate Results: done in 2ms

── Execution Results ──

  ✓ Connectivity Check (free)
    https://api.coingecko.com/...: OK

  ✓ Fetch Crypto Prices (free)
    BTC.price: 95432
    BTC.change_24h: 2.31
    ETH.price: 3215

  ⚡ Market Sentiment Analysis (x402) ($0.0100)
    sentiment: bullish
    fear_greed: 68
    label: Greed

  ✓ Aggregate Results (free)
    Completed 3 data collection step(s)

── Execution Log ──
  Step                           Status       Duration     Cost
  ─────────────────────────────────────────────────────────────────
  Connectivity Check             success      423ms        free
  Fetch Crypto Prices            success      891ms        free
  Market Sentiment Analysis...   success      1203ms       $0.0100
  Aggregate Results              success      2ms          free

── Cost Summary ──
  Free sources:       3 call(s)
  Paid sources:       1 call(s)
  Total spent:        $0.0100

── Summary ──
  Task:               get BTC price and sentiment analysis
  Steps completed:    4/4 (0 failed, 0 skipped)
  Total spent:        $0.0100
  Duration:           2.6s
```

### Key Patterns

```typescript
// Build plan from natural-language task
const plan = buildPlan(taskDescription, hasWallet);

// Budget guard — refuse before even asking user
if (estimatedTotal > MAX_COST_USD) {
  printError('Estimated cost exceeds cap — aborting');
  process.exit(1);
}

// Show plan, get approval
const approved = await requestPlanApproval({ steps: plan.steps, totalCostUsd, dailyCapUsd });

// Execute with retry + fallback. withRetry will not re-enter fetchWithPayment
// after payment has been initiated (a timeout after settlement is not a new buy)
// or after an approval rejection (approvals are single-use).
const approval = approveProbedPayment(probe, MARKET_SENTIMENT_CAP_USD); // '0.01'
const result = await withRetry(
  () => fetchWithPayment(wallet, url, { approval }),
  { maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 8000,
    onRetry: (attempt, err) => printWarning(`Retry ${attempt}: ${err.message}`) }
);

// Ctrl+C reports partial results
installShutdownHandler(() => {
  console.log(`${completedSteps.length} steps completed before abort`);
  printResults(log); // Show whatever was gathered
});
```

---

## Payment Caps and Approval Binding

Every payment in the packs goes through one path: **probe → approve → pay**. The final 402 offer has to match what was approved.

### Caps are exact USDC base units

- Caps are written as **USD decimal strings** (`'0.01'`, not `0.01`).
- `usdToUsdcBaseUnits()` converts them to USDC base units (6 decimals) with integer math only, so no floating-point values reach the cap path:
  - `'0.01'` → `10_000n`
  - `'1.234567'` → `1_234_567n`
  - More than 6 fractional digits, negative values, `NaN`, empty strings, exponents, zero and non-string inputs are all rejected.
- The packs pay only in **canonical USDC on the configured network**:

  | Network | x402 `network` | USDC contract |
  |---------|----------------|---------------|
  | Base Sepolia (default) | `base-sepolia:84532` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
  | Base Mainnet (opt-in) | `base:8453` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

  The packs refuse any other token, any token given only by symbol (such as `"USDC"`), any other network, and any scheme other than `exact`. In each case nothing is paid.

### One frozen, single-use approval per payment

1. `probeEndpoint(url)` reads the 402 `PAYMENT-REQUIRED` payload and picks the exact USDC offer for the configured network. If there is none, it returns `{ payable: false, reason }`.
2. `approveProbedPayment(info, capUsd)` turns that offer into a frozen `PaymentApproval` record containing `{ endpoint, method, network, asset, payTo, amount, capBaseUnits }`. The cap bounds the full debit — the probed amount **plus** the SDK's 0.77% protocol fee — so if that debit is above the cap, it throws `ApprovalRejectedError` (a `$0.01` cap approves at most 9,924 base units: 9,924 + 76 fee = 10,000). This record is what the user approves; the prompt shows the exact amount, payee, asset and network.
3. `fetchWithPayment(wallet, url, { approval })` pays only when the **final** offer matches the approval:
   - Endpoint, method and wallet chain are checked before any request is sent.
   - The SDK client is restricted to the approved network and its USDC contract. Its per-request and daily limits are both set to the approved amount plus the SDK protocol fee.
   - `onBeforePayment` compares the final offer's `amount` (exact, and with the protocol fee no more than the cap), `asset` and `payTo` (both case-insensitive), `network`, `scheme` and endpoint against the approval. If **any** field differs, it returns `false`. Nothing is signed and `ApprovalRejectedError` is thrown.
4. The first evaluation consumes the approval, whether it accepts or rejects the offer. A second payment needs a new probe and a new approval. `withRetry` never retries an `ApprovalRejectedError` or a `PaymentAwareError`.
5. Any failure after settlement — including the paid response body failing mid-read — is a `PaymentAwareError` carrying the settled amount and transaction hash, so callers count it against their budget and never retry it.

This stops a hostile endpoint from turning a $0.01 approval into a different payee, asset, network or amount after the user has said yes. `tests/value-pack-cap-binding.test.ts` covers each of these cases.

Daily caps in `PolicyGuard` and the displayed costs still use floats. They are for budgeting and display only and never authorize a payment.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AGENT_PRIVATE_KEY` | — | Agent hot wallet private key (`0x...`) |
| `AGENT_WALLET_ADDRESS` | — | AgentAccount contract address (`0x...`) |
| `CHAIN_ID` | `84532` | Chain ID (`84532` = Base Sepolia, `8453` = Base Mainnet). Other values are rejected. |
| `VALUE_PACK_ALLOW_MAINNET` | — | Must be `1` together with `CHAIN_ID=8453`, or the packs refuse to run on mainnet |
| `RPC_URL` | public Base RPC | Custom RPC endpoint |
| `X402_DEMO_URL` | `https://x402-demo.vercel.app/api/market-data` | Demo 402 endpoint URL. Set to `mock` for offline testing. |
| `DAILY_CAP_USD` | `5.00` | Daily spending cap in USD |
| `MAX_COST_USD` | `2.00` | Max total cost for automation-agent before refusing to start |
| `REPORTS_DIR` | `./reports` | Where research-agent writes its markdown reports |

---

## How x402 Works (in 30 seconds)

```
Agent → GET /api/premium-data
         ← 402 Payment Required
              PAYMENT-REQUIRED: base64({ accepts: [{ scheme: "exact",
                network: "base-sepolia:84532", asset: <USDC>, payTo, amount: "10000" }] })

Agent → [verifies exact USDC on the configured network, checks amount ≤ cap,
         freezes a single-use approval, shows the user the exact terms]
Agent → GET /api/premium-data          (fresh 402 — must match the approval)
Agent → [constructs payment proof via agentwallet-sdk]
Agent → GET /api/premium-data
         X-Payment: <signed proof>
         ← 200 OK { "data": ... }

Agent → [caches result for 1 hour — no double-paying]
```

The x402 protocol is an open standard. Any HTTP server can return a 402 with payment requirements. The `shared/x402-client.ts` in this repo handles the full client-side flow.

---

## Links

- **agentpay-mcp** — [github.com/up2itnow0822/agentpay-mcp](https://github.com/up2itnow0822/agentpay-mcp) — MCP server exposing x402 tools to Claude and other LLM agents
- **agentwallet-sdk** — npm package powering the wallet + payment logic in these examples
- **x402 Protocol** — [x402.org](https://x402.org) — Open HTTP payment standard
- **Base Network** — [base.org](https://base.org) — L2 chain used for on-chain payments

---

## Customizing

1. **Add your own endpoint** — add an entry to `ENDPOINTS` in `paid-api-agent.ts` with `free: false`, your URL, and a `maxCostUsd` decimal-string cap (paid endpoints without one are refused)
2. **Change the spending cap** — set `DAILY_CAP_USD=10` or edit `PolicyGuard` options directly
3. **Add a new task type** — extend `buildPlan()` in `automation-agent.ts` with new keyword patterns and step executors
4. **Change cache TTL** — pass `{ ttlMs: 30 * 60 * 1000 }` to `FileCache` for 30-minute caching

---

*Built with ❤️ by the AgentPay team. Patent Pending.*
