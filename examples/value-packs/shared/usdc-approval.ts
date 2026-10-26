/**
 * shared/usdc-approval.ts — exact USDC caps and single-use payment approvals
 *
 * The value packs only ever pay in USDC on the configured Base network, and
 * every payment is bound to one immutable approval record:
 *
 *  1. Caps are decimal strings ("0.01") converted to USDC base units with
 *     exact integer math. No floating point touches the authorization path.
 *  2. Only the canonical USDC contract of the configured network is accepted.
 *     Symbols ("USDC"), other tokens, and other networks fail closed.
 *  3. The probe/approval step produces a frozen PaymentApproval
 *     (endpoint, method, network, asset, payTo, amount). The final 402 offer
 *     seen by onBeforePayment must match every field exactly, and must not
 *     exceed the cap.
 *  4. An approval is consumed by its first evaluation (accepted or rejected),
 *     so it can authorize at most one payment.
 *
 * Mainnet requires CHAIN_ID=8453 *and* VALUE_PACK_ALLOW_MAINNET=1.
 */

// ─── USDC amounts ──────────────────────────────────────────────────────────

/** USDC uses 6 decimals on Base and Base Sepolia (verified in agentwallet-sdk's token registry). */
export const USDC_DECIMALS = 6;
const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS);

/** x402 protocol fee charged by agentwallet-sdk on top of the payee amount (0.77%). */
const X402_PROTOCOL_FEE_BPS = 77n;

/**
 * Convert a USD decimal string to USDC base units (6 decimals), exactly.
 *
 *   usdToUsdcBaseUnits("0.01")     === 10_000n
 *   usdToUsdcBaseUnits("1.234567") === 1_234_567n
 *
 * Rejects numbers, negatives, NaN/Infinity, exponents, empty strings, zero,
 * and more than 6 fractional digits (which cannot be represented in USDC).
 */
export function usdToUsdcBaseUnits(usd: string): bigint {
  if (typeof usd !== 'string') {
    throw new TypeError('USD cap must be a decimal string such as "0.01" (numbers are not accepted)');
  }
  const fractional = /^(0|[1-9]\d*)\.(\d+)$/.exec(usd);
  if (fractional && fractional[2]!.length > USDC_DECIMALS) {
    throw new RangeError(
      `USD cap "${usd}" has more than ${USDC_DECIMALS} fractional digits; USDC cannot represent it`
    );
  }
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(usd);
  if (!match) {
    throw new RangeError(`USD cap "${usd}" is not a non-negative decimal string such as "0.01"`);
  }
  const whole = BigInt(match[1]!);
  const frac = BigInt((match[2] ?? '').padEnd(USDC_DECIMALS, '0'));
  const units = whole * USDC_SCALE + frac;
  if (units <= 0n) {
    throw new RangeError(`USD cap "${usd}" must be greater than zero`);
  }
  return units;
}

/** Exact decimal rendering of USDC base units, e.g. 10_000n → "0.010000". */
export function formatUsdcBaseUnits(units: bigint): string {
  if (units < 0n) throw new RangeError('USDC amount cannot be negative');
  const whole = units / USDC_SCALE;
  const frac = (units % USDC_SCALE).toString().padStart(USDC_DECIMALS, '0');
  return `${whole}.${frac}`;
}

/**
 * Lossy float conversion for display and in-process budget accounting only.
 * Never use the result to authorize a payment.
 */
export function usdcBaseUnitsToUsdNumber(units: bigint): number {
  return Number(units) / Number(USDC_SCALE);
}

/** Payee amount plus the SDK's protocol fee — what the wallet is actually debited. */
export function withX402ProtocolFee(units: bigint): bigint {
  return units + (units * X402_PROTOCOL_FEE_BPS) / 10_000n;
}

// ─── Networks ──────────────────────────────────────────────────────────────

export type ValuePackNetworkId = 'base:8453' | 'base-sepolia:84532';

export interface ValuePackNetwork {
  /** EVM chain id the wallet submits on. */
  readonly chainId: 8453 | 84532;
  /** x402 network identifier (`name:chainId`) the 402 offer must carry. */
  readonly network: ValuePackNetworkId;
  /** agentwallet-sdk createWallet chain key. */
  readonly chainName: 'base' | 'base-sepolia';
  readonly label: string;
  readonly defaultRpcUrl: string;
  /** Canonical Circle USDC contract on this network. */
  readonly usdc: `0x${string}`;
  readonly isMainnet: boolean;
}

/**
 * The only networks and assets the value packs will pay with.
 * Addresses match agentwallet-sdk USDC_ADDRESSES and Circle's registry.
 */
