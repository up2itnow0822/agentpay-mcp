/**
 * F4: value-pack examples must convert USD caps to USDC base units exactly,
 * pay only canonical USDC on the configured network, and bind the final 402
 * offer to the single-use approval created from the probe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalRejectedError,
  VALUE_PACK_NETWORKS,
  checkOfferAgainstApproval,
  createApprovalGuard,
  createPaymentApproval,
  isApprovalConsumed,
  resolveValuePackNetwork,
  selectUsdcOffer,
  usdToUsdcBaseUnits,
} from '../examples/value-packs/shared/usdc-approval.js';
import {
  approveProbedPayment,
  fetchWithPayment,
  probeEndpoint,
} from '../examples/value-packs/shared/x402-client.js';
import { PaymentAwareError, withRetry } from '../examples/value-packs/shared/payment-retry.js';

const SEPOLIA = VALUE_PACK_NETWORKS['base-sepolia:84532'];
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYEE = '0x1111111111111111111111111111111111111111';
const ATTACKER = '0x2222222222222222222222222222222222222222';
const UNKNOWN_TOKEN = '0x3333333333333333333333333333333333333333';
const ENDPOINT = 'https://paid.example/api/market-data';

function approvalInput(overrides: Partial<Parameters<typeof createPaymentApproval>[0]> = {}) {
  return {
    endpoint: ENDPOINT,
    method: 'GET',
    network: 'base-sepolia:84532',
    asset: SEPOLIA_USDC,
    payTo: PAYEE,
    amount: 10_000n,
    capUsd: CAP_FOR_10K,
    ...overrides,
  };
}

function offer(overrides: Record<string, unknown> = {}) {
  return {
    scheme: 'exact',
    network: 'base-sepolia:84532',
    asset: SEPOLIA_USDC,
    amount: '10000',
    payTo: PAYEE,
    maxTimeoutSeconds: 60,
    extra: {},
    ...overrides,
  };
}

const GET = { url: ENDPOINT, method: 'GET' };

/** Exactly fits a 10_000 principal plus its 0.77% SDK fee (77): debit 10_077. */
const CAP_FOR_10K = '0.010077';

describe('usdToUsdcBaseUnits (exact 6-decimal conversion)', () => {
  it('converts $0.01 to 10,000 base units (not 10^16)', () => {
    expect(usdToUsdcBaseUnits('0.01')).toBe(10_000n);
  });

  it('converts exact decimals without float rounding', () => {
    expect(usdToUsdcBaseUnits('1.234567')).toBe(1_234_567n);
    expect(usdToUsdcBaseUnits('1')).toBe(1_000_000n);
    expect(usdToUsdcBaseUnits('0.000001')).toBe(1n);
    expect(usdToUsdcBaseUnits('0.1')).toBe(100_000n);
    expect(usdToUsdcBaseUnits('123456789.123456')).toBe(123_456_789_123_456n);
  });

  it('rejects more than 6 fractional digits', () => {
    expect(() => usdToUsdcBaseUnits('0.0000001')).toThrow(/fractional digits/);
    expect(() => usdToUsdcBaseUnits('1.2345678')).toThrow(/fractional digits/);
  });

  it.each(['-1', '-0.01', 'NaN', '', ' ', 'Infinity', '1e-2', '0x10', '.5', '1.', '01', '0', '0.000000', '1,000'])(
    'rejects %j',
    (value) => {
      expect(() => usdToUsdcBaseUnits(value)).toThrow();
    }
  );

  it('rejects non-string inputs (no float path)', () => {
    expect(() => usdToUsdcBaseUnits(0.01 as unknown as string)).toThrow(TypeError);
    expect(() => usdToUsdcBaseUnits(Number.NaN as unknown as string)).toThrow(TypeError);
  });
});

