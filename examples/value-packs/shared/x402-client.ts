/**
 * shared/x402-client.ts — x402 protocol client
 *
 * Handles:
 *  - 402 Payment Required detection
 *  - Payment amount parsing from WWW-Authenticate headers
 *  - Payment construction via agentwallet-sdk
 *  - Automatic retry after payment
 *  - Configurable fallback to mock data when demo endpoint is unavailable
 *
 * This is the core payment primitive all value packs build on.
 */
import { createX402Client } from 'agentwallet-sdk';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import { createWallet } from 'agentwallet-sdk';
import { parsePaymentAmountUsd } from './spending-policy.js';
import { printInfo, printSuccess, printWarning, printError } from './ui.js';
import { wrapPaymentFailure } from './payment-retry.js';

export {
  PaymentAwareError,
  isPaymentAwareError,
  settledPaymentAmount,
  wrapPaymentFailure,
  withRetry,
  sleep,
} from './payment-retry.js';
export type { RetryOptions, PaymentAttemptState } from './payment-retry.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface X402Config {
  /** Agent wallet private key (0x-prefixed). Reads AGENT_PRIVATE_KEY env by default. */
  privateKey?: string;
  /** AgentAccount contract address. Reads AGENT_WALLET_ADDRESS env by default. */
  walletAddress?: string;
  /** Chain ID: 8453 (Base Mainnet) or 84532 (Base Sepolia). Default: 84532 for testing. */
  chainId?: number;
  /** RPC URL. Defaults to public Base Sepolia endpoint. */
  rpcUrl?: string;
}

export interface FetchResult {
  /** HTTP status code */
  status: number;
  /** Response body text */
  body: string;
  /** Whether an x402 payment was made */
  paymentMade: boolean;
  /** Amount paid in USD (if payment was made) */
  amountPaidUsd: number;
  /** Transaction hash (if payment was made) */
  txHash?: string;
  /** Whether this result came from fallback (no payment) */
  isFallback?: boolean;
}

export interface PaymentInfo {
  amountUsd: number;
  token: string;
  recipient: string;
  network: string;
}

// ─── 402 Detection ────────────────────────────────────────────────────────

/**
 * Make a probe request to check if an endpoint requires payment.
 * Returns null if the endpoint is freely accessible, or payment info if gated.
 */
export async function probeEndpoint(
  url: string,
  timeoutMs = 10000
): Promise<PaymentInfo | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status !== 402) {
      return null; // Free endpoint
    }

    // Parse payment requirements from WWW-Authenticate header
    const wwwAuth = response.headers.get('www-authenticate') ?? '';
    const amountUsd = parsePaymentAmountUsd(wwwAuth) ?? 0.01; // default to 1 cent if unparseable

    return {
      amountUsd,
      token: extractHeaderField(wwwAuth, 'token') ?? 'USDC',
      recipient: extractHeaderField(wwwAuth, 'recipient') ?? 'unknown',
      network: extractHeaderField(wwwAuth, 'network') ?? 'base-sepolia',
    };
  } catch {
    return null; // Network error — treat as unavailable
  }
}

// ─── Wallet creation ───────────────────────────────────────────────────────

/**
 * Create a lightweight wallet instance for standalone scripts.
 * Uses environment variables or passed config.
 */
export function createScriptWallet(config: X402Config = {}) {
  const privateKey = config.privateKey ?? process.env['AGENT_PRIVATE_KEY'];
  const walletAddress = config.walletAddress ?? process.env['AGENT_WALLET_ADDRESS'];

  if (!privateKey) {
    throw new Error(
      'No wallet private key found.\n' +
      'Set AGENT_PRIVATE_KEY environment variable or pass privateKey in config.\n' +
      'Example: AGENT_PRIVATE_KEY=0x... npx tsx paid-api-agent.ts'
    );
  }

  if (!walletAddress) {
    throw new Error(
      'No wallet address found.\n' +
      'Set AGENT_WALLET_ADDRESS environment variable or pass walletAddress in config.\n' +
      'Get your wallet address from: npx agentpay-mcp wallet'
    );
  }

  const chainId = config.chainId ?? parseInt(process.env['CHAIN_ID'] ?? '84532', 10);
  const chain = chainId === 8453 ? base : baseSepolia;
  const rpcUrl =
    config.rpcUrl ??
    process.env['RPC_URL'] ??
    (chainId === 8453 ? 'https://mainnet.base.org' : 'https://sepolia.base.org');

  const chainName = chainId === 8453 ? 'base' : ('base-sepolia' as const);

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  return createWallet({
    accountAddress: walletAddress as `0x${string}`,
    chain: chainName,
    rpcUrl,
    walletClient,
  });
}

// ─── Payment fetch ─────────────────────────────────────────────────────────

export interface PaymentCallbacks {
  onPaymentRequired?: (amountUsd: number, url: string) => void;
  onPaymentComplete?: (amountUsd: number, txHash: string) => void;
}

/**
 * Fetch a URL, automatically handling x402 payment if required.
 * Assumes the caller has already obtained user approval.
 */