export const VALUE_PACK_NETWORKS: Readonly<Record<ValuePackNetworkId, ValuePackNetwork>> = Object.freeze({
  'base-sepolia:84532': Object.freeze({
    chainId: 84532,
    network: 'base-sepolia:84532',
    chainName: 'base-sepolia',
    label: 'Base Sepolia (testnet)',
    defaultRpcUrl: 'https://sepolia.base.org',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    isMainnet: false,
  }),
  'base:8453': Object.freeze({
    chainId: 8453,
    network: 'base:8453',
    chainName: 'base',
    label: 'Base Mainnet (REAL FUNDS)',
    defaultRpcUrl: 'https://mainnet.base.org',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    isMainnet: true,
  }),
} as const);

export const DEFAULT_CHAIN_ID = 84532;
/** Env var that must equal "1" (in addition to CHAIN_ID=8453) to pay on Base Mainnet. */
export const MAINNET_OPT_IN_ENV = 'VALUE_PACK_ALLOW_MAINNET';

/**
 * Resolve the configured network. Defaults to Base Sepolia.
 * Base Mainnet requires CHAIN_ID=8453 AND VALUE_PACK_ALLOW_MAINNET=1.
 * Any other chain id fails closed.
 */
export function resolveValuePackNetwork(
  chainIdInput?: number | string,
  env: Record<string, string | undefined> = process.env
): ValuePackNetwork {
  const raw = chainIdInput ?? env['CHAIN_ID'] ?? String(DEFAULT_CHAIN_ID);
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`CHAIN_ID "${text}" is not a chain id. Use 84532 (Base Sepolia) or 8453 (Base Mainnet).`);
  }
  const chainId = Number(text);
  if (chainId === 84532) return VALUE_PACK_NETWORKS['base-sepolia:84532'];
  if (chainId === 8453) {
    if (env[MAINNET_OPT_IN_ENV] !== '1') {
      throw new Error(
        '!!! Base Mainnet (CHAIN_ID=8453) moves REAL USDC. Refusing to start. !!!\n' +
          `Set ${MAINNET_OPT_IN_ENV}=1 together with CHAIN_ID=8453 to opt in explicitly, ` +
          'or unset CHAIN_ID to use Base Sepolia (testnet).'
      );
    }
    return VALUE_PACK_NETWORKS['base:8453'];
  }
  throw new Error(`Unsupported CHAIN_ID ${chainId}. Value packs only pay on 84532 (Base Sepolia) or 8453 (Base Mainnet).`);
}

