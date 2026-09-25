#!/usr/bin/env npx tsx
/**
 * automation-agent.ts — Pack 3: Automation Agent
 * ================================================
 * Demonstrates task planning, cost estimation, and safe execution:
 *
 *  1. Takes a task description as a CLI argument
 *  2. Plans the steps (which APIs to call, estimated cost)
 *  3. Shows the plan to the user with cost estimate
 *  4. On approval, executes each step sequentially with progress output
 *  5. Handles failures gracefully (retry, fallback to free alternatives)
 *  6. Outputs the result with a full execution log
 *  7. Handles Ctrl+C cleanly — reports what was completed
 *
 * Run:
 *   npx tsx automation-agent.ts "get BTC price and sentiment analysis"
 *   npx tsx automation-agent.ts "research AI payment protocols"
 *   npx tsx automation-agent.ts "monitor crypto market overview"
 *
 * Optional env:
 *   X402_DEMO_URL=mock   — use mock data for paid endpoints
 *   DAILY_CAP_USD=5      — max daily spend cap
 *   MAX_COST_USD=1       — refuse to start if plan exceeds this
 */

import {
  fetchFree,
  fetchWithPayment,
  probeEndpoint,
  createScriptWallet,
  getDemoEndpointUrl,
  getMockMarketData,
  getMockSentimentData,
  isMockMode,
  withRetry,
  sleep,
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
  printCostBreakdown,
  printBudgetStatus,
  requestPlanApproval,
  installShutdownHandler,
  bold,
  dim,
  colorize,
} from './shared/ui.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const DAILY_CAP_USD = parseFloat(process.env['DAILY_CAP_USD'] ?? '5.00');
const MAX_COST_USD = parseFloat(process.env['MAX_COST_USD'] ?? '2.00');

// ─── Task Step types ─────────────────────────────────────────────────────────

type StepStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'fallback';

interface TaskStep {
  id: string;
  name: string;
  description: string;
  isFree: boolean;
  estimatedCostUsd: number;
  status: StepStatus;
  result: unknown | null;
  error: string | null;
  actualCostUsd: number;
  durationMs: number;
  startedAt?: number;
  usedFallback?: boolean;
}

interface ExecutionLog {
  task: string;
  startedAt: string;
  completedAt: string | null;
  steps: TaskStep[];
  totalCostUsd: number;
  aborted: boolean;
}

// ─── Task catalog ─────────────────────────────────────────────────────────────
// Maps natural-language task patterns to execution plans.

interface TaskPlan {
  name: string;
  steps: Omit<TaskStep, 'status' | 'result' | 'error' | 'actualCostUsd' | 'durationMs' | 'startedAt' | 'usedFallback'>[];
}

