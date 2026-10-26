/**
 * shared/x402-client.ts — x402 protocol client
 *
 * Handles:
 *  - 402 Payment Required detection
 *  - Verified USDC offer parsing from x402 PAYMENT-REQUIRED payloads
 *  - Binding each payment to a single-use, immutable approval record
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
import { printInfo, printWarning, printError } from './ui.js';
import { wrapPaymentFailure } from './payment-retry.js';
import {
  ApprovalRejectedError,
  MAINNET_OPT_IN_ENV,
  VALUE_PACK_NETWORKS,
  canonicalEndpoint,
  consumePaymentApproval,
  createApprovalGuard,
  createPaymentApproval,
  decodePaymentRequiredHeader,
  formatUsdcBaseUnits,
  isApprovalConsumed,
  resolveValuePackNetwork,
  selectUsdcOffer,
  usdcBaseUnitsToUsdNumber,
  withX402ProtocolFee,
} from './usdc-approval.js';
import type {
  PaymentApproval,
  ValuePackNetwork,
  ValuePackNetworkId,
  VerifiedUsdcOffer,
} from './usdc-approval.js';

export {
  PaymentAwareError,
  isPaymentAwareError,
  settledPaymentAmount,
  wrapPaymentFailure,
  withRetry,
  sleep,
} from './payment-retry.js';
export type { RetryOptions, PaymentAttemptState } from './payment-retry.js';

export {
  ApprovalRejectedError,
  createPaymentApproval,
  isApprovalConsumed,
  usdToUsdcBaseUnits,
  formatUsdcBaseUnits,
  MAINNET_OPT_IN_ENV,
} from './usdc-approval.js';
export type { PaymentApproval, ValuePackNetwork } from './usdc-approval.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface X402Config {
  /** Agent wallet private key (0x-prefixed). Reads AGENT_PRIVATE_KEY env by default. */
  privateKey?: string;
  /** AgentAccount contract address. Reads AGENT_WALLET_ADDRESS env by default. */
  walletAddress?: string;
  /**
   * Chain ID: 84532 (Base Sepolia, default) or 8453 (Base Mainnet).
   * Mainnet additionally requires VALUE_PACK_ALLOW_MAINNET=1.
   */
  chainId?: number;
  /** RPC URL. Defaults to the public endpoint of the selected network. */
  rpcUrl?: string;
}

export interface FetchResult {
  /** HTTP status code */
  status: number;
  /** Response body text */
  body: string;
  /** Whether an x402 payment was made */
  paymentMade: boolean;
  /** Amount paid in USD — display/budget accounting only (lossy float). */
  amountPaidUsd: number;
  /** Exact payee amount paid, in USDC base units (0n when no payment). */
  amountPaidBaseUnits: bigint;
  /** Transaction hash (if payment was made) */
  txHash?: string;
  /** Whether this result came from fallback (no payment) */
  isFallback?: boolean;
}

interface PaymentInfoBase {
  endpoint: string;
  method: string;
  network: ValuePackNetworkId;
}

/** A 402 whose offer is exact USDC on the configured network and can be approved. */
export interface PayablePaymentInfo extends PaymentInfoBase {
  payable: true;
  /** The verified offer to bind into a PaymentApproval. */
  offer: VerifiedUsdcOffer;
  /** Exact decimal string of the offer, e.g. "0.010000". */
  amountUsdc: string;
  /** Display/budget-accounting value only (lossy float). */
  amountUsd: number;
  token: 'USDC';
  recipient: string;
}

/** A 402 the value packs refuse to pay (unknown asset, other network, malformed). */
export interface UnpayablePaymentInfo extends PaymentInfoBase {
  payable: false;
  reason: string;
}

export type PaymentInfo = PayablePaymentInfo | UnpayablePaymentInfo;

// ─── Network ──────────────────────────────────────────────────────────────

/**
 * The network every payment in this process is bound to. Base Sepolia by
 * default; Base Mainnet only with CHAIN_ID=8453 AND VALUE_PACK_ALLOW_MAINNET=1.
 */
export function getConfiguredNetwork(config: X402Config = {}): ValuePackNetwork {
  return resolveValuePackNetwork(config.chainId);
}

// ─── 402 Detection ────────────────────────────────────────────────────────

