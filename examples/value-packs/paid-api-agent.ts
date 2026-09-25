#!/usr/bin/env npx tsx
/**
 * paid-api-agent.ts — Pack 1: Paid API Agent
 * ============================================
 * Demonstrates the x402 payment flow end-to-end:
 *
 *  1. Fetches data from a mix of free and paid endpoints
 *  2. On hitting a 402, shows the cost and asks for human approval
 *  3. Pays on approval, then retries the request
 *  4. Caches results to avoid double-paying within 1 hour
 *  5. Prints a summary of data gathered and total spent
 *
 * Run:
 *   npx tsx paid-api-agent.ts
 *   AGENT_PRIVATE_KEY=0x... AGENT_WALLET_ADDRESS=0x... npx tsx paid-api-agent.ts
 *
 * Optional env:
 *   X402_DEMO_URL=mock        — use mock data instead of live demo endpoint
 *   DAILY_CAP_USD=5           — override daily spend cap (default: $5)
 */

import {
  fetchFree,
  fetchWithPayment,
  probeEndpoint,
  createScriptWallet,
  getDemoEndpointUrl,
  getMockMarketData,
  isMockMode,
  withRetry,
  printWalletStatus,
  PaymentAwareError,
  settledPaymentAmount,
} from './shared/x402-client.js';

import { PolicyGuard, PolicyError } from './shared/spending-policy.js';
import { FileCache } from './shared/cache.js';
import {
  printHeader,
  printSection,
  printStep,
  printInfo,
  printSuccess,
  printWarning,
  printError,
  printFree,
  printPaid,
  printCostBreakdown,
  printBudgetStatus,
  requestApproval,
  installShutdownHandler,
  formatCost,
} from './shared/ui.js';

// ─── Configuration ─────────────────────────────────────────────────────────

const DAILY_CAP_USD = parseFloat(process.env['DAILY_CAP_USD'] ?? '5.00');
const APPROVAL_THRESHOLD_USD = 0.50;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── API Endpoint Definitions ──────────────────────────────────────────────

interface ApiEndpoint {
  name: string;
  url: string;
  free: boolean;
  description: string;
  estimatedCostUsd?: number;
  parser: (body: string) => Record<string, unknown>;
}

const ENDPOINTS: ApiEndpoint[] = [
  // ── Free endpoints ──────────────────────────────────────────────────────
  {
    name: 'BTC Price (CoinGecko)',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true',
    free: true,
    description: 'Live crypto prices from CoinGecko (free tier)',
    parser: (body) => {
      const data = JSON.parse(body);
      return {
        BTC: `$${data.bitcoin?.usd?.toLocaleString() ?? 'N/A'} (${data.bitcoin?.usd_24h_change?.toFixed(2) ?? '?'}% 24h)`,
        ETH: `$${data.ethereum?.usd?.toLocaleString() ?? 'N/A'} (${data.ethereum?.usd_24h_change?.toFixed(2) ?? '?'}% 24h)`,
        SOL: `$${data.solana?.usd?.toLocaleString() ?? 'N/A'} (${data.solana?.usd_24h_change?.toFixed(2) ?? '?'}% 24h)`,
      };
    },
  },
  {
    name: 'Weather (wttr.in)',
    url: 'https://wttr.in/Chicago?format=j1',
    free: true,
    description: 'Current weather data for Chicago',
    parser: (body) => {
      const data = JSON.parse(body);
      const current = data.current_condition?.[0];
      return {
        location: 'Chicago, IL',
        temp_f: `${current?.temp_F ?? 'N/A'}°F`,
        feels_like_f: `${current?.FeelsLikeF ?? 'N/A'}°F`,
        description: current?.weatherDesc?.[0]?.value ?? 'N/A',
        humidity: `${current?.humidity ?? 'N/A'}%`,
        wind_mph: `${current?.windspeedMiles ?? 'N/A'} mph`,
      };
    },
  },
  {
    name: 'GitHub Trending (API)',
    url: 'https://api.github.com/search/repositories?q=topic:ai-agents+topic:mcp&sort=stars&order=desc&per_page=3',
    free: true,
    description: 'Trending AI agent repos on GitHub',
    parser: (body) => {
      const data = JSON.parse(body);
      const repos = (data.items ?? []).slice(0, 3).map((r: Record<string, unknown>) => ({
        name: r['full_name'],
        stars: r['stargazers_count'],
        description: (r['description'] as string | null)?.slice(0, 80) ?? 'N/A',
      }));
      return { trending: repos };
    },
  },
  // ── Paid/402-gated endpoints ────────────────────────────────────────────
  {
    name: 'Market Data Pro (x402)',
    url: getDemoEndpointUrl(),
    free: false,
    description: 'Premium crypto market data with sentiment analysis',
    estimatedCostUsd: 0.01,
    parser: (body) => {
      const data = JSON.parse(body);
      if (data._mock) {
        return {
          _note: 'MOCK DATA (demo endpoint not reachable)',
          btc_price: data.btc?.price_usd,
          eth_price: data.eth?.price_usd,
          sentiment: data.sentiment?.overall,
          fear_greed: data.sentiment?.fear_greed_index,
          btc_dominance: data.dominance?.btc_pct,
        };
      }
      return {
        btc_price: data.btc?.price_usd ?? data.bitcoin?.price ?? 'N/A',
        eth_price: data.eth?.price_usd ?? data.ethereum?.price ?? 'N/A',
        sentiment: data.sentiment?.overall ?? data.market_sentiment ?? 'N/A',
        fear_greed: data.sentiment?.fear_greed_index ?? data.fear_greed ?? 'N/A',
        btc_dominance: data.dominance?.btc_pct ?? data.btc_dominance ?? 'N/A',
      };
    },
  },
];