function buildPlan(taskDescription: string, hasPaidCapability: boolean): TaskPlan {
  const desc = taskDescription.toLowerCase();

  // Pattern matching to build task plans
  const isMarketTask =
    desc.includes('btc') ||
    desc.includes('bitcoin') ||
    desc.includes('crypto') ||
    desc.includes('market') ||
    desc.includes('price');

  const isResearchTask =
    desc.includes('research') ||
    desc.includes('learn') ||
    desc.includes('explain') ||
    desc.includes('protocol') ||
    desc.includes('find');

  const isSentimentTask =
    desc.includes('sentiment') ||
    desc.includes('feeling') ||
    desc.includes('mood') ||
    desc.includes('analysis') ||
    desc.includes('analyze');

  const isWeatherTask =
    desc.includes('weather') ||
    desc.includes('temperature') ||
    desc.includes('forecast');

  const steps: TaskPlan['steps'] = [];

  // Always start with a health check / connectivity probe (free)
  steps.push({
    id: 'connectivity',
    name: 'Connectivity Check',
    description: 'Verify API endpoints are reachable before starting paid steps',
    isFree: true,
    estimatedCostUsd: 0,
  });

  if (isMarketTask || (!isResearchTask && !isWeatherTask)) {
    steps.push({
      id: 'crypto-prices',
      name: 'Fetch Crypto Prices',
      description: 'Get live BTC, ETH, SOL prices from CoinGecko (free)',
      isFree: true,
      estimatedCostUsd: 0,
    });
  }

  if (isWeatherTask) {
    steps.push({
      id: 'weather',
      name: 'Fetch Weather Data',
      description: 'Get current weather from wttr.in (free)',
      isFree: true,
      estimatedCostUsd: 0,
    });
  }

  if (isResearchTask) {
    steps.push({
      id: 'wikipedia',
      name: 'Fetch Wikipedia Summary',
      description: 'Get background context from Wikipedia (free)',
      isFree: true,
      estimatedCostUsd: 0,
    });
    steps.push({
      id: 'github-search',
      name: 'Search GitHub Projects',
      description: 'Find relevant open-source projects (free)',
      isFree: true,
      estimatedCostUsd: 0,
    });
  }

  if ((isSentimentTask || isMarketTask) && hasPaidCapability) {
    steps.push({
      id: 'market-sentiment',
      name: 'Market Sentiment Analysis (x402)',
      description: `Premium market sentiment data from ${getDemoEndpointUrl()}`,
      isFree: false,
      estimatedCostUsd: 0.01,
    });
  }

  if (isResearchTask && hasPaidCapability && (isSentimentTask || isMarketTask)) {
    steps.push({
      id: 'paid-intelligence',
      name: 'Enhanced Market Intelligence (x402)',
      description: 'Detailed market intelligence and trend analysis',
      isFree: false,
      estimatedCostUsd: 0.01,
    });
  }

  // Always end with aggregation (free)
  steps.push({
    id: 'aggregate',
    name: 'Aggregate Results',
    description: 'Combine all data sources into structured output',
    isFree: true,
    estimatedCostUsd: 0,
  });

  const planName = [
    isMarketTask && 'Market Analysis',
    isSentimentTask && 'Sentiment Analysis',
    isResearchTask && 'Research',
    isWeatherTask && 'Weather Check',
  ]
    .filter(Boolean)
    .join(' + ') || 'General Task';

  return { name: planName, steps };
}

// ─── Step executors ────────────────────────────────────────────────────────────

type StepExecutor = (
  step: TaskStep,
  context: ExecutionContext
) => Promise<unknown>;

interface ExecutionContext {
  task: string;
  wallet: ReturnType<typeof createScriptWallet> | null;
  cache: FileCache;
  policy: PolicyGuard;
  results: Map<string, unknown>;
}