describe('approval record', () => {
  it('is frozen and normalizes addresses', () => {
    const approval = createPaymentApproval(approvalInput());
    expect(Object.isFrozen(approval)).toBe(true);
    expect(approval.amount).toBe(10_000n);
    expect(approval.capBaseUnits).toBe(10_077n);
    expect(approval.asset).toBe(SEPOLIA_USDC.toLowerCase());
    expect(approval.payTo).toBe(PAYEE);
    expect(() => {
      (approval as { amount: bigint }).amount = 10n ** 30n;
    }).toThrow();
  });

  it('refuses to approve a probed amount above the cap', () => {
    expect(() => createPaymentApproval(approvalInput({ amount: 10_001n }))).toThrow(ApprovalRejectedError);
  });

  it('counts the 0.77% protocol fee against the cap (Codex P1)', () => {
    // A $0.01 cap can no longer approve a 10_000 offer: the wallet would be
    // debited 10_077 base units.
    expect(() => createPaymentApproval(approvalInput({ amount: 10_000n, capUsd: '0.01' }))).toThrow(/protocol fee/);
    // The largest principal whose debit fits a $0.01 cap: 9_924 + 76 = 10_000.
    expect(() => createPaymentApproval(approvalInput({ amount: 9_924n, capUsd: '0.01' }))).not.toThrow();
    expect(() => createPaymentApproval(approvalInput({ amount: 9_925n, capUsd: '0.01' }))).toThrow(/protocol fee/);
  });

  it('refuses unknown assets, symbols, other-network USDC, and unknown networks', () => {
    expect(() => createPaymentApproval(approvalInput({ asset: UNKNOWN_TOKEN }))).toThrow(/not USDC/);
    expect(() => createPaymentApproval(approvalInput({ asset: 'USDC' }))).toThrow(/not USDC/);
    expect(() => createPaymentApproval(approvalInput({ asset: MAINNET_USDC }))).toThrow(/not USDC/);
    expect(() => createPaymentApproval(approvalInput({ network: 'ethereum:1' }))).toThrow(/network/);
  });

  it('refuses float amounts', () => {
    expect(() => createPaymentApproval(approvalInput({ amount: 0.01 as unknown as bigint }))).toThrow();
  });
});

describe('onBeforePayment binding', () => {
  it('accepts exactly the approved offer whose debit is at the cap (10_000n + 77n fee for $0.010077)', () => {
    const approval = createPaymentApproval(approvalInput());
    expect(checkOfferAgainstApproval(approval, offer(), GET)).toEqual({ ok: true });
  });

  it('accepts case-insensitive asset and payTo spellings', () => {
    const approval = createPaymentApproval(approvalInput());
    const decision = checkOfferAgainstApproval(
      approval,
      offer({ asset: SEPOLIA_USDC.toUpperCase().replace('0X', '0x'), payTo: PAYEE.toUpperCase().replace('0X', '0x') }),
      GET
    );
    expect(decision).toEqual({ ok: true });
  });

  it('rejects an amount whose debit is over the cap (10_001n + fee for a $0.010077 cap)', () => {
    const approval = createPaymentApproval(approvalInput());
    const decision = checkOfferAgainstApproval(approval, offer({ amount: '10001' }), GET);
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.reason).toMatch(/exceeds cap/);
  });

  it('rejects a wallet-balance-sized offer behind a $0.01 approval', () => {
    const approval = createPaymentApproval(approvalInput());
    const decision = checkOfferAgainstApproval(approval, offer({ amount: '1000000000000' }), GET);
    expect(decision.ok).toBe(false);
  });

  it.each([
    ['payTo', offer({ payTo: ATTACKER }), GET],
    ['asset (unknown token)', offer({ asset: UNKNOWN_TOKEN }), GET],
    ['asset (symbol)', offer({ asset: 'USDC' }), GET],
    ['network', offer({ network: 'base:8453', asset: MAINNET_USDC }), GET],
    ['amount (lower)', offer({ amount: '9999' }), GET],
    ['amount (non-integer)', offer({ amount: '0.01' }), GET],
    ['scheme', offer({ scheme: 'upto' }), GET],
    ['endpoint', offer(), { url: 'https://paid.example/api/other', method: 'GET' }],
    ['endpoint origin', offer(), { url: 'https://evil.example/api/market-data', method: 'GET' }],
    ['method', offer(), { url: ENDPOINT, method: 'POST' }],
  ])('rejects a changed %s', (_label, changed, request) => {
    const approval = createPaymentApproval(approvalInput());
    const decision = checkOfferAgainstApproval(approval, changed, request);
    expect(decision.ok).toBe(false);
  });

  it('is single-use: a second identical offer is rejected', () => {
    const approval = createPaymentApproval(approvalInput());
    const guard = createApprovalGuard(approval, 'GET');
    expect(guard(offer(), ENDPOINT)).toBe(true);
    expect(isApprovalConsumed(approval)).toBe(true);
    expect(guard(offer(), ENDPOINT)).toBe(false);
  });

  it('is consumed by a rejected evaluation too (no probing the approval)', () => {
    const approval = createPaymentApproval(approvalInput());
    expect(checkOfferAgainstApproval(approval, offer({ payTo: ATTACKER }), GET).ok).toBe(false);
    expect(checkOfferAgainstApproval(approval, offer(), GET).ok).toBe(false);
  });

  it('rejects forged approval objects that were not issued', () => {
    const forged = Object.freeze({ ...createPaymentApproval(approvalInput()) });
    expect(checkOfferAgainstApproval(forged, offer(), GET).ok).toBe(false);
  });
});