// ─── Data collection ────────────────────────────────────────────────────────

interface DataResult {
  endpoint: ApiEndpoint;
  data: Record<string, unknown> | null;
  error: string | null;
  costUsd: number;
  fromCache: boolean;
  skipped: boolean;
}

async function collectData(
  endpoints: ApiEndpoint[],
  policy: PolicyGuard,
  cache: FileCache,
  wallet: ReturnType<typeof createScriptWallet> | null
): Promise<DataResult[]> {
  const results: DataResult[] = [];
  const total = endpoints.length;

  for (let i = 0; i < endpoints.length; i++) {
    const ep = endpoints[i];
    printStep(i + 1, total, ep.name);

    // ── Check cache first ─────────────────────────────────────────────────
    const cacheKey = `endpoint:${ep.url}`;
    const cached = cache.get<Record<string, unknown>>(cacheKey);

    if (cached) {
      const ttlMin = Math.round(cache.ttlRemaining(cacheKey) / 60000);
      printSuccess(`Cache hit — data is fresh (expires in ${ttlMin}m, no payment needed)`);
      results.push({ endpoint: ep, data: cached, error: null, costUsd: 0, fromCache: true, skipped: false });
      continue;
    }

    // ── Free endpoint ──────────────────────────────────────────────────────
    if (ep.free) {
      printFree(ep.description);

      const res = await fetchFree(ep.url);
      if (!res || res.status !== 200) {
        const err = `HTTP ${res?.status ?? 'timeout'} from ${ep.url}`;
        printError(err);
        results.push({ endpoint: ep, data: null, error: err, costUsd: 0, fromCache: false, skipped: false });
        continue;
      }

      try {
        const parsed = ep.parser(res.body);
        cache.set(cacheKey, parsed, { source: ep.url });
        printSuccess(`Got ${Object.keys(parsed).length} data point(s)`);
        results.push({ endpoint: ep, data: parsed, error: null, costUsd: 0, fromCache: false, skipped: false });
      } catch (parseErr) {
        printError(`Parse error: ${parseErr}`);
        results.push({ endpoint: ep, data: null, error: String(parseErr), costUsd: 0, fromCache: false, skipped: false });
      }
      continue;
    }

    // ── Paid (402-gated) endpoint ──────────────────────────────────────────
    printInfo('Type:', '💳 x402-gated (may require payment)');

    if (!wallet) {
      printWarning('No wallet configured — skipping paid endpoint.');
      printWarning('Set AGENT_PRIVATE_KEY + AGENT_WALLET_ADDRESS to enable payments.');
      results.push({ endpoint: ep, data: null, error: 'no wallet', costUsd: 0, fromCache: false, skipped: true });
      continue;
    }

    // Check if demo is in mock mode
    if (isMockMode()) {
      printWarning('X402_DEMO_URL=mock — using mock data (no payment)');
      const parsed = ep.parser(getMockMarketData());
      cache.set(cacheKey, parsed, { source: 'mock' });
      results.push({ endpoint: ep, data: parsed, error: null, costUsd: 0, fromCache: false, skipped: false });
      continue;
    }

    // Probe the endpoint to get payment requirements
    printInfo('Probing:', ep.url);
    const paymentInfo = await probeEndpoint(ep.url);

    let costUsd = ep.estimatedCostUsd ?? 0.01;
    if (paymentInfo) {
      costUsd = paymentInfo.amountUsd;
    } else {
      // Endpoint might be freely accessible or unreachable — try free fetch
      const freeAttempt = await fetchFree(ep.url);
      if (freeAttempt && freeAttempt.status === 200) {
        printSuccess('Endpoint is freely accessible (no 402)');
        try {
          const parsed = ep.parser(freeAttempt.body);
          cache.set(cacheKey, parsed, { source: ep.url });
          results.push({ endpoint: ep, data: parsed, error: null, costUsd: 0, fromCache: false, skipped: false });
        } catch {
          // If parse fails, fall back to mock
          printWarning('Parse failed — using mock data');
          const parsed = ep.parser(getMockMarketData());
          cache.set(cacheKey, parsed, { source: 'mock' });
          results.push({ endpoint: ep, data: parsed, error: null, costUsd: 0, fromCache: false, skipped: false });
        }
        continue;
      }

      // Endpoint unreachable — use mock fallback
      printWarning(`Demo endpoint unreachable — using mock data (set X402_DEMO_URL to a live endpoint)`);
      const parsed = ep.parser(getMockMarketData());
      cache.set(cacheKey, parsed, { source: 'mock' });
      results.push({ endpoint: ep, data: parsed, error: null, costUsd: 0, fromCache: false, skipped: false });
      continue;
    }

    printPaid(ep.description, costUsd);

    // Policy check
    try {
      policy.checkCanSpend(costUsd, ep.url);
    } catch (policyErr) {
      if (policyErr instanceof PolicyError) {
        printError(`Policy violation: ${policyErr.message}`);
        results.push({ endpoint: ep, data: null, error: policyErr.message, costUsd: 0, fromCache: false, skipped: true });
        continue;
      }
      throw policyErr;
    }

    // Human approval gate
    const needsApproval = policy.requiresApproval(costUsd) || costUsd >= APPROVAL_THRESHOLD_USD;
    if (needsApproval) {
      const approved = await requestApproval({
        action: 'x402 Payment',
        description: ep.description,
        costUsd,
        endpoint: ep.url,
        details: paymentInfo
          ? {
              'Token:': paymentInfo.token,
              'Network:': paymentInfo.network,
            }
          : undefined,
      });

      if (!approved) {
        policy.record(0, ep.url, false);
        results.push({ endpoint: ep, data: null, error: 'user denied', costUsd: 0, fromCache: false, skipped: true });
        continue;
      }
    } else {
      printInfo('Auto-approved:', `$${costUsd.toFixed(4)} (below $${APPROVAL_THRESHOLD_USD} threshold)`);
    }

    // Execute payment and fetch. Record spend at settlement, not only on HTTP success.
    let recordedAtPayment = false;
    try {
      const result = await withRetry(
        () =>
          fetchWithPayment(wallet, ep.url, {
            maxPaymentUsd: costUsd * 1.1, // 10% buffer
            callbacks: {
              onPaymentRequired: (amt, url) => {
                printInfo('Paying:', `$${amt.toFixed(4)} for ${url}`);
              },
              onPaymentComplete: (amt, tx) => {
                if (!recordedAtPayment) {
                  policy.record(amt, ep.url, true);
                  recordedAtPayment = true;
                }
                printSuccess(`Payment confirmed: $${amt.toFixed(4)} (tx: ${tx.slice(0, 10)}...)`);
              },
            },
          }),
        {
          maxAttempts: 2,
          initialDelayMs: 1000,
          maxDelayMs: 3000,
          onRetry: (attempt, err) => {
            printWarning(`Retry ${attempt}: ${err.message}`);
          },
        }
      );

      const actualCost = result.amountPaidUsd > 0 ? result.amountPaidUsd : costUsd;
      if (!recordedAtPayment) {
        policy.record(actualCost, ep.url, true);
        recordedAtPayment = true;
      }

      const parsed = ep.parser(result.body);
      cache.set(cacheKey, parsed, { source: ep.url });

      printSuccess(`Data received — ${Object.keys(parsed).length} field(s), cost: ${formatCost(actualCost)}`);
      results.push({ endpoint: ep, data: parsed, error: null, costUsd: actualCost, fromCache: false, skipped: false });
    } catch (fetchErr) {
      const settled = settledPaymentAmount(fetchErr);
      if (settled !== null && !recordedAtPayment) {
        policy.record(settled, ep.url, true);
        recordedAtPayment = true;
      }
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      const costOnFailure = settled ?? 0;
      printError(
        fetchErr instanceof PaymentAwareError
          ? `Payment settled but fetch failed; not retrying: ${msg}`
          : `Payment/fetch failed: ${msg}`
      );
      results.push({ endpoint: ep, data: null, error: msg, costUsd: costOnFailure, fromCache: false, skipped: false });
    }
  }

  return results;
}