export async function fetchWithPayment(
  wallet: ReturnType<typeof createScriptWallet>,
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    maxPaymentUsd?: number;
    timeoutMs?: number;
    callbacks?: PaymentCallbacks;
  } = {}
): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  let paymentInitiated = false;
  let paymentMade = false;
  let amountPaidUsd = 0;
  let txHash: string | undefined;

  const maxPaymentWei = opts.maxPaymentUsd
    ? BigInt(Math.round(opts.maxPaymentUsd * 1e18))
    : undefined;

  const x402Client = createX402Client(wallet, {
    autoPay: true,
    maxRetries: 1,
    globalPerRequestMax: maxPaymentWei,
    onBeforePayment: (req: { amount: string | number | bigint }, _url: string) => {
      paymentInitiated = true;
      const amountWei = BigInt(req.amount);
      // Approximate USD from wei (ETH price rough estimate); for USDC it's direct
      const estimatedUsd = Number(amountWei) / 1e6; // USDC path
      if (opts.callbacks?.onPaymentRequired) {
        opts.callbacks.onPaymentRequired(estimatedUsd, url);
      }
      return true; // Caller has already obtained approval
    },
    onPaymentComplete: (log: { amount: bigint | string; txHash: string }) => {
      paymentMade = true;
      amountPaidUsd = Number(BigInt(log.amount)) / 1e6; // USDC
      txHash = log.txHash;
      if (opts.callbacks?.onPaymentComplete) {
        opts.callbacks.onPaymentComplete(amountPaidUsd, log.txHash);
      }
    },
  });

  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    ...(opts.headers ?? {}),
  };

  try {
    const response = await x402Client.fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      ...(opts.body ? { body: opts.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = await response.text();

    return {
      status: response.status,
      body,
      paymentMade,
      amountPaidUsd,
      txHash,
    };
  } catch (err) {
    wrapPaymentFailure(err, {
      paymentInitiated,
      paymentMade,
      amountPaidUsd,
      txHash,
    });
  }
}

// ─── Free fetch ────────────────────────────────────────────────────────────

/**
 * Simple fetch wrapper for free endpoints. No payment logic.
 * Returns null on network error.
 */
export async function fetchFree(
  url: string,
  opts: {
    headers?: Record<string, string>;
    timeoutMs?: number;
  } = {}
): Promise<{ status: number; body: string } | null> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'agentpay-value-packs/1.0',
        ...(opts.headers ?? {}),
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    });
    const body = await response.text();
    return { status: response.status, body };
  } catch {
    return null;
  }
}

// ─── Mock fallback ────────────────────────────────────────────────────────

/**
 * Generate plausible mock data for demo endpoints that aren't live yet.
 * Used only when DEMO_ENDPOINT_URL is set to "mock" or the endpoint returns 5xx.
 */
export function getMockMarketData(): string {
  const btcPrice = 95000 + Math.random() * 5000;
  const ethPrice = 3200 + Math.random() * 200;
  const sentiment = Math.random() > 0.5 ? 'bullish' : 'bearish';
  const fearGreed = Math.floor(Math.random() * 40) + 40; // 40–80

  return JSON.stringify({
    _mock: true,
    _note: 'Mock data — demo endpoint not reachable. Set X402_DEMO_URL to use real endpoint.',
    timestamp: new Date().toISOString(),
    btc: {
      price_usd: parseFloat(btcPrice.toFixed(2)),
      change_24h_pct: parseFloat(((Math.random() - 0.45) * 8).toFixed(2)),
      volume_24h_usd: Math.floor(btcPrice * 350000),
    },
    eth: {
      price_usd: parseFloat(ethPrice.toFixed(2)),
      change_24h_pct: parseFloat(((Math.random() - 0.45) * 10).toFixed(2)),
    },
    sentiment: {
      overall: sentiment,
      fear_greed_index: fearGreed,
      label: fearGreed < 25 ? 'Extreme Fear' : fearGreed < 45 ? 'Fear' : fearGreed < 55 ? 'Neutral' : fearGreed < 75 ? 'Greed' : 'Extreme Greed',
    },
    dominance: {
      btc_pct: parseFloat((45 + Math.random() * 15).toFixed(1)),
    },
  });
}

export function getMockSentimentData(topic: string): string {
  const score = parseFloat((Math.random() * 2 - 1).toFixed(3));
  return JSON.stringify({
    _mock: true,
    topic,
    sentiment_score: score,
    label: score > 0.3 ? 'positive' : score < -0.3 ? 'negative' : 'neutral',
    sample_size: Math.floor(Math.random() * 500) + 100,
    timestamp: new Date().toISOString(),
  });
}

// ─── Header parsing helper ─────────────────────────────────────────────────

function extractHeaderField(header: string, field: string): string | null {
  const regex = new RegExp(`${field}=([^,\\s]+)`);
  const match = header.match(regex);
  return match?.[1] ?? null;
}

// ─── Environment config ────────────────────────────────────────────────────

/** Get the configured demo endpoint URL, or the default. */
export function getDemoEndpointUrl(): string {
  return process.env['X402_DEMO_URL'] ?? 'https://x402-demo.vercel.app/api/market-data';
}

/** Returns true if the demo endpoint is configured as mock. */
export function isMockMode(): boolean {
  return process.env['X402_DEMO_URL'] === 'mock';
}

/** Display wallet config status without revealing private key. */
export function printWalletStatus(config: X402Config = {}): void {
  const hasKey = !!(config.privateKey ?? process.env['AGENT_PRIVATE_KEY']);
  const hasAddr = !!(config.walletAddress ?? process.env['AGENT_WALLET_ADDRESS']);
  const chainId = config.chainId ?? parseInt(process.env['CHAIN_ID'] ?? '84532', 10);

  printInfo('Wallet key:', hasKey ? '✓ set (redacted)' : '✗ NOT SET');
  printInfo('Wallet addr:', hasAddr ? '✓ set' : '✗ NOT SET');
  printInfo('Chain:', chainId === 8453 ? 'Base Mainnet' : 'Base Sepolia (testnet)');

  if (!hasKey || !hasAddr) {
    printWarning('Wallet not configured — paid endpoints will be skipped.');
    printWarning('Set AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS to enable payments.');
  }
}