describe('selectUsdcOffer', () => {
  it('fails closed when only unknown assets are offered', () => {
    const selection = selectUsdcOffer({ accepts: [offer({ asset: UNKNOWN_TOKEN })] }, SEPOLIA);
    expect(selection.offer).toBeNull();
  });

  it('ignores other networks and picks the exact USDC offer', () => {
    const selection = selectUsdcOffer(
      { accepts: [offer({ network: 'base:8453', asset: MAINNET_USDC, amount: '1' }), offer()] },
      SEPOLIA
    );
    expect(selection.offer?.amount).toBe(10_000n);
    expect(selection.offer?.network).toBe('base-sepolia:84532');
  });
});

describe('network selection', () => {
  it('defaults to Base Sepolia', () => {
    expect(resolveValuePackNetwork(undefined, {}).network).toBe('base-sepolia:84532');
  });

  it('refuses Base Mainnet without VALUE_PACK_ALLOW_MAINNET=1', () => {
    expect(() => resolveValuePackNetwork(undefined, { CHAIN_ID: '8453' })).toThrow(/VALUE_PACK_ALLOW_MAINNET/);
    expect(() => resolveValuePackNetwork(8453, { VALUE_PACK_ALLOW_MAINNET: 'true' })).toThrow(/REAL USDC/);
  });

  it('allows Base Mainnet only with the explicit opt-in', () => {
    const net = resolveValuePackNetwork(undefined, { CHAIN_ID: '8453', VALUE_PACK_ALLOW_MAINNET: '1' });
    expect(net.network).toBe('base:8453');
    expect(net.usdc).toBe(MAINNET_USDC);
  });

  it('refuses unknown chains', () => {
    expect(() => resolveValuePackNetwork(1, {})).toThrow(/Unsupported CHAIN_ID/);
    expect(() => resolveValuePackNetwork('abc', {})).toThrow();
  });
});

// ─── End-to-end through fetchWithPayment + agentwallet-sdk ──────────────────

function paymentRequiredHeader(accepts: ReturnType<typeof offer>[], resourceUrl = ENDPOINT): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      resource: { url: resourceUrl, description: 'market data', mimeType: 'application/json' },
      accepts,
    })
  ).toString('base64');
}

interface Harness {
  /** Calls that reached the wallet (any on-chain read or transfer). */
  walletTouches: string[];
  /** Requests carrying a payment proof. */
  paidRequests: number;
  fetchCalls: number;
}

/**
 * Stub global fetch so the probe sees `probeOffer` and the paid call sees
 * `finalOffer` (a hostile endpoint switching terms after approval).
 */
function installEndpoint(probeOffer: ReturnType<typeof offer>, finalOffer: ReturnType<typeof offer>): Harness {
  const harness: Harness = { walletTouches: [], paidRequests: 0, fetchCalls: 0 };
  let challenges = 0;
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    harness.fetchCalls += 1;
    const headers = new Headers(init?.headers);
    if (headers.has('X-PAYMENT')) {
      harness.paidRequests += 1;
      return new Response('{"ok":true}', { status: 200 });
    }
    const current = challenges === 0 ? probeOffer : finalOffer;
    challenges += 1;
    return new Response('payment required', {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader([current]) },
    });
  });
  return harness;
}

function fakeWallet(harness: Harness, chainId = 84532) {
  const record = (name: string) => () => {
    harness.walletTouches.push(name);
    throw new Error('test wallet: on-chain access is disabled');
  };
  return {
    address: '0x4444444444444444444444444444444444444444',
    chain: { id: chainId },
    contract: { read: { remainingBudget: record('remainingBudget') }, write: new Proxy({}, { get: (_t, p) => record(`write.${String(p)}`) }) },
    publicClient: new Proxy({}, { get: (_t, p) => record(`public.${String(p)}`) }),
    walletClient: new Proxy({}, { get: (_t, p) => record(`wallet.${String(p)}`) }),
  } as unknown as Parameters<typeof fetchWithPayment>[0];
}