// ─── Summary printer ───────────────────────────────────────────────────────

function printSummary(results: DataResult[], policy: PolicyGuard): void {
  printSection('Data Summary');

  let freeSources = 0;
  let paidSources = 0;
  let totalCostUsd = 0;

  for (const r of results) {
    if (r.skipped) {
      console.log(`  ⊘ ${r.endpoint.name}: skipped (${r.error})`);
      continue;
    }
    if (!r.data) {
      console.log(`  ✗ ${r.endpoint.name}: error — ${r.error}`);
      continue;
    }

    const cacheLabel = r.fromCache ? ' [cached]' : '';
    const costLabel = r.costUsd > 0 ? ` [$${r.costUsd.toFixed(4)}]` : ' [free]';
    console.log(`\n  ✓ ${r.endpoint.name}${cacheLabel}${costLabel}`);

    // Print data
    for (const [k, v] of Object.entries(r.data)) {
      if (k === '_note' || k === '_mock') continue;
      if (Array.isArray(v)) {
        console.log(`      ${k}:`);
        v.forEach((item) => console.log(`        - ${JSON.stringify(item)}`));
      } else if (typeof v === 'object' && v !== null) {
        console.log(`      ${k}: ${JSON.stringify(v)}`);
      } else {
        console.log(`      ${k}: ${v}`);
      }
    }

    if (r.costUsd > 0) {
      paidSources++;
      totalCostUsd += r.costUsd;
    } else {
      freeSources++;
    }
  }

  printCostBreakdown({ freeSources, paidSources, totalCostUsd });
  printBudgetStatus(policy.dailySpend, policy.config.dailyCapUsd);

  if (policy.history.length > 0) {
    printSection('Payment History');
    for (const h of policy.history) {
      if (h.approved) {
        console.log(`  💳 $${h.amountUsd.toFixed(4)} → ${h.endpoint}`);
      }
    }
  }
}

