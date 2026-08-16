/**
 * Tests for x402 V2 session tools: x402_session_start, x402_session_fetch,
 * x402_session_status, and x402_session_end.
 *
 * All network calls and wallet interactions are mocked.
 * The session manager is tested via real in-memory state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

// We hoist this mock factory so it's available before module import
const mockX402ClientFetch = vi.fn();

vi.mock('agentwallet-sdk', () => ({
  createX402Client: vi.fn(() => ({
    fetch: mockX402ClientFetch,
    getTransactionLog: vi.fn(() => []),
    getDailySpendSummary: vi.fn(() => ({ global: 0n, byService: {}, resetsAt: 0 })),
    budgetTracker: {},
  })),
  createWallet: vi.fn(),
  agentTransferToken: vi.fn(),
  agentExecute: vi.fn(),
  checkBudget: vi.fn(),
  getBudgetForecast: vi.fn(),
  getPendingApprovals: vi.fn(),
  approveTransaction: vi.fn(),
  cancelTransaction: vi.fn(),
  getWalletHealth: vi.fn(),
  getActivityHistory: vi.fn(),
}));

// ─── Mock client utils ─────────────────────────────────────────────────────

const MOCK_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';
const MOCK_SIGN_RESULT = '0xsignatureabcdef0000000000000000000000000000000000000000000000000000';
const mockSignMessage = vi.fn().mockResolvedValue(MOCK_SIGN_RESULT);

const MOCK_WALLET = {
  address: MOCK_WALLET_ADDRESS as `0x${string}`,
  publicClient: {
    getBalance: vi.fn().mockResolvedValue(1_000_000_000_000_000_000n),
  },
  walletClient: {
    signMessage: mockSignMessage,
  },
  contract: {},
  chain: { id: 8453 },
};

vi.mock('../src/utils/client.js', () => ({
  getConfig: vi.fn(() => ({
    agentPrivateKey: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    walletAddress: MOCK_WALLET_ADDRESS,
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
  })),
  getWallet: vi.fn(() => MOCK_WALLET),
  _resetSingletons: vi.fn(),
}));

// ─── Import mocked modules AFTER vi.mock declarations ─────────────────────

import { createX402Client } from 'agentwallet-sdk';
import {
  handleX402SessionStart,
  handleX402SessionFetch,
  handleX402SessionStatus,
  handleX402SessionEnd,
} from '../src/tools/session.js';
import {
  _clearAllSessions,
  createSession,
  findSessionForUrl,
  isUrlCoveredBySession,
  buildSessionHeaders,
  decodeSessionToken,
  listActiveSessions,
} from '../src/session/manager.js';

const mockCreateX402Client = vi.mocked(createX402Client);

// ─── Constants ─────────────────────────────────────────────────────────────

const MOCK_TX_HASH = '0xpaymenttx00000000000000000000000000000000000000000000000000000000';
const MOCK_RECIPIENT = '0xpayee0000000000000000000000000000000000';
const MOCK_PAYMENT_AMOUNT = 1_000_000n;
const TEST_ENDPOINT = 'https://api.example.com/v1';

// ─── Mock helpers ──────────────────────────────────────────────────────────

type PaymentCompleteLog = {
  timestamp: number;
  service: string;
  url: string;
  amount: bigint;
  token: string;
  recipient: string;
  txHash: string;
  network: string;
  scheme: string;
  success: boolean;
};

type X402ClientConfig = {
  onPaymentComplete?: (log: PaymentCompleteLog) => void;
  onBeforePayment?: (req: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: Record<string, unknown>;
  }, url: string) => boolean;
  globalPerRequestMax?: bigint;
};

/**
 * Configure the createX402Client mock to simulate a successful x402 payment.
 * The onPaymentComplete callback is called, which triggers session creation.
 */