const stepExecutors: Record<string, StepExecutor> = {
  connectivity: async (_step, ctx) => {
    const endpoints = [
      'https://api.coingecko.com/api/v3/ping',
      'https://wttr.in/?format=j1',
    ];
    const statuses: Record<string, string> = {};
    for (const url of endpoints) {
      const res = await fetchFree(url, { timeoutMs: 5000 });
      statuses[url] = res?.status === 200 ? 'OK' : `HTTP ${res?.status ?? 'timeout'}`;
    }
    return statuses;
  },

  'crypto-prices': async (_step, ctx) => {
    const cacheKey = 'crypto:prices:current';
    const cached = ctx.cache.get(cacheKey);
    if (cached) return cached;

    const res = await withRetry(
      () =>
        fetchFree(
          'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true&include_market_cap=true'
        ),
      { maxAttempts: 3, initialDelayMs: 1000, maxDelayMs: 5000 }
    );

    if (!res || res.status !== 200) {
      throw new Error(`CoinGecko returned HTTP ${res?.status ?? 'timeout'}`);
    }

    const data = JSON.parse(res.body);
    const result = {
      BTC: {
        price: data.bitcoin?.usd,
        change_24h: data.bitcoin?.usd_24h_change?.toFixed(2),
        market_cap: data.bitcoin?.usd_market_cap,
      },
      ETH: {
        price: data.ethereum?.usd,
        change_24h: data.ethereum?.usd_24h_change?.toFixed(2),
        market_cap: data.ethereum?.usd_market_cap,
      },
      SOL: {
        price: data.solana?.usd,
        change_24h: data.solana?.usd_24h_change?.toFixed(2),
      },
    };

    ctx.cache.set(cacheKey, result, { ttlMs: 5 * 60 * 1000, source: 'coingecko' });
    return result;
  },

  weather: async (_step, _ctx) => {
    const res = await fetchFree('https://wttr.in/Chicago?format=j1');
    if (!res || res.status !== 200) {
      // Graceful fallback
      return {
        location: 'Chicago',
        note: 'Weather data unavailable — wttr.in may be down',
        fallback: true,
      };
    }
    const data = JSON.parse(res.body);
    const c = data.current_condition?.[0];
    return {
      location: 'Chicago, IL',
      temp_f: c?.temp_F,
      feels_like_f: c?.FeelsLikeF,
      condition: c?.weatherDesc?.[0]?.value,
      humidity_pct: c?.humidity,
      wind_mph: c?.windspeedMiles,
    };
  },

  wikipedia: async (_step, ctx) => {
    const topic = ctx.task;
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`;
    const res = await fetchFree(url);
    if (!res || res.status !== 200) return { summary: null, error: `HTTP ${res?.status}` };
    const data = JSON.parse(res.body);
    return {
      title: data.title,
      summary: data.extract?.slice(0, 500) + '...',
      url: data.content_urls?.desktop?.page,
    };
  },

  'github-search': async (_step, ctx) => {
    const topic = ctx.task;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(topic)}&sort=stars&order=desc&per_page=3`;
    const res = await fetchFree(url, { headers: { Accept: 'application/vnd.github.v3+json' } });
    if (!res || res.status !== 200) return { repos: [], error: `HTTP ${res?.status}` };
    const data = JSON.parse(res.body);
    return {
      total: data.total_count,
      repos: (data.items ?? []).slice(0, 3).map((r: Record<string, unknown>) => ({
        name: r['full_name'],
        stars: r['stargazers_count'],
        url: r['html_url'],
        description: (r['description'] as string | null)?.slice(0, 100),
      })),
    };
  },

  'market-sentiment': async (step, ctx) => {
    if (!ctx.wallet) throw new Error('No wallet — cannot fetch paid endpoint');

    const endpointUrl = getDemoEndpointUrl();

    if (isMockMode()) {
      const mock = JSON.parse(getMockMarketData());
      return {
        sentiment: mock.sentiment?.overall,
        fear_greed: mock.sentiment?.fear_greed_index,
        label: mock.sentiment?.label,
        btc_dominance: mock.dominance?.btc_pct,
        _mock: true,
      };
    }

    // Try live endpoint first — if unreachable, fall back to mock
    const probe = await probeEndpoint(endpointUrl, 5000);
    if (!probe) {
      // Endpoint reachable but not gated, or not reachable at all
      const freeAttempt = await fetchFree(endpointUrl, { timeoutMs: 5000 });
      if (freeAttempt && freeAttempt.status === 200) {
        const data = JSON.parse(freeAttempt.body);
        return data;
      }
      // Not reachable — use mock fallback
      step.usedFallback = true;
      const mock = JSON.parse(getMockMarketData());
      return {
        sentiment: mock.sentiment?.overall ?? 'neutral',
        fear_greed: mock.sentiment?.fear_greed_index ?? 50,
        label: mock.sentiment?.label ?? 'Neutral',
        btc_dominance: mock.dominance?.btc_pct ?? 50,
        _mock: true,
        _fallback_reason: 'Demo endpoint not reachable',
      };
    }

    let result;
    try {
      result = await withRetry(
        () =>
          fetchWithPayment(ctx.wallet!, endpointUrl, {
            maxPaymentUsd: step.estimatedCostUsd * 1.5,
            callbacks: {
              onPaymentComplete: (amt) => {
                step.actualCostUsd = amt;
              },
            },
          }),
        { maxAttempts: 2, initialDelayMs: 2000, maxDelayMs: 8000 }
      );
    } catch (err) {
      const settled = settledPaymentAmount(err);
      if (settled !== null) {
        step.actualCostUsd = settled;
      }
      throw err;
    }

    const data = JSON.parse(result.body);
    step.actualCostUsd = result.amountPaidUsd;
    return {
      sentiment: data.sentiment?.overall ?? data.market_sentiment,
      fear_greed: data.sentiment?.fear_greed_index ?? data.fear_greed,
      label: data.sentiment?.label,
      btc_dominance: data.dominance?.btc_pct,
    };
  },

  'paid-intelligence': async (step, ctx) => {
    // This step intentionally reuses the same demo endpoint as a second paid call
    // to illustrate the flow — in production you'd call a different endpoint
    if (!ctx.wallet) throw new Error('No wallet');

    if (isMockMode()) {
      return getMockSentimentData(ctx.task);
    }

    // For this demo, return synthesized analysis from free data we already have
    const cryptoData = ctx.results.get('crypto-prices') as Record<string, unknown> | undefined;
    const sentimentData = ctx.results.get('market-sentiment') as Record<string, unknown> | undefined;

    // Build a simple intelligence report from free data we already have
    step.usedFallback = true; // Mark as free-synthesized fallback
    step.actualCostUsd = 0;

    return {
      analysis: 'Synthesized from free data sources',
      btc_trend: (cryptoData?.BTC as Record<string, unknown> | undefined)?.change_24h,
      market_mood: sentimentData?.sentiment ?? 'unknown',
      recommendation: 'Based on available data — not financial advice',
      _synthesized: true,
    };
  },

  aggregate: async (_step, ctx) => {
    const output: Record<string, unknown> = {};
    for (const [key, value] of ctx.results.entries()) {
      output[key] = value;
    }
    return {
      task: ctx.task,
      timestamp: new Date().toISOString(),
      data: output,
      summary: `Completed ${ctx.results.size} data collection step(s)`,
    };
  },
};