// ─── Entry point ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printHeader('Paid API Agent — x402 Value Pack Demo');

  // Show wallet status (without revealing the key)
  printSection('Wallet Config');
  printWalletStatus();

  const policy = new PolicyGuard({
    dailyCapUsd: DAILY_CAP_USD,
    perTxCapUsd: 1.00,
    approvalThresholdUsd: APPROVAL_THRESHOLD_USD,
  });

  const cache = new FileCache({ ttlMs: CACHE_TTL_MS });

  // Show policy
  printSection('Spending Policy');
  console.log(
    policy
      .summary()
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n')
  );

  // Prune stale cache entries
  const pruned = cache.prune();
  if (pruned > 0) printInfo('Cache pruned:', `${pruned} expired entries removed`);

  // Create wallet (null if env vars not set — free endpoints still work)
  let wallet: ReturnType<typeof createScriptWallet> | null = null;
  try {
    wallet = createScriptWallet();
  } catch {
    // Wallet not configured — paid endpoints will be skipped
  }

  // Register Ctrl+C handler
  let results: DataResult[] = [];
  installShutdownHandler(() => {
    if (results.length > 0) {
      printSummary(results, policy);
    }
  });

  // Collect data
  printSection('Fetching Data');
  console.log(`  Endpoints: ${ENDPOINTS.length} (${ENDPOINTS.filter((e) => e.free).length} free, ${ENDPOINTS.filter((e) => !e.free).length} paid)\n`);

  results = await collectData(ENDPOINTS, policy, cache, wallet);

  // Print summary
  printSummary(results, policy);

  // Cache stats
  const cacheStats = cache.getStats();
  printSection('Cache Stats');
  printInfo('Hits:', String(cacheStats.hits));
  printInfo('Misses:', String(cacheStats.misses));
  printInfo('Saved:', String(cacheStats.saves));

  console.log('\n');
}

main().catch((err) => {
  printError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