async function probeAndApprove(capUsd = CAP_FOR_10K) {
  const info = await probeEndpoint(ENDPOINT, 1000, { network: SEPOLIA });
  expect(info).not.toBeNull();
  return approveProbedPayment(info!, capUsd);
}

describe('fetchWithPayment end-to-end binding (zero payments on any change)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a matching final offer is authorized and reaches the wallet once', async () => {
    const harness = installEndpoint(offer(), offer());
    const approval = await probeAndApprove();
    const wallet = fakeWallet(harness);
    // The fake wallet refuses on-chain access, so authorization surfaces as a
    // PaymentAwareError (payment initiated) instead of a settled transfer.
    await expect(fetchWithPayment(wallet, ENDPOINT, { approval })).rejects.toBeInstanceOf(PaymentAwareError);
    expect(harness.walletTouches).toEqual(['remainingBudget']);
    expect(isApprovalConsumed(approval)).toBe(true);
  });

  it.each([
    ['payTo', offer({ payTo: ATTACKER })],
    ['asset', offer({ asset: UNKNOWN_TOKEN })],
    ['network', offer({ network: 'base:8453', asset: MAINNET_USDC })],
    ['amount (over cap)', offer({ amount: '10001' })],
    ['amount (wallet-sized)', offer({ amount: '5000000000' })],
    ['amount (under)', offer({ amount: '9999' })],
  ])('final offer with changed %s → rejected, zero payments', async (_label, finalOffer) => {
    const harness = installEndpoint(offer(), finalOffer);
    const approval = await probeAndApprove();
    await expect(fetchWithPayment(fakeWallet(harness), ENDPOINT, { approval })).rejects.toBeInstanceOf(
      ApprovalRejectedError
    );
    expect(harness.walletTouches).toEqual([]);
    expect(harness.paidRequests).toBe(0);
    expect(isApprovalConsumed(approval)).toBe(true);
  });

  it('changed endpoint after approval → rejected before any request, zero payments', async () => {
    const harness = installEndpoint(offer(), offer());
    const approval = await probeAndApprove();
    const before = harness.fetchCalls;
    await expect(
      fetchWithPayment(fakeWallet(harness), 'https://evil.example/api/market-data', { approval })
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
    expect(harness.fetchCalls).toBe(before);
    expect(harness.walletTouches).toEqual([]);
    expect(harness.paidRequests).toBe(0);
  });

  it('wallet on a different chain than the approval → rejected, zero payments', async () => {
    const harness = installEndpoint(offer(), offer());
    const approval = await probeAndApprove();
    await expect(fetchWithPayment(fakeWallet(harness, 8453), ENDPOINT, { approval })).rejects.toBeInstanceOf(
      ApprovalRejectedError
    );
    expect(harness.walletTouches).toEqual([]);
  });

  it('unknown asset at probe time is never approvable', async () => {
    installEndpoint(offer({ asset: UNKNOWN_TOKEN }), offer({ asset: UNKNOWN_TOKEN }));
    const info = await probeEndpoint(ENDPOINT, 1000, { network: SEPOLIA });
    expect(info?.payable).toBe(false);
    expect(() => approveProbedPayment(info!, '0.01')).toThrow(ApprovalRejectedError);
  });

  it('probe above the cap is never approvable', async () => {
    installEndpoint(offer({ amount: '10001' }), offer({ amount: '10001' }));
    const info = await probeEndpoint(ENDPOINT, 1000, { network: SEPOLIA });
    expect(info?.payable).toBe(true);
    expect(() => approveProbedPayment(info!, '0.01')).toThrow(/exceeds/);
  });

  it('approval is single-use across fetchWithPayment calls and withRetry does not re-enter', async () => {
    const harness = installEndpoint(offer(), offer({ payTo: ATTACKER }));
    const approval = await probeAndApprove();
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts += 1;
          return fetchWithPayment(fakeWallet(harness), ENDPOINT, { approval });
        },
        { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 }
      )
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
    expect(attempts).toBe(1);

    // Even an honest retry with the original terms cannot reuse the approval.
    const fetchesBefore = harness.fetchCalls;
    await expect(fetchWithPayment(fakeWallet(harness), ENDPOINT, { approval })).rejects.toThrow(/single-use/);
    expect(harness.fetchCalls).toBe(fetchesBefore);
    expect(harness.walletTouches).toEqual([]);
    expect(harness.paidRequests).toBe(0);
  });
});