// ─── Step runner ─────────────────────────────────────────────────────────────

async function runStep(
  step: TaskStep,
  ctx: ExecutionContext,
  stepNum: number,
  totalSteps: number
): Promise<void> {
  const startMs = Date.now();
  step.startedAt = startMs;
  step.status = 'running';

  const statusIcon = step.isFree ? '🆓' : '💳';
  const costLabel = step.isFree ? 'free' : `~$${step.estimatedCostUsd.toFixed(4)}`;
  printStep(stepNum, totalSteps, `${step.name} ${statusIcon} (${costLabel})`);

  // Policy check for paid steps
  if (!step.isFree) {
    try {
      ctx.policy.checkCanSpend(step.estimatedCostUsd, step.name);
    } catch (policyErr) {
      if (policyErr instanceof PolicyError) {
        step.status = 'skipped';
        step.error = policyErr.message;
        printError(`Policy: ${policyErr.message}`);
        return;
      }
      throw policyErr;
    }
  }

  const executor = stepExecutors[step.id];
  if (!executor) {
    step.status = 'failed';
    step.error = `No executor registered for step: ${step.id}`;
    printError(step.error);
    step.durationMs = Date.now() - startMs;
    return;
  }

  try {
    const result = await executor(step, ctx);
    step.result = result;
    step.status = step.usedFallback ? 'fallback' : 'success';
    step.durationMs = Date.now() - startMs;

    if (result) {
      ctx.results.set(step.id, result);
    }

    if (!step.isFree && step.actualCostUsd > 0) {
      ctx.policy.record(step.actualCostUsd, step.name, true);
    }

    const fallbackNote = step.usedFallback ? ' (fallback data)' : '';
    printSuccess(`${step.name}: done in ${step.durationMs}ms${fallbackNote}`);
  } catch (err) {
    if (!step.isFree && step.actualCostUsd > 0) {
      ctx.policy.record(step.actualCostUsd, step.name, true);
    }
    step.status = 'failed';
    step.error = err instanceof Error ? err.message : String(err);
    step.durationMs = Date.now() - startMs;
    printError(
      err instanceof PaymentAwareError
        ? `${step.name}: payment settled but fetch failed; not retrying: ${step.error}`
        : `${step.name}: ${step.error}`
    );

    // Try to continue with next step — non-fatal failures
    printWarning('Continuing with remaining steps...');
  }
}