/**
 * Make a probe request to check if an endpoint requires payment.
 * Returns null if the endpoint is not 402-gated (or unreachable). For a 402,
 * returns the verified USDC offer, or `payable: false` with the reason the
 * offer is refused. Nothing here is trusted until it is bound into a
 * PaymentApproval and re-checked against the final offer.
 */
export async function probeEndpoint(
  url: string,
  timeoutMs = 10000,
  opts: { method?: string; network?: ValuePackNetwork } = {}
): Promise<PaymentInfo | null> {
  const network = opts.network ?? getConfiguredNetwork();
  const method = (opts.method ?? 'GET').toUpperCase();
  const endpoint = canonicalEndpoint(url);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null; // Network error — treat as unavailable
  }

  if (response.status !== 402) {
    return null; // Free endpoint
  }

  const base = { endpoint, method, network: network.network };
  const header =
    response.headers.get('payment-required') ?? response.headers.get('x-payment-required');
  let paymentRequired: unknown = header ? decodePaymentRequiredHeader(header) : null;
  if (!paymentRequired) {
    try {
      paymentRequired = JSON.parse(await response.text());
    } catch {
      paymentRequired = null;
    }
  }

  const selection = selectUsdcOffer(paymentRequired, network);
  if (!selection.offer) {
    return { ...base, payable: false, reason: selection.reason };
  }
  const offer = selection.offer;
  return {
    ...base,
    payable: true,
    offer,
    amountUsdc: formatUsdcBaseUnits(offer.amount),
    amountUsd: usdcBaseUnitsToUsdNumber(offer.amount),
    token: 'USDC',
    recipient: offer.payTo,
  };
}

/**
 * Bind a probed offer into the single immutable, single-use approval record.
 * `capUsd` is a decimal string ceiling (e.g. "0.01"); the probed amount must
 * not exceed it. Throws ApprovalRejectedError (fail closed) otherwise.
 */