function setupX402PaymentMock(overrides: {
  status?: number;
  body?: string;
  throwError?: Error;
} = {}) {
  mockCreateX402Client.mockImplementationOnce(
    (_wallet: unknown, config: X402ClientConfig) => ({
      fetch: async (url: string, _init?: RequestInit): Promise<Response> => {
        if (overrides.throwError) throw overrides.throwError;

        if (config?.onPaymentComplete) {
          config.onPaymentComplete({
            timestamp: Date.now(),
            service: 'api.example.com',
            url,
            amount: MOCK_PAYMENT_AMOUNT,
            token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
            recipient: MOCK_RECIPIENT,
            txHash: MOCK_TX_HASH,
            network: 'base:8453',
            scheme: 'exact',
            success: true,
          });
        }

        return new Response(
          overrides.body ?? '{"session":"welcome","data":"premium content"}',
          {
            status: overrides.status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      },
      getTransactionLog: vi.fn(() => []),
      getDailySpendSummary: vi.fn(() => ({ global: 0n, byService: {}, resetsAt: 0 })),
      budgetTracker: {},
    })
  );
}

/**
 * Configure the createX402Client mock to return 200 without triggering payment.
 */
function setupFreeEndpointMock(body = '{"free":true}') {
  mockCreateX402Client.mockImplementationOnce(() => ({
    fetch: async (): Promise<Response> => new Response(body, { status: 200 }),
    getTransactionLog: vi.fn(() => []),
    getDailySpendSummary: vi.fn(() => ({ global: 0n, byService: {}, resetsAt: 0 })),
    budgetTracker: {},
  }));
}

/**
 * Helper: create a session via x402_session_start with a payment mock.
 * Returns the fixed session ID from the manager.
 */
async function createSessionViaStart(overrides: {
  endpoint?: string;
  scope?: 'prefix' | 'exact';
  ttl_seconds?: number;
  label?: string;
} = {}): Promise<string> {
  setupX402PaymentMock();
  const result = await handleX402SessionStart({
    endpoint: overrides.endpoint ?? TEST_ENDPOINT,
    scope: overrides.scope,
    ttl_seconds: overrides.ttl_seconds,
    label: overrides.label,
  });
  expect(result.isError).toBeFalsy();

  // Extract session_id from the response text
  const text = result.content[0]!.text;
  const match = text.match(/Session ID:\s+([0-9a-f-]{36})/);
  expect(match).not.toBeNull();
  return match![1]!;
}

// ─── x402_session_start tests ─────────────────────────────────────────────

describe('x402_session_start tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearAllSessions();
    // Restore signMessage default
    mockSignMessage.mockResolvedValue(MOCK_SIGN_RESULT);
  });

  afterEach(() => {
    _clearAllSessions();
  });

  it('creates a session after successful x402 payment', async () => {
    setupX402PaymentMock();

    const result = await handleX402SessionStart({ endpoint: TEST_ENDPOINT });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Session Established');
    expect(text).toContain(TEST_ENDPOINT);
    expect(text).toContain(MOCK_TX_HASH);
    expect(text).toContain(MOCK_PAYMENT_AMOUNT.toString());
    // Session ID (UUID format)
    expect(text).toMatch(/Session ID:\s+[0-9a-f-]{36}/);
  });

  it('shows session TTL and expiry in response', async () => {
    setupX402PaymentMock();

    const result = await handleX402SessionStart({
      endpoint: TEST_ENDPOINT,
      ttl_seconds: 1800,
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('30m'); // 1800s = 30m
    expect(text).toContain('expires');
  });

  it('shows optional label in response', async () => {
    setupX402PaymentMock();

    const result = await handleX402SessionStart({
      endpoint: TEST_ENDPOINT,
      label: 'My Premium Session',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('My Premium Session');
  });

  it('uses prefix scope by default', async () => {
    setupX402PaymentMock();

    const result = await handleX402SessionStart({ endpoint: TEST_ENDPOINT });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('prefix');
  });

  it('respects exact scope when specified', async () => {
    setupX402PaymentMock();

    const result = await handleX402SessionStart({
      endpoint: TEST_ENDPOINT,
      scope: 'exact',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('exact');
  });

  it('returns informative message when no payment required', async () => {
    setupFreeEndpointMock();

    const result = await handleX402SessionStart({ endpoint: TEST_ENDPOINT });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('No Payment Required');
    // No session instructions when no payment made
    expect(text).not.toContain('x402_session_fetch');
  });

  it('handles invalid max_payment_eth gracefully', async () => {
    const result = await handleX402SessionStart({
      endpoint: TEST_ENDPOINT,
      max_payment_eth: 'not-a-number',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('❌');
    expect(result.content[0]!.text).toContain('max_payment_eth');
  });

  it('handles AbortError (timeout) gracefully', async () => {
    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    setupX402PaymentMock({ throwError: abortErr });

    const result = await handleX402SessionStart({
      endpoint: TEST_ENDPOINT,
      timeout_ms: 5000,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('timed out');
    expect(result.content[0]!.text).toContain('5000');
  });

  it('handles network errors gracefully', async () => {
    setupX402PaymentMock({ throwError: new Error('ECONNREFUSED') });

    const result = await handleX402SessionStart({ endpoint: TEST_ENDPOINT });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('ECONNREFUSED');
  });

  it('instructs user to use x402_session_fetch after session creation', async () => {
    setupX402PaymentMock();

    const result = await handleX402SessionStart({ endpoint: TEST_ENDPOINT });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('x402_session_fetch');
  });

  it('includes initial response body in output', async () => {
    setupX402PaymentMock({ body: '{"welcome":"message"}' });

    const result = await handleX402SessionStart({ endpoint: TEST_ENDPOINT });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('welcome');
  });
});

// ─── x402_session_fetch tests ─────────────────────────────────────────────

describe('x402_session_fetch tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearAllSessions();
    mockSignMessage.mockResolvedValue(MOCK_SIGN_RESULT);
  });

  afterEach(() => {
    _clearAllSessions();
    vi.restoreAllMocks();
  });

  it('fetches URL within session without making a payment', async () => {
    const sessionId = await createSessionViaStart();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{"result":"success"}', { status: 200 })
    );

    const result = await handleX402SessionFetch({
      session_id: sessionId,
      url: `${TEST_ENDPOINT}/data`,
    });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Session Fetch');
    expect(text).toContain('No payment'); // exact capitalisation from output
    expect(text).toContain('success');
    // Verify plain fetch was called (not x402 client)
    expect(fetchSpy).toHaveBeenCalledOnce();
    // Verify x402 client was NOT called for the session fetch
    expect(mockX402ClientFetch).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('injects X-Session-Token header into the request', async () => {
    const sessionId = await createSessionViaStart();

    let capturedHeaders: Record<string, string> = {};
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response('ok', { status: 200 });
      }
    );

    await handleX402SessionFetch({
      session_id: sessionId,
      url: `${TEST_ENDPOINT}/resource`,
    });

    expect(capturedHeaders['X-Session-Token']).toBeDefined();
    expect(capturedHeaders['X-Session-Token']).toContain(MOCK_SIGN_RESULT);
    expect(capturedHeaders['X-Session-Wallet']).toBe(MOCK_WALLET_ADDRESS);
    expect(capturedHeaders['PAYMENT-SESSION']).toBe(sessionId);

    fetchSpy.mockRestore();
  });

  it('merges additional user headers with session headers', async () => {
    const sessionId = await createSessionViaStart();

    let capturedHeaders: Record<string, string> = {};
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      async (_url: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return new Response('ok', { status: 200 });
      }
    );

    await handleX402SessionFetch({
      session_id: sessionId,
      url: `${TEST_ENDPOINT}/resource`,
      headers: { 'X-Custom-Header': 'my-value' },
    });

    expect(capturedHeaders['X-Custom-Header']).toBe('my-value');
    expect(capturedHeaders['X-Session-Token']).toBeDefined();

    fetchSpy.mockRestore();
  });

  it('tracks call count across multiple fetches', async () => {
    const sessionId = await createSessionViaStart();

    // Use mockImplementation (not mockResolvedValue) so a fresh Response
    // is created per call — Response body streams are single-read.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('ok', { status: 200 })
    );

    await handleX402SessionFetch({ session_id: sessionId, url: `${TEST_ENDPOINT}/a` });
    await handleX402SessionFetch({ session_id: sessionId, url: `${TEST_ENDPOINT}/b` });
    const result3 = await handleX402SessionFetch({ session_id: sessionId, url: `${TEST_ENDPOINT}/c` });

    expect(result3.isError).toBeFalsy();
    expect(result3.content[0]!.text).toContain('call #3');

    fetchSpy.mockRestore();
  });

  it('returns error for unknown session_id', async () => {
    const result = await handleX402SessionFetch({
      session_id: '00000000-0000-0000-0000-000000000000',
      url: `${TEST_ENDPOINT}/data`,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Session not found');
    expect(result.content[0]!.text).toContain('x402_session_start');
  });

  it('returns expired session error with renewal instruction', async () => {
    const sessionId = await createSessionViaStart({ ttl_seconds: 1 });

    // Wait for session to expire
    await new Promise((r) => setTimeout(r, 1200));

    const result = await handleX402SessionFetch({
      session_id: sessionId,
      url: `${TEST_ENDPOINT}/data`,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Session Expired');
    expect(result.content[0]!.text).toContain('x402_session_start');
  });

  it('rejects URL outside prefix scope', async () => {
    const sessionId = await createSessionViaStart({
      endpoint: TEST_ENDPOINT,
      scope: 'prefix',
    });

    const result = await handleX402SessionFetch({
      session_id: sessionId,
      url: 'https://api.other.com/data',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not covered by this session');
    expect(result.content[0]!.text).toContain(TEST_ENDPOINT);
  });

  it('rejects subpath URL when scope is exact', async () => {
    const sessionId = await createSessionViaStart({
      endpoint: TEST_ENDPOINT,
      scope: 'exact',
    });

    const result = await handleX402SessionFetch({
      session_id: sessionId,
      url: `${TEST_ENDPOINT}/different-path`,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not covered by this session');
  });

  it('allows exact URL match with exact scope', async () => {
    const sessionId = await createSessionViaStart({
      endpoint: TEST_ENDPOINT,
      scope: 'exact',
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('ok', { status: 200 })
    );

    const result = await handleX402SessionFetch({
      session_id: sessionId,
      url: TEST_ENDPOINT, // exact match
    });

    expect(result.isError).toBeFalsy();
    fetchSpy.mockRestore();
  });

  it('warns when server still returns 402 despite session headers', async () => {
    const sessionId = await createSessionViaStart();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('payment required', { status: 402 })
    );

    const result = await handleX402SessionFetch({
      session_id: sessionId,
      url: `${TEST_ENDPOINT}/data`,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Session Not Recognised');
    expect(result.content[0]!.text).toContain('x402_pay');

    fetchSpy.mockRestore();
  });

  it('truncates very large responses', async () => {
    const sessionId = await createSessionViaStart();

    const largeBody = 'x'.repeat(10000);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(largeBody, { status: 200 })
    );

    const result = await handleX402SessionFetch({
      session_id: sessionId,
      url: `${TEST_ENDPOINT}/large`,
    });

    expect(result.content[0]!.text).toContain('[response truncated]');
    expect(result.content[0]!.text.length).toBeLessThan(largeBody.length);

    fetchSpy.mockRestore();
  });

  it('handles timeout gracefully', async () => {
    const sessionId = await createSessionViaStart();

    const abortErr = new Error('Aborted');
    abortErr.name = 'AbortError';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortErr);

    const result = await handleX402SessionFetch({
      session_id: sessionId,
      url: `${TEST_ENDPOINT}/slow`,
      timeout_ms: 5000,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('timed out');
    expect(result.content[0]!.text).toContain('5000');

    fetchSpy.mockRestore();
  });

  it('handles network errors within session gracefully', async () => {
    const sessionId = await createSessionViaStart();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
      new Error('ECONNRESET')
    );

    const result = await handleX402SessionFetch({
      session_id: sessionId,
      url: `${TEST_ENDPOINT}/down`,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('ECONNRESET');

    fetchSpy.mockRestore();
  });

  it('sends POST request with body through the session', async () => {
    const sessionId = await createSessionViaStart();

    let capturedInit: RequestInit = {};
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      async (_url: string | URL | Request, init?: RequestInit) => {
        capturedInit = init ?? {};
        return new Response('{"created":true}', { status: 201 });
      }
    );

    const result = await handleX402SessionFetch({
      session_id: sessionId,
      url: `${TEST_ENDPOINT}/create`,
      method: 'POST',
      body: '{"name":"test"}',
    });

    expect(result.isError).toBeFalsy();
    expect(capturedInit.method).toBe('POST');
    expect(capturedInit.body).toBe('{"name":"test"}');

    fetchSpy.mockRestore();
  });

  it('shows TTL remaining in the response', async () => {
    const sessionId = await createSessionViaStart();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('ok', { status: 200 })
    );

    const result = await handleX402SessionFetch({
      session_id: sessionId,
      url: `${TEST_ENDPOINT}/data`,
    });

    expect(result.content[0]!.text).toMatch(/Session TTL:/);

    fetchSpy.mockRestore();
  });
});

// ─── x402_session_status tests ────────────────────────────────────────────

describe('x402_session_status tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearAllSessions();
    mockSignMessage.mockResolvedValue(MOCK_SIGN_RESULT);
  });

  afterEach(() => {
    _clearAllSessions();
    vi.restoreAllMocks();
  });

  it('shows empty state when no sessions exist', async () => {
    const result = await handleX402SessionStatus({});

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('No active sessions');
    expect(text).toContain('x402_session_start');
  });

  it('lists active sessions after creation', async () => {
    const sessionId = await createSessionViaStart({ label: 'My Test Session' });

    const result = await handleX402SessionStatus({});

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Active x402 Sessions');
    expect(text).toContain(sessionId);
    expect(text).toContain(TEST_ENDPOINT);
    expect(text).toContain('My Test Session');
  });

  it('shows TTL progress bar for active sessions', async () => {
    await createSessionViaStart();

    const result = await handleX402SessionStatus({});

    // Progress bar contains block and light-shade characters
    expect(result.content[0]!.text).toMatch(/[█░]/);
  });

  it('shows detailed view for a specific session_id', async () => {
    const sessionId = await createSessionViaStart();

    const result = await handleX402SessionStatus({ session_id: sessionId });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Session Details');
    expect(text).toContain(sessionId);
    expect(text).toContain(MOCK_TX_HASH);
    expect(text).toContain(MOCK_PAYMENT_AMOUNT.toString());
    expect(text).toContain(MOCK_WALLET_ADDRESS);
  });

  it('shows call count in detailed view', async () => {
    const sessionId = await createSessionViaStart();

    // Use mockImplementation so each call gets a fresh Response stream
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('ok', { status: 200 })
    );
    await handleX402SessionFetch({ session_id: sessionId, url: `${TEST_ENDPOINT}/a` });
    await handleX402SessionFetch({ session_id: sessionId, url: `${TEST_ENDPOINT}/b` });
    fetchSpy.mockRestore();

    const result = await handleX402SessionStatus({ session_id: sessionId });

    expect(result.content[0]!.text).toContain('Call Count:    2');
  });

  it('shows protocol version in detailed token info', async () => {
    const sessionId = await createSessionViaStart();

    const result = await handleX402SessionStatus({ session_id: sessionId });

    expect(result.content[0]!.text).toContain('clawpay/1.1');
  });

  it('returns error for unknown session_id', async () => {
    const result = await handleX402SessionStatus({
      session_id: '00000000-0000-0000-0000-000000000000',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not found');
  });

  it('shows expired status when queried by expired session ID', async () => {
    const sessionId = await createSessionViaStart({ ttl_seconds: 1 });

    await new Promise((r) => setTimeout(r, 1200));

    const result = await handleX402SessionStatus({ session_id: sessionId });

    expect(result.content[0]!.text).toContain('Expired');
  });

  it('excludes expired sessions from active list', async () => {
    await createSessionViaStart({ ttl_seconds: 1 });

    await new Promise((r) => setTimeout(r, 1200));

    const result = await handleX402SessionStatus({});

    expect(result.content[0]!.text).toContain('No active sessions');
  });
});

// ─── x402_session_end tests ───────────────────────────────────────────────

describe('x402_session_end tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearAllSessions();
    mockSignMessage.mockResolvedValue(MOCK_SIGN_RESULT);
  });

  afterEach(() => {
    _clearAllSessions();
    vi.restoreAllMocks();
  });

  it('ends an active session successfully', async () => {
    const sessionId = await createSessionViaStart();

    const result = await handleX402SessionEnd({ session_id: sessionId });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain('Session Closed');
    expect(text).toContain(sessionId);
    expect(text).toContain(TEST_ENDPOINT);
  });

  it('prevents subsequent use of an ended session', async () => {
    const sessionId = await createSessionViaStart();
    await handleX402SessionEnd({ session_id: sessionId });

    const fetchResult = await handleX402SessionFetch({
      session_id: sessionId,
      url: `${TEST_ENDPOINT}/data`,
    });

    expect(fetchResult.isError).toBe(true);
    expect(fetchResult.content[0]!.text).toContain('Expired');
  });

  it('removes ended session from active sessions list', async () => {
    const sessionId = await createSessionViaStart();
    await handleX402SessionEnd({ session_id: sessionId });

    const statusResult = await handleX402SessionStatus({});

    expect(statusResult.content[0]!.text).toContain('No active sessions');
  });

  it('returns error for unknown session_id', async () => {
    const result = await handleX402SessionEnd({
      session_id: '00000000-0000-0000-0000-000000000000',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not found');
  });

  it('handles already-expired session gracefully', async () => {
    const sessionId = await createSessionViaStart({ ttl_seconds: 1 });

    await new Promise((r) => setTimeout(r, 1200));

    const result = await handleX402SessionEnd({ session_id: sessionId });

    // Should not error — just report it was already expired
    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('already expired');
  });

  it('shows call count in session end confirmation', async () => {
    const sessionId = await createSessionViaStart();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('ok', { status: 200 })
    );
    await handleX402SessionFetch({ session_id: sessionId, url: `${TEST_ENDPOINT}/a` });
    fetchSpy.mockRestore();

    const result = await handleX402SessionEnd({ session_id: sessionId });

    expect(result.content[0]!.text).toContain('Calls made: 1');
  });
});

// ─── Session manager unit tests ────────────────────────────────────────────

describe('Session manager (direct unit tests)', () => {
  beforeEach(() => {
    _clearAllSessions();
  });

  afterEach(() => {
    _clearAllSessions();
  });

  const makeSignFn = () => vi.fn().mockResolvedValue('0xsig');

  it('stores sessions and returns them via listActiveSessions', async () => {
    await createSession({
      endpoint: 'https://a.example.com',
      walletAddress: '0xwallet',
      paymentTxHash: '0xtx',
      paymentAmount: 100n,
      paymentToken: '0x0000000000000000000000000000000000000000',
      paymentRecipient: '0xrecip',
      signMessage: makeSignFn(),
    });

    const active = listActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0]!.endpoint).toBe('https://a.example.com');
  });

  it('decodes session token payload correctly', async () => {
    const session = await createSession({
      endpoint: 'https://api.example.com',
      walletAddress: '0xwallet',
      paymentTxHash: '0xtx',
      paymentAmount: 500n,
      paymentToken: '0x0000000000000000000000000000000000000000',
      paymentRecipient: '0xrecip',
      signMessage: makeSignFn(),
    });

    const decoded = decodeSessionToken(session.sessionToken);
    expect(decoded).not.toBeNull();
    expect(decoded!.payload.version).toBe('clawpay/1.1');
    expect(decoded!.payload.walletAddress).toBe('0xwallet');
    expect(decoded!.payload.endpoint).toBe('https://api.example.com');
  });

  it('findSessionForUrl returns prefix match for subpath', async () => {
    await createSession({
      endpoint: 'https://api.example.com/v1',
      scope: 'prefix',
      walletAddress: '0xwallet',
      paymentTxHash: '0xtx',
      paymentAmount: 100n,
      paymentToken: '0x0000000000000000000000000000000000000000',
      paymentRecipient: '0xrecip',
      signMessage: makeSignFn(),
    });

    const found = findSessionForUrl('https://api.example.com/v1/users');
    expect(found).toBeDefined();
    expect(found!.scope).toBe('prefix');
  });

  it('findSessionForUrl returns prefix match for endpoint query strings', async () => {
    await createSession({
      endpoint: 'https://api.example.com/v1',
      scope: 'prefix',
      walletAddress: '0xwallet',
      paymentTxHash: '0xtx',
      paymentAmount: 100n,
      paymentToken: '0x0000000000000000000000000000000000000000',
      paymentRecipient: '0xrecip',
      signMessage: makeSignFn(),
    });

    const found = findSessionForUrl('https://api.example.com/v1?cursor=next');
    expect(found).toBeDefined();
    expect(found!.scope).toBe('prefix');
  });

  it('findSessionForUrl matches endpoint query params regardless of order', async () => {
    await createSession({
      endpoint: 'https://api.example.com/v1?a=1&b=2',
      scope: 'prefix',
      walletAddress: '0xwallet',
      paymentTxHash: '0xtx',
      paymentAmount: 100n,
      paymentToken: '0x0000000000000000000000000000000000000000',
      paymentRecipient: '0xrecip',
      signMessage: makeSignFn(),
    });

    // Same params, different order — must match
    expect(findSessionForUrl('https://api.example.com/v1?b=2&a=1')).toBeDefined();
    // Missing a required param — must not match
    expect(findSessionForUrl('https://api.example.com/v1?a=1')).toBeUndefined();
  });

  it('findSessionForUrl rejects raw string prefix lookalikes', async () => {
    await createSession({
      endpoint: 'https://api.example.com/v1',
      scope: 'prefix',
      walletAddress: '0xwallet',
      paymentTxHash: '0xtx',
      paymentAmount: 100n,
      paymentToken: '0x0000000000000000000000000000000000000000',
      paymentRecipient: '0xrecip',
      signMessage: makeSignFn(),
    });

    expect(findSessionForUrl('https://api.example.com/v10/users')).toBeUndefined();
    expect(findSessionForUrl('https://api.example.com/v1.evil/steal')).toBeUndefined();
  });

  it('findSessionForUrl returns undefined for non-matching URL', async () => {
    await createSession({
      endpoint: 'https://api.example.com/v1',
      scope: 'prefix',
      walletAddress: '0xwallet',
      paymentTxHash: '0xtx',
      paymentAmount: 100n,
      paymentToken: '0x0000000000000000000000000000000000000000',
      paymentRecipient: '0xrecip',
      signMessage: makeSignFn(),
    });

    const found = findSessionForUrl('https://other.example.com/data');
    expect(found).toBeUndefined();
  });

  it('findSessionForUrl does not match on expired sessions', async () => {
    await createSession({
      endpoint: 'https://api.example.com/v1',
      scope: 'prefix',
      ttlSeconds: 1,
      walletAddress: '0xwallet',
      paymentTxHash: '0xtx',
      paymentAmount: 100n,
      paymentToken: '0x0000000000000000000000000000000000000000',
      paymentRecipient: '0xrecip',
      signMessage: makeSignFn(),
    });

    await new Promise((r) => setTimeout(r, 1200));

    const found = findSessionForUrl('https://api.example.com/v1/data');
    expect(found).toBeUndefined();
  });

  it('buildSessionHeaders includes all required x402 V2 headers', async () => {
    const session = await createSession({
      endpoint: 'https://api.example.com',
      walletAddress: '0xwallet123',
      paymentTxHash: '0xtx',
      paymentAmount: 100n,
      paymentToken: '0x0000000000000000000000000000000000000000',
      paymentRecipient: '0xrecip',
      signMessage: makeSignFn(),
    });

    const headers = buildSessionHeaders(session);
    expect(headers['X-Session-Token']).toBeDefined();
    expect(headers['X-Session-Wallet']).toBe('0xwallet123');
    expect(headers['PAYMENT-SESSION']).toBe(session.sessionId);
  });

  it('session token is a valid base64url.signature format', async () => {
    const session = await createSession({
      endpoint: 'https://api.example.com',
      walletAddress: '0xwallet',
      paymentTxHash: '0xtx',
      paymentAmount: 100n,
      paymentToken: '0x0000000000000000000000000000000000000000',
      paymentRecipient: '0xrecip',
      signMessage: makeSignFn(),
    });

    const parts = session.sessionToken.split('.');
    // token has two parts: payload (base64url) and signature
    expect(parts).toHaveLength(2);
    // First part should be valid base64url-decodable JSON
    const payload = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
    expect(payload.version).toBe('clawpay/1.1');
  });
});

// ─── isUrlCoveredBySession query & trailing-slash semantics ────────────────

describe('isUrlCoveredBySession (prefix scope)', () => {
  const prefixSession = (endpoint: string) => ({ endpoint, scope: 'prefix' as const });

  describe('endpoint query params are required params', () => {
    const session = prefixSession('https://api.example.com/v1?version=2');

    it('matches endpoint query params regardless of parameter order', () => {
      const multi = prefixSession('https://api.example.com/v1?a=1&b=2');
      expect(isUrlCoveredBySession('https://api.example.com/v1?b=2&a=1', multi)).toBe(true);
      expect(isUrlCoveredBySession('https://api.example.com/v1?a=1&b=2', multi)).toBe(true);
    });

    it('allows extra request parameters beyond the required ones', () => {
      expect(
        isUrlCoveredBySession('https://api.example.com/v1?version=2&page=3', session)
      ).toBe(true);
      expect(
        isUrlCoveredBySession('https://api.example.com/v1/users?page=3&version=2', session)
      ).toBe(true);
    });

    it('covers sub-paths that carry the required params', () => {
      expect(
        isUrlCoveredBySession('https://api.example.com/v1/users?version=2', session)
      ).toBe(true);
    });

    it('fails closed when a sub-path drops a required param', () => {
      expect(isUrlCoveredBySession('https://api.example.com/v1/users', session)).toBe(false);
      expect(isUrlCoveredBySession('https://api.example.com/v1', session)).toBe(false);
    });

    it('rejects a required param carrying a different value', () => {
      expect(
        isUrlCoveredBySession('https://api.example.com/v1/users?version=3', session)
      ).toBe(false);
    });

    it('compares duplicate keys deterministically as value multisets', () => {
      const dupes = prefixSession('https://api.example.com/v1?tag=a&tag=b');
      expect(isUrlCoveredBySession('https://api.example.com/v1?tag=b&tag=a', dupes)).toBe(true);
      expect(isUrlCoveredBySession('https://api.example.com/v1?tag=a', dupes)).toBe(false);
      expect(isUrlCoveredBySession('https://api.example.com/v1?tag=a&tag=a', dupes)).toBe(false);
    });

    it('places no query requirement when the endpoint has none', () => {
      const bare = prefixSession('https://api.example.com/v1');
      expect(isUrlCoveredBySession('https://api.example.com/v1?cursor=next', bare)).toBe(true);
      expect(isUrlCoveredBySession('https://api.example.com/v1/users', bare)).toBe(true);
    });
  });

  describe('trailing-slash normalisation', () => {
    it('treats sessions for /v1/ and /v1 identically', () => {
      const slashed = prefixSession('https://api.example.com/v1/');
      expect(isUrlCoveredBySession('https://api.example.com/v1', slashed)).toBe(true);
      expect(isUrlCoveredBySession('https://api.example.com/v1/', slashed)).toBe(true);
      expect(isUrlCoveredBySession('https://api.example.com/v1/users', slashed)).toBe(true);
    });

    it('matches a requested /v1/ against an endpoint of /v1', () => {
      const bare = prefixSession('https://api.example.com/v1');
      expect(isUrlCoveredBySession('https://api.example.com/v1/', bare)).toBe(true);
    });

    it('still rejects lookalike paths on slashed endpoints', () => {
      const slashed = prefixSession('https://api.example.com/v1/');
      expect(isUrlCoveredBySession('https://api.example.com/v10', slashed)).toBe(false);
      expect(isUrlCoveredBySession('https://api.example.com/v1.evil/steal', slashed)).toBe(false);
    });
  });

  it('still rejects other origins even when query params match', () => {
    const session = prefixSession('https://api.example.com/v1?version=2');
    expect(isUrlCoveredBySession('https://evil.example.com/v1?version=2', session)).toBe(false);
  });
});