export function isValuePackNetworkId(network: string): network is ValuePackNetworkId {
  return Object.prototype.hasOwnProperty.call(VALUE_PACK_NETWORKS, network);
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** True only for the canonical USDC contract address (not a symbol) on a value-pack network. */
export function isKnownUsdc(network: string, asset: string): boolean {
  if (typeof network !== 'string' || typeof asset !== 'string') return false;
  if (!isValuePackNetworkId(network) || !EVM_ADDRESS.test(asset)) return false;
  return VALUE_PACK_NETWORKS[network].usdc.toLowerCase() === asset.toLowerCase();
}

export function isPayableAddress(value: string): value is `0x${string}` {
  return typeof value === 'string' && EVM_ADDRESS.test(value) && value.toLowerCase() !== ZERO_ADDRESS;
}

/** Canonical endpoint identity: parsed http(s) URL without fragment. */
export function canonicalEndpoint(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Endpoint "${url}" is not an http(s) URL`);
  }
  parsed.hash = '';
  return parsed.href;
}

function parseBaseUnits(value: unknown, label: string): bigint {
  let units: bigint;
  if (typeof value === 'bigint') {
    units = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value)) {
    units = BigInt(value);
  } else {
    throw new RangeError(`${label} must be a non-negative integer string or bigint of USDC base units`);
  }
  if (units <= 0n) throw new RangeError(`${label} must be greater than zero`);
  return units;
}

// ─── Probe offer selection ─────────────────────────────────────────────────

/** A 402 offer that is payable by the value packs: exact USDC on the configured network. */
export interface VerifiedUsdcOffer {
  readonly network: ValuePackNetworkId;
  readonly asset: `0x${string}`;
  readonly payTo: `0x${string}`;
  readonly amount: bigint;
}

export type OfferSelection =
  | { offer: VerifiedUsdcOffer; reason?: undefined }
  | { offer: null; reason: string };

/** Decode a base64 PAYMENT-REQUIRED header. Returns null when it is not valid base64 JSON. */
export function decodePaymentRequiredHeader(value: string): unknown {
  try {
    if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) return null;
    return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Pick the offer the agent may pay from an x402 PaymentRequired payload.
 * Mirrors agentwallet-sdk selection once the client is restricted to the
 * configured network + USDC: only `exact`, only canonical USDC, valid payee,
 * positive integer amount; the cheapest wins. Anything else fails closed.
 */
export function selectUsdcOffer(paymentRequired: unknown, network: ValuePackNetwork): OfferSelection {
  if (!paymentRequired || typeof paymentRequired !== 'object') {
    return { offer: null, reason: '402 response has no x402 payment requirements' };
  }
  const accepts = (paymentRequired as { accepts?: unknown }).accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    return { offer: null, reason: '402 response lists no payment options' };
  }
  const candidates: VerifiedUsdcOffer[] = [];
  for (const raw of accepts) {
    if (!raw || typeof raw !== 'object') continue;
    const req = raw as Record<string, unknown>;
    if (req['scheme'] !== 'exact') continue;
    if (req['network'] !== network.network) continue;
    if (typeof req['asset'] !== 'string' || !isKnownUsdc(network.network, req['asset'])) continue;
    if (typeof req['payTo'] !== 'string' || !isPayableAddress(req['payTo'])) continue;
    if (typeof req['amount'] !== 'string' || !/^\d+$/.test(req['amount'])) continue;
    const amount = BigInt(req['amount']);
    if (amount <= 0n) continue;
    candidates.push(
      Object.freeze({
        network: network.network,
        asset: req['asset'].toLowerCase() as `0x${string}`,
        payTo: req['payTo'].toLowerCase() as `0x${string}`,
        amount,
      })
    );
  }
  if (candidates.length === 0) {
    return {
      offer: null,
      reason: `no exact USDC (${network.usdc}) offer on ${network.network}; refusing unknown assets or networks`,
    };
  }
  candidates.sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  return { offer: candidates[0]! };
}

// ─── Approval records ──────────────────────────────────────────────────────

/** Immutable record of exactly what the user (or plan) approved paying. */
export interface PaymentApproval {
  readonly endpoint: string;
  readonly method: string;
  readonly network: ValuePackNetworkId;
  /** USDC contract address, lowercase. */
  readonly asset: `0x${string}`;
  /** Payee address, lowercase. */
  readonly payTo: `0x${string}`;
  /** Exact payee amount in USDC base units. */
  readonly amount: bigint;
  /** Approved ceiling in USDC base units: the full debit (amount plus the
   *  SDK protocol fee, see withX402ProtocolFee) is <= capBaseUnits. */
  readonly capBaseUnits: bigint;
}

export interface PaymentApprovalInput {
  endpoint: string;
  method?: string;
  network: string;
  asset: string;
  payTo: string;
  /** USDC base units (bigint or digit string). Floats are rejected. */
  amount: bigint | string;
  /** USD decimal string cap, e.g. "0.01". */
  capUsd: string;
}

/** Shape of the payment requirement the x402 client hands to onBeforePayment. */
export interface PaymentOffer {
  scheme?: string;
  network: string;
  asset: string;
  amount: string | bigint;
  payTo: string;
}

export type ApprovalDecision = { ok: true } | { ok: false; reason: string };

/** Non-retryable: re-running the request cannot make a rejected offer acceptable. */
export class ApprovalRejectedError extends Error {
  readonly retryable = false;
  constructor(message: string) {
    super(`Payment refused: ${message}`);
    this.name = 'ApprovalRejectedError';
  }
}

const issuedApprovals = new WeakSet<PaymentApproval>();
const consumedApprovals = new WeakSet<PaymentApproval>();

/**
 * Build the single immutable approval record from the probed 402 offer.
 * Throws (fail closed) if the asset is not USDC on the network, the payee is
 * invalid, or the amount exceeds the cap.
 */
export function createPaymentApproval(input: PaymentApprovalInput): PaymentApproval {
  const endpoint = canonicalEndpoint(input.endpoint);
  const method = (input.method ?? 'GET').toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new Error(`Invalid HTTP method "${input.method}"`);
  if (!isValuePackNetworkId(input.network)) {
    throw new ApprovalRejectedError(`network "${input.network}" is not a value-pack network`);
  }
  if (!isKnownUsdc(input.network, input.asset)) {
    throw new ApprovalRejectedError(`asset "${input.asset}" is not USDC on ${input.network}`);
  }
  if (!isPayableAddress(input.payTo)) {
    throw new ApprovalRejectedError(`payTo "${input.payTo}" is not a valid non-zero EVM address`);
  }
  const amount = parseBaseUnits(input.amount, 'amount');
  const capBaseUnits = usdToUsdcBaseUnits(input.capUsd);
  // The cap bounds what the wallet is debited: principal PLUS the SDK's
  // protocol fee, which fetchWithPayment authorizes on top of the amount.
  const debit = withX402ProtocolFee(amount);
  if (debit > capBaseUnits) {
    throw new ApprovalRejectedError(
      `offer of ${formatUsdcBaseUnits(amount)} USDC plus the protocol fee (debit ${formatUsdcBaseUnits(debit)} USDC) ` +
        `exceeds the $${input.capUsd} cap (${capBaseUnits} base units)`
    );
  }
  const approval: PaymentApproval = Object.freeze({
    endpoint,
    method,
    network: input.network,
    asset: input.asset.toLowerCase() as `0x${string}`,
    payTo: input.payTo.toLowerCase() as `0x${string}`,
    amount,
    capBaseUnits,
  });
  issuedApprovals.add(approval);
  return approval;
}

export function isApprovalConsumed(approval: PaymentApproval): boolean {
  return consumedApprovals.has(approval);
}

/** Mark an approval used without evaluating an offer (e.g. the paid call ended without one). */
export function consumePaymentApproval(approval: PaymentApproval): void {
  consumedApprovals.add(approval);
}

/**
 * Compare the final offer against the approval. The approval is consumed by
 * this call whatever the outcome, so it can authorize at most one payment and
 * a hostile endpoint cannot probe it repeatedly.
 */
export function checkOfferAgainstApproval(
  approval: PaymentApproval,
  offer: PaymentOffer,
  request: { url: string; method: string }
): ApprovalDecision {
  if (!issuedApprovals.has(approval)) {
    return { ok: false, reason: 'approval was not issued by createPaymentApproval' };
  }
  if (consumedApprovals.has(approval)) {
    return { ok: false, reason: 'approval already used (single-use)' };
  }
  consumedApprovals.add(approval);

  const mismatches: string[] = [];
  let endpoint: string | null = null;
  try {
    endpoint = canonicalEndpoint(request.url);
  } catch {
    endpoint = null;
  }
  if (endpoint !== approval.endpoint) mismatches.push(`endpoint ${request.url} != ${approval.endpoint}`);
  if (String(request.method).toUpperCase() !== approval.method) {
    mismatches.push(`method ${request.method} != ${approval.method}`);
  }
  if (offer.scheme !== undefined && offer.scheme !== 'exact') mismatches.push(`scheme ${offer.scheme} != exact`);
  if (offer.network !== approval.network) mismatches.push(`network ${offer.network} != ${approval.network}`);
  if (!isKnownUsdc(approval.network, offer.asset)) {
    mismatches.push(`asset ${offer.asset} is not USDC on ${approval.network}`);
  } else if (offer.asset.toLowerCase() !== approval.asset) {
    mismatches.push(`asset ${offer.asset} != ${approval.asset}`);
  }
  if (typeof offer.payTo !== 'string' || offer.payTo.toLowerCase() !== approval.payTo) {
    mismatches.push(`payTo ${offer.payTo} != ${approval.payTo}`);
  }
  let amount: bigint | null = null;
  try {
    amount = parseBaseUnits(offer.amount, 'offer amount');
  } catch {
    mismatches.push(`amount ${String(offer.amount)} is not a positive integer`);
  }
  if (amount !== null) {
    if (withX402ProtocolFee(amount) > approval.capBaseUnits) {
      mismatches.push(`amount ${amount} plus protocol fee exceeds cap ${approval.capBaseUnits}`);
    }
    if (amount !== approval.amount) mismatches.push(`amount ${amount} != approved ${approval.amount}`);
  }

  return mismatches.length === 0 ? { ok: true } : { ok: false, reason: mismatches.join('; ') };
}

/**
 * Build an onBeforePayment callback bound to one approval and request.
 * Rejections are reported through `onReject` and the callback returns false,
 * so the x402 client never signs or transfers.
 */
export function createApprovalGuard(
  approval: PaymentApproval,
  method: string,
  onReject: (reason: string) => void = () => undefined,
  onAccept: (offer: PaymentOffer) => void = () => undefined
): (offer: PaymentOffer, url: string) => boolean {
  return (offer, url) => {
    const decision = checkOfferAgainstApproval(approval, offer, { url, method });
    if (!decision.ok) {
      onReject(decision.reason);
      return false;
    }
    onAccept(offer);
    return true;
  };
}
