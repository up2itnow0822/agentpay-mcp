#!/usr/bin/env npx tsx
/**
 * research-agent.ts — Pack 2: Research Agent
 * ============================================
 * Demonstrates the "free-first" strategy for building research pipelines:
 *
 *  1. Takes a research topic as a CLI argument
 *  2. Gathers data from free sources: Wikipedia, GitHub, HackerNews
 *  3. Identifies gaps in the research (missing sections)
 *  4. Estimates cost to fill gaps with paid x402 sources
 *  5. Asks for human approval before spending
 *  6. Compiles a structured markdown research report
 *  7. Shows a full cost breakdown: free vs paid
 *
 * Run:
 *   npx tsx research-agent.ts "AI payment protocols"
 *   npx tsx research-agent.ts "x402 protocol" --no-paid
 *
 * Options:
 *   --no-paid     Skip paid sources entirely (free-only mode)
 *   --output DIR  Write report to file in DIR (default: ./reports/)
 *
 * Optional env:
 *   X402_DEMO_URL=mock  — use mock data for paid sources
 *   DAILY_CAP_USD=5     — daily spend cap
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  fetchFree,
  fetchWithPayment,
  probeEndpoint,
  createScriptWallet,
  getDemoEndpointUrl,
  getMockSentimentData,
  isMockMode,
  withRetry,
  printWalletStatus,
  sleep,
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
  requestApproval,
  requestPlanApproval,
  installShutdownHandler,
  bold,
  dim,
} from './shared/ui.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const DAILY_CAP_USD = parseFloat(process.env['DAILY_CAP_USD'] ?? '5.00');
const REPORTS_DIR = process.env['REPORTS_DIR'] ?? './reports';

// ─── CLI Parsing ────────────────────────────────────────────────────────────

function parseArgs(): { topic: string; noPaid: boolean; outputDir: string } {
  const args = process.argv.slice(2);
  const topic = args.find((a) => !a.startsWith('--')) ?? '';
  const noPaid = args.includes('--no-paid');
  const outputIdx = args.indexOf('--output');
  const outputDir = outputIdx !== -1 ? (args[outputIdx + 1] ?? REPORTS_DIR) : REPORTS_DIR;

  if (!topic) {
    console.error('\nUsage: npx tsx research-agent.ts "your research topic" [--no-paid]\n');
    console.error('Examples:');
    console.error('  npx tsx research-agent.ts "AI payment protocols"');
    console.error('  npx tsx research-agent.ts "x402 protocol" --no-paid\n');
    process.exit(1);
  }

  return { topic, noPaid, outputDir };
}

// ─── Source types ────────────────────────────────────────────────────────────

interface ResearchSection {
  title: string;
  content: string | null;
  source: string;
  sourceUrl: string;
  isFree: boolean;
  costUsd: number;
  error?: string;
}

interface ResearchReport {
  topic: string;
  generatedAt: string;
  sections: ResearchSection[];
  totalCostUsd: number;
  freeSources: number;
  paidSources: number;
}

// ─── Free source fetchers ────────────────────────────────────────────────────

async function fetchWikipedia(topic: string): Promise<ResearchSection> {
  const searchUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`;

  printFree('Wikipedia — background overview');

  const res = await fetchFree(searchUrl);
  if (!res || res.status !== 200) {
    // Try search endpoint as fallback
    const searchFallback = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(topic)}&format=json&srlimit=1`;
    const searchRes = await fetchFree(searchFallback);
    if (!searchRes || searchRes.status !== 200) {
      return {
        title: 'Wikipedia Overview',
        content: null,
        source: 'Wikipedia',
        sourceUrl: searchUrl,
        isFree: true,
        costUsd: 0,
        error: `HTTP ${res?.status ?? 'timeout'}`,
      };
    }
    const searchData = JSON.parse(searchRes.body);
    const firstResult = searchData.query?.search?.[0];
    if (firstResult) {
      return {
        title: 'Wikipedia Overview',
        content: firstResult.snippet?.replace(/<[^>]+>/g, '') + '...',
        source: 'Wikipedia (search)',
        sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(firstResult.title)}`,
        isFree: true,
        costUsd: 0,
      };
    }
    return {
      title: 'Wikipedia Overview',
      content: null,
      source: 'Wikipedia',
      sourceUrl: searchUrl,
      isFree: true,
      costUsd: 0,
      error: 'No results found',
    };
  }

  const data = JSON.parse(res.body);
  const content = [
    data.extract,
    data.description ? `\n**Category:** ${data.description}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  printSuccess(`Wikipedia: ${data.title} (${data.extract?.split(' ').length ?? 0} words)`);

  return {
    title: 'Overview',
    content,
    source: 'Wikipedia',
    sourceUrl: data.content_urls?.desktop?.page ?? searchUrl,
    isFree: true,
    costUsd: 0,
  };
}

async function fetchGitHubProjects(topic: string): Promise<ResearchSection> {
  const query = encodeURIComponent(topic);
  const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=5`;

  printFree('GitHub — related open-source projects');

  const res = await fetchFree(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'agentpay-value-packs/1.0',
    },
  });

  if (!res || res.status !== 200) {
    return {
      title: 'Related Projects',
      content: null,
      source: 'GitHub',
      sourceUrl: url,
      isFree: true,
      costUsd: 0,
      error: `HTTP ${res?.status ?? 'timeout'}`,
    };
  }

  const data = JSON.parse(res.body);
  const repos = (data.items ?? []).slice(0, 5);

  if (repos.length === 0) {
    return {
      title: 'Related Projects',
      content: 'No public repositories found for this topic.',
      source: 'GitHub',
      sourceUrl: url,
      isFree: true,
      costUsd: 0,
    };
  }

  const content = repos
    .map(
      (r: Record<string, unknown>) =>
        `### [${r['full_name']}](${r['html_url']})\n` +
        `⭐ ${(r['stargazers_count'] as number).toLocaleString()} stars | ` +
        `🍴 ${(r['forks_count'] as number).toLocaleString()} forks | ` +
        `Language: ${r['language'] ?? 'Unknown'}\n\n` +
        `${r['description'] ?? 'No description.'}`
    )
    .join('\n\n---\n\n');

  printSuccess(`GitHub: found ${repos.length} related repositories`);

  return {
    title: 'Related Open-Source Projects',
    content,
    source: 'GitHub',
    sourceUrl: `https://github.com/search?q=${query}&sort=stars`,
    isFree: true,
    costUsd: 0,
  };
}

async function fetchHackerNewsDiscussions(topic: string): Promise<ResearchSection> {
  // HackerNews Algolia API
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(topic)}&tags=story&hitsPerPage=5`;

  printFree('HackerNews — community discussions');

  const res = await fetchFree(url);
  if (!res || res.status !== 200) {
    return {
      title: 'Community Discussions',
      content: null,
      source: 'HackerNews',
      sourceUrl: url,
      isFree: true,
      costUsd: 0,
      error: `HTTP ${res?.status ?? 'timeout'}`,
    };
  }

  const data = JSON.parse(res.body);
  const hits = (data.hits ?? []).filter((h: Record<string, unknown>) => h['title'] && h['points']);

  if (hits.length === 0) {
    return {
      title: 'Community Discussions',
      content: 'No HackerNews discussions found for this topic.',
      source: 'HackerNews',
      sourceUrl: url,
      isFree: true,
      costUsd: 0,
    };
  }

  const content = hits
    .slice(0, 5)
    .map(
      (h: Record<string, unknown>) =>
        `- [${h['title']}](https://news.ycombinator.com/item?id=${h['objectID']}) ` +
        `— ${h['points']} points, ${h['num_comments']} comments (${new Date(h['created_at'] as string).getFullYear()})`
    )
    .join('\n');

  printSuccess(`HackerNews: ${hits.length} discussions found`);

  return {
    title: 'Community Discussions',
    content,
    source: 'HackerNews (via Algolia)',
    sourceUrl: `https://news.ycombinator.com/search?q=${encodeURIComponent(topic)}`,
    isFree: true,
    costUsd: 0,
  };
}

async function fetchNpmPackages(topic: string): Promise<ResearchSection> {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(topic)}&size=5`;

  printFree('npm — related packages');

  const res = await fetchFree(url);
  if (!res || res.status !== 200) {
    return {
      title: 'Related npm Packages',
      content: null,
      source: 'npm Registry',
      sourceUrl: url,
      isFree: true,
      costUsd: 0,
      error: `HTTP ${res?.status ?? 'timeout'}`,
    };
  }

  const data = JSON.parse(res.body);
  const packages = (data.objects ?? []).slice(0, 5);

  if (packages.length === 0) {
    return {
      title: 'Related npm Packages',
      content: 'No npm packages found for this topic.',
      source: 'npm',
      sourceUrl: url,
      isFree: true,
      costUsd: 0,
    };
  }

  const content = packages
    .map(
      (p: { package: Record<string, unknown>; score: Record<string, unknown> }) =>
        `- **[${p.package['name']}](https://www.npmjs.com/package/${p.package['name']})** ` +
        `v${p.package['version']} — ${p.package['description'] ?? 'No description'}\n` +
        `  Weekly downloads: ${(p.package as Record<string, unknown>)['weeklyDownloads'] ?? 'N/A'}`
    )
    .join('\n');

  printSuccess(`npm: ${packages.length} packages found`);

  return {
    title: 'Related npm Packages',
    content,
    source: 'npm Registry',
    sourceUrl: `https://www.npmjs.com/search?q=${encodeURIComponent(topic)}`,
    isFree: true,
    costUsd: 0,
  };
}

// ─── Paid source fetchers ────────────────────────────────────────────────────

async function fetchPaidSentimentAnalysis(
  topic: string,
  wallet: ReturnType<typeof createScriptWallet>
): Promise<ResearchSection> {
  const endpointUrl = getDemoEndpointUrl();
  const costUsd = 0.01;

  if (isMockMode()) {
    const mockData = JSON.parse(getMockSentimentData(topic));
    return {
      title: 'Market Sentiment Analysis',
      content:
        `**Overall Sentiment:** ${mockData.label} (score: ${mockData.sentiment_score})\n\n` +
        `Based on analysis of ${mockData.sample_size} data points.\n\n` +
        `_Note: Mock data — set X402_DEMO_URL to a live endpoint for real analysis._`,
      source: 'x402 Demo (mock)',
      sourceUrl: endpointUrl,
      isFree: false,
      costUsd: 0,
    };
  }

  const result = await withRetry(
    () =>
      fetchWithPayment(wallet, endpointUrl, {
        maxPaymentUsd: costUsd * 1.5,
      }),
    { maxAttempts: 2, initialDelayMs: 1000, maxDelayMs: 5000 }
  );

  let content: string;
  try {
    const data = JSON.parse(result.body);
    content =
      `**Overall Sentiment:** ${data.sentiment?.overall ?? data.market_sentiment ?? 'N/A'}\n` +
      `**Fear & Greed Index:** ${data.sentiment?.fear_greed_index ?? data.fear_greed ?? 'N/A'}\n` +
      `**BTC Dominance:** ${data.dominance?.btc_pct ?? 'N/A'}%\n\n` +
      `_Source: ${endpointUrl} (paid, $${result.amountPaidUsd.toFixed(4)})_`;
  } catch {
    content = result.body.slice(0, 500);
  }

  return {
    title: 'Market Sentiment Analysis',
    content,
    source: 'x402 Premium Data',
    sourceUrl: endpointUrl,
    isFree: false,
    costUsd: result.amountPaidUsd,
  };
}

// ─── Gap analysis ────────────────────────────────────────────────────────────

interface ResearchGap {
  title: string;
  reason: string;
  paidSourceName: string;
  estimatedCostUsd: number;
}

function identifyGaps(sections: ResearchSection[], topic: string): ResearchGap[] {
  const gaps: ResearchGap[] = [];

  const hasOverview = sections.some((s) => s.content && s.title === 'Overview');
  const hasProjects = sections.some((s) => s.content && s.title.includes('Project'));
  const hasDiscussions = sections.some((s) => s.content && s.title.includes('Discussion'));

  // Sentiment/market data is always a "gap" if not already fetched
  const hasSentiment = sections.some(
    (s) => s.content && s.title.toLowerCase().includes('sentiment')
  );

  if (!hasSentiment) {
    gaps.push({
      title: 'Market Sentiment Analysis',
      reason: 'No quantitative sentiment data gathered from free sources',
      paidSourceName: 'x402 Premium Data API',
      estimatedCostUsd: 0.01,
    });
  }

  // If Wikipedia failed, we have an overview gap but no paid source for it
  if (!hasOverview) {
    printWarning('Gap: No background overview found — Wikipedia may have limited coverage for this topic');
  }

  if (!hasProjects) {
    printWarning('Gap: No related projects found — try a broader search term');
  }

  if (!hasDiscussions) {
    printWarning('Gap: No community discussions found — topic may be very new');
  }

  return gaps;
}

// ─── Report builder ──────────────────────────────────────────────────────────

function buildMarkdownReport(report: ResearchReport): string {
  const lines: string[] = [
    `# Research Report: ${report.topic}`,
    '',
    `> Generated by **agentpay-value-packs research-agent** on ${report.generatedAt}`,
    '',
    '---',
    '',
    '## Table of Contents',
    '',
    ...report.sections
      .filter((s) => s.content)
      .map((s, i) => `${i + 1}. [${s.title}](#${s.title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')})`),
    '',
    '---',
    '',
  ];

  for (const section of report.sections) {
    lines.push(`## ${section.title}`);
    lines.push('');

    if (!section.content) {
      lines.push(`_Data unavailable: ${section.error ?? 'unknown error'}_`);
    } else {
      lines.push(section.content);
    }

    lines.push('');
    lines.push(
      `**Source:** [${section.source}](${section.sourceUrl}) — ` +
        (section.isFree ? '🆓 Free' : `💳 Paid ($${section.costUsd.toFixed(4)})`)
    );
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Cost breakdown
  lines.push('## Cost Breakdown');
  lines.push('');
  lines.push('| Source | Type | Cost |');
  lines.push('|--------|------|------|');
  for (const section of report.sections) {
    const type = section.isFree ? '🆓 Free' : '💳 Paid';
    const cost = section.isFree ? '$0.0000' : `$${section.costUsd.toFixed(4)}`;
    lines.push(`| ${section.source} | ${type} | ${cost} |`);
  }
  lines.push('');
  lines.push(
    `**Total:** ${report.freeSources} free source(s), ${report.paidSources} paid source(s), ` +
      `**$${report.totalCostUsd.toFixed(4)} spent**`
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_Built with [agentpay-mcp](https://github.com/up2itnow0822/agentpay-mcp) and [agentwallet-sdk](https://github.com/up2itnow0822/agentpay-mcp)_');

  return lines.join('\n');
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { topic, noPaid, outputDir } = parseArgs();

  printHeader(`Research Agent — "${topic}"`);

  printSection('Wallet Config');
  printWalletStatus();

  const policy = new PolicyGuard({ dailyCapUsd: DAILY_CAP_USD });
  const cache = new FileCache({ ttlMs: 2 * 60 * 60 * 1000 }); // 2-hour cache for research

  cache.prune();

  let wallet: ReturnType<typeof createScriptWallet> | null = null;
  if (!noPaid) {
    try {
      wallet = createScriptWallet();
    } catch {
      printWarning('Wallet not configured — running in free-only mode');
    }
  } else {
    printInfo('Mode:', 'Free-only (--no-paid flag set)');
  }

  let completed = false;
  const sections: ResearchSection[] = [];

  installShutdownHandler(() => {
    if (!completed && sections.length > 0) {
      console.log('\n\nPartial results captured before shutdown:');
      sections.forEach((s) => console.log(`  - ${s.title}: ${s.content ? 'OK' : 'failed'}`));
    }
  });

  // ── Phase 1: Free sources ─────────────────────────────────────────────────

  printSection('Phase 1: Free Sources');
  console.log(`  Fetching background data — no payment required\n`);

  const freeFetchers = [
    () => fetchWikipedia(topic),
    () => fetchGitHubProjects(topic),
    () => fetchHackerNewsDiscussions(topic),
    () => fetchNpmPackages(topic),
  ];

  for (let i = 0; i < freeFetchers.length; i++) {
    printStep(i + 1, freeFetchers.length, 'Fetching...');
    try {
      const section = await freeFetchers[i]!();
      sections.push(section);
    } catch (err) {
      printError(`Fetch error: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Be a polite citizen — brief pause between API calls
    await sleep(300);
  }

  // ── Phase 2: Gap analysis ─────────────────────────────────────────────────

  printSection('Phase 2: Gap Analysis');
  const gaps = identifyGaps(sections, topic);

  if (gaps.length === 0) {
    printSuccess('No gaps detected — free sources provide comprehensive coverage');
  } else {
    console.log(`  Found ${gaps.length} gap(s) that paid sources can fill:\n`);
    gaps.forEach((gap, i) => {
      printPaid(`${gap.title} via ${gap.paidSourceName}`, gap.estimatedCostUsd);
      console.log(`    Reason: ${gap.reason}`);
    });
  }

  // ── Phase 3: Paid sources (with approval) ─────────────────────────────────

  if (gaps.length > 0 && !noPaid && wallet) {
    printSection('Phase 3: Paid Sources — Budget Planning');

    const planSteps = [
      ...sections.map((s) => ({ name: s.title, cost: 0, free: true })),
      ...gaps.map((g) => ({ name: g.title, cost: g.estimatedCostUsd, free: false })),
    ];

    const approved = await requestPlanApproval({
      steps: planSteps,
      totalCostUsd: gaps.reduce((sum, g) => sum + g.estimatedCostUsd, 0),
      dailyCapUsd: policy.config.dailyCapUsd,
    });

    if (approved) {
      printSection('Fetching Paid Data');

      for (let i = 0; i < gaps.length; i++) {
        const gap = gaps[i]!;
        printStep(i + 1, gaps.length, gap.title);

        try {
          policy.checkCanSpend(gap.estimatedCostUsd, gap.paidSourceName);
        } catch (policyErr) {
          if (policyErr instanceof PolicyError) {
            printError(`Policy: ${policyErr.message}`);
            continue;
          }
          throw policyErr;
        }

        try {
          const section = await fetchPaidSentimentAnalysis(topic, wallet);
          policy.record(section.costUsd, gap.paidSourceName, true);
          sections.push(section);
          printSuccess(`${gap.title}: fetched ($${section.costUsd.toFixed(4)})`);
        } catch (err) {
          const settled = settledPaymentAmount(err);
          if (settled !== null) {
            policy.record(settled, gap.paidSourceName, true);
          }
          printError(
            err instanceof PaymentAwareError
              ? `Payment settled but fetch failed; not retrying: ${err.message}`
              : `Failed: ${err instanceof Error ? err.message : String(err)}`
          );
          // Don't push a failed section — gap remains unfilled
        }
      }
    } else {
      printWarning('Paid sources skipped by user');
    }
  } else if (noPaid) {
    printInfo('Paid phase:', 'Skipped (--no-paid)');
  } else if (!wallet) {
    printInfo('Paid phase:', 'Skipped (no wallet configured)');
  }

  // ── Phase 4: Compile report ───────────────────────────────────────────────

  printSection('Phase 4: Compiling Report');

  const totalCostUsd = sections.filter((s) => !s.isFree).reduce((sum, s) => sum + s.costUsd, 0);
  const freeSources = sections.filter((s) => s.isFree).length;
  const paidSources = sections.filter((s) => !s.isFree).length;

  const report: ResearchReport = {
    topic,
    generatedAt: new Date().toISOString(),
    sections,
    totalCostUsd,
    freeSources,
    paidSources,
  };

  const markdown = buildMarkdownReport(report);

  // Write to file
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const safeTopic = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${safeTopic}-${timestamp}.md`;
  const filePath = path.join(outputDir, filename);

  fs.writeFileSync(filePath, markdown, 'utf8');
  printSuccess(`Report written to: ${filePath}`);

  // Console preview
  printSection('Report Preview');
  const previewLines = markdown.split('\n').slice(0, 20);
  console.log(previewLines.map((l) => `  ${l}`).join('\n'));
  if (markdown.split('\n').length > 20) {
    console.log(`  ${dim('... (see full report in file)')}`);
  }

  // Cost summary
  printCostBreakdown({ freeSources, paidSources, totalCostUsd });
  completed = true;

  console.log('\n');
}

main().catch((err) => {
  printError(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