// ─── Result printer ───────────────────────────────────────────────────────────

function printResults(log: ExecutionLog): void {
  printSection('Execution Results');

  for (const step of log.steps) {
    const icon =
      step.status === 'success'
        ? '✓'
        : step.status === 'fallback'
        ? '⚡'
        : step.status === 'skipped'
        ? '⊘'
        : '✗';
    const color =
      step.status === 'success'
        ? 'green'
        : step.status === 'fallback'
        ? 'yellow'
        : step.status === 'skipped'
        ? 'gray'
        : 'red';

    const costNote =
      step.actualCostUsd > 0 ? ` ($${step.actualCostUsd.toFixed(4)})` : step.isFree ? ' (free)' : '';

    console.log(`\n  ${colorize(color, icon)} ${bold(step.name)}${costNote}`);

    if (step.result && step.status !== 'skipped') {
      const data = step.result as Record<string, unknown>;

      // Special formatting for aggregate step
      if (step.id === 'aggregate') {
        const agg = data as { summary: string; timestamp: string };
        console.log(`    ${agg.summary}`);
        console.log(`    Completed at: ${agg.timestamp}`);
        continue;
      }

      // Print key data points
      for (const [k, v] of Object.entries(data)) {
        if (k.startsWith('_')) continue; // Skip meta fields
        if (v === null || v === undefined) continue;
        if (typeof v === 'object' && !Array.isArray(v)) {
          for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
            if (v2 !== null && v2 !== undefined) {
              console.log(`    ${dim(k + '.' + k2 + ':')} ${v2}`);
            }
          }
        } else {
          console.log(`    ${dim(k + ':')} ${v}`);
        }
      }
    }

    if (step.error) {
      console.log(`    ${colorize('red', 'Error:')} ${step.error}`);
    }
  }

  // Execution log table
  printSection('Execution Log');
  console.log(`  ${'Step'.padEnd(30)} ${'Status'.padEnd(12)} ${'Duration'.padEnd(12)} Cost`);
  console.log(`  ${'─'.repeat(65)}`);
  for (const step of log.steps) {
    const statusStr = step.status.padEnd(12);
    const duration = step.durationMs ? `${step.durationMs}ms`.padEnd(12) : 'N/A'.padEnd(12);
    const cost = step.actualCostUsd > 0 ? `$${step.actualCostUsd.toFixed(4)}` : step.isFree ? 'free' : 'skipped';
    console.log(`  ${step.name.slice(0, 29).padEnd(30)} ${statusStr} ${duration} ${cost}`);
  }

  // Cost summary
  const freeSources = log.steps.filter((s) => s.isFree && s.status === 'success').length;
  const paidSources = log.steps.filter((s) => !s.isFree && s.actualCostUsd > 0).length;
  printCostBreakdown({ freeSources, paidSources, totalCostUsd: log.totalCostUsd });
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const task = args.find((a) => !a.startsWith('--')) ?? '';

  if (!task) {
    console.error('\nUsage: npx tsx automation-agent.ts "your task description"\n');
    console.error('Examples:');
    console.error('  npx tsx automation-agent.ts "get BTC price and sentiment analysis"');
    console.error('  npx tsx automation-agent.ts "research AI payment protocols"');
    console.error('  npx tsx automation-agent.ts "monitor crypto market overview"');
    console.error('  npx tsx automation-agent.ts "get weather and crypto update"\n');
    process.exit(1);
  }

  printHeader(`Automation Agent — "${task}"`);

  printSection('Wallet Config');
  printWalletStatus();

  const policy = new PolicyGuard({ dailyCapUsd: DAILY_CAP_USD });
  const cache = new FileCache({ ttlMs: 5 * 60 * 1000 }); // 5-minute cache

  let wallet: ReturnType<typeof createScriptWallet> | null = null;
  try {
    wallet = createScriptWallet();
  } catch {
    printWarning('Wallet not configured — paid steps will use fallback data');
  }

  // Build task plan
  printSection('Task Planning');
  const plan = buildPlan(task, wallet !== null);
  console.log(`\n  Task type: ${bold(plan.name)}`);
  console.log(`  Steps: ${plan.steps.length} planned\n`);

  // Initialize steps with tracking fields
  const steps: TaskStep[] = plan.steps.map((s) => ({
    ...s,
    status: 'pending',
    result: null,
    error: null,
    actualCostUsd: 0,
    durationMs: 0,
  }));

  // Build plan for approval display
  const planForApproval = {
    steps: steps.map((s) => ({ name: s.name, cost: s.estimatedCostUsd, free: s.isFree })),
    totalCostUsd: steps.filter((s) => !s.isFree).reduce((sum, s) => sum + s.estimatedCostUsd, 0),
    dailyCapUsd: policy.config.dailyCapUsd,
  };

  // Budget guard — refuse to start if estimated cost exceeds cap
  const estimatedTotal = planForApproval.totalCostUsd;
  if (estimatedTotal > MAX_COST_USD) {
    printError(
      `Estimated cost $${estimatedTotal.toFixed(4)} exceeds MAX_COST_USD=$${MAX_COST_USD.toFixed(2)}.`
    );
    printError('Set MAX_COST_USD environment variable to a higher value to proceed.');
    process.exit(1);
  }

  // Get approval
  const approved = await requestPlanApproval(planForApproval);
  if (!approved) {
    printWarning('Task cancelled by user.');
    process.exit(0);
  }

  // Set up execution log
  const log: ExecutionLog = {
    task,
    startedAt: new Date().toISOString(),
    completedAt: null,
    steps,
    totalCostUsd: 0,
    aborted: false,
  };

  const ctx: ExecutionContext = {
    task,
    wallet,
    cache,
    policy,
    results: new Map(),
  };

  // Ctrl+C handler — report partial results
  installShutdownHandler(() => {
    log.aborted = true;
    log.completedAt = new Date().toISOString();
    const completedSteps = steps.filter((s) => s.status === 'success' || s.status === 'fallback');
    console.log(`\n  ${completedSteps.length}/${steps.length} steps completed before abort.`);
    if (completedSteps.length > 0) {
      printResults(log);
    }
  });

  // Execute steps
  printSection('Executing Steps');
  console.log('');

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    await runStep(step, ctx, i + 1, steps.length);
    // Brief pause between steps
    if (i < steps.length - 1) await sleep(200);
  }

  // Finalize log
  log.completedAt = new Date().toISOString();
  log.totalCostUsd = steps.reduce((sum, s) => sum + s.actualCostUsd, 0);

  // Print results
  printResults(log);

  // Budget status
  printBudgetStatus(policy.dailySpend, policy.config.dailyCapUsd);

  // Execution summary
  const succeeded = steps.filter((s) => s.status === 'success' || s.status === 'fallback').length;
  const failed = steps.filter((s) => s.status === 'failed').length;
  const skipped = steps.filter((s) => s.status === 'skipped').length;

  printSection('Summary');
  printInfo('Task:', task);
  printInfo('Steps completed:', `${succeeded}/${steps.length} (${failed} failed, ${skipped} skipped)`);
  printInfo('Total spent:', `$${log.totalCostUsd.toFixed(4)}`);
  printInfo('Duration:', `${((Date.now() - new Date(log.startedAt).getTime()) / 1000).toFixed(1)}s`);

  console.log('\n');
}

main().catch((err) => {
  printError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