export function approveProbedPayment(info: PaymentInfo, capUsd: string): PaymentApproval {
  if (!info.payable) {
    throw new ApprovalRejectedError(info.reason);
  }
  return createPaymentApproval({
    endpoint: info.endpoint,
    method: info.method,
    network: info.network,
    asset: info.offer.asset,
    payTo: info.offer.payTo,
    amount: info.offer.amount,
    capUsd,
  });
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

  // Fails closed for unknown chains and for mainnet without the explicit opt-in.
  const network = getConfiguredNetwork(config);
  const chain = network.chainId === 8453 ? base : baseSepolia;
  const rpcUrl = config.rpcUrl ?? process.env['RPC_URL'] ?? network.defaultRpcUrl;

  if (network.isMainnet) {
    printWarning(`!!! ${network.label}: payments move REAL USDC (${MAINNET_OPT_IN_ENV}=1 is set) !!!`);
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });

  return createWallet({
    accountAddress: walletAddress as `0x${string}`,
    chain: network.chainName,
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
 * Fetch a URL, paying an x402 challenge only if it matches `approval`.
 *
 * The approval (from approveProbedPayment / createPaymentApproval) is the
 * only authority: the final offer's endpoint, method, network, USDC asset,
 * payTo and exact amount must equal it, and the amount must not exceed its
 * cap. Any mismatch returns false from onBeforePayment, so nothing is signed,
 * and this function throws ApprovalRejectedError. The approval is single-use.
 */
export async function fetchWithPayment(
  wallet: ReturnType<typeof createScriptWallet>,
  url: string,
  opts: {
    approval: PaymentApproval;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    callbacks?: PaymentCallbacks;
  }
): Promise<FetchResult> {
  const { approval } = opts;
  const timeoutMs = opts.timeoutMs ?? 30000;
  const method = (opts.method ?? 'GET').toUpperCase();
  let paymentInitiated = false;
  let paymentMade = false;
  let offerEvaluated = false;
  let rejection: string | null = null;
  let amountPaidBaseUnits = 0n;
  let amountPaidUsd = 0;
  let txHash: string | undefined;

  // ── Pre-flight: the request itself must be the one that was approved ──
  if (isApprovalConsumed(approval)) {
    throw new ApprovalRejectedError('approval already used (single-use); probe and approve again');
  }
  const preflight: string[] = [];
  if (canonicalEndpoint(url) !== approval.endpoint) preflight.push(`endpoint ${url} != ${approval.endpoint}`);
  if (method !== approval.method) preflight.push(`method ${method} != ${approval.method}`);
  const walletChainId = wallet.chain?.id;
  if (walletChainId !== VALUE_PACK_NETWORKS[approval.network].chainId) {
    preflight.push(`wallet chain ${String(walletChainId)} != approved network ${approval.network}`);
  }
  if (preflight.length > 0) {
    consumePaymentApproval(approval);
    throw new ApprovalRejectedError(preflight.join('; '));
  }

  const usdc = VALUE_PACK_NETWORKS[approval.network].usdc;
  // Exact debit of this one approved payment (payee amount + SDK protocol fee).
  const approvedDebit = withX402ProtocolFee(approval.amount);
  const guard = createApprovalGuard(
    approval,
    method,
    (reason) => {
      rejection = reason;
    },
    () => {
      paymentInitiated = true;
      if (opts.callbacks?.onPaymentRequired) {
        opts.callbacks.onPaymentRequired(usdcBaseUnitsToUsdNumber(approval.amount), url);
      }
    }
  );

  const x402Client = createX402Client(wallet, {
    autoPay: true,
    maxRetries: 1,
    // Only the configured network and its canonical USDC are payable.
    supportedNetworks: [approval.network],
    supportedAssets: { [approval.network]: [usdc] },
    // Defence in depth: this client can debit at most one approved payment.
    globalPerRequestMax: approvedDebit,
    globalDailyLimit: approvedDebit,
    onBeforePayment: (req, reqUrl) => {
      offerEvaluated = true;
      return guard(req, reqUrl);
    },
    onPaymentComplete: (log) => {
      const paid = BigInt(log.amount);
      paymentMade = true;
      amountPaidBaseUnits = paid;
      amountPaidUsd = usdcBaseUnitsToUsdNumber(paid);
      txHash = log.txHash;
      if (
        paid !== approval.amount ||
        String(log.recipient).toLowerCase() !== approval.payTo ||
        String(log.token).toLowerCase() !== approval.asset
      ) {
        printError('Settled payment does not match the approval record — investigate this transaction.');
      }
      if (opts.callbacks?.onPaymentComplete) {
        opts.callbacks.onPaymentComplete(amountPaidUsd, log.txHash);
      }
    },
  });

  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    ...(opts.headers ?? {}),
  };

  let response: Response;
  try {
    response = await x402Client.fetch(url, {
      method,
      headers,
      ...(opts.body ? { body: opts.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (offerEvaluated) consumePaymentApproval(approval);
    if (err instanceof Error && err.name === 'X402BudgetExceededError') {
      // The offer's debit exceeds this one approved payment, so its amount
      // cannot equal the approved amount. Nothing was signed.
      consumePaymentApproval(approval);
      throw new ApprovalRejectedError(`final offer exceeds the approved amount: ${err.message}`);
    }
    wrapPaymentFailure(err, {
      paymentInitiated,
      paymentMade,
      amountPaidUsd,
      txHash,
    });
  }

  // A challenge was answered (or refused): the approval cannot be reused.
  if (offerEvaluated || response.status === 402) consumePaymentApproval(approval);

  if (rejection !== null) {
    throw new ApprovalRejectedError(`final offer does not match approval: ${rejection}`);
  }
  if (response.status === 402 && !paymentMade) {
    throw new ApprovalRejectedError(
      `endpoint still demands payment, but no offer matched the approved USDC terms on ${approval.network}`
    );
  }

  const body = await response.text();
  return {
    status: response.status,
    body,
    paymentMade,
    amountPaidUsd,
    amountPaidBaseUnits,
    txHash,
  };
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

  printInfo('Wallet key:', hasKey ? '✓ set (redacted)' : '✗ NOT SET');
  printInfo('Wallet addr:', hasAddr ? '✓ set' : '✗ NOT SET');
  try {
    const network = getConfiguredNetwork(config);
    printInfo('Chain:', network.label);
    printInfo('Pay asset:', `USDC ${network.usdc} only`);
    if (network.isMainnet) {
      printWarning(`!!! MAINNET: real USDC will be spent (${MAINNET_OPT_IN_ENV}=1) !!!`);
    }
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
  }

  if (!hasKey || !hasAddr) {
    printWarning('Wallet not configured — paid endpoints will be skipped.');
    printWarning('Set AGENT_PRIVATE_KEY and AGENT_WALLET_ADDRESS to enable payments.');
  }
}
