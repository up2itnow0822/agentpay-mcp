/**
 * End-to-end proof that a hostile 402 produces ZERO on-chain writes.
 *
 * Every other x402 test in this suite mocks `agentwallet-sdk`, so it can only
 * assert what our own code does with the values. That is not enough for the
 * two invariants below, because both live on the seam between our validator
 * and the SDK:
 *
 *   1. `X402Client.executePayment` (agentwallet-sdk 6.2.1,
 *      dist/x402/client.js:177-193) transfers the 0.77% protocol fee to
 *      FEE_COLLECTOR *before* it encodes the payee. So a `payTo` we accept but
 *      viem's ABI encoder later rejects costs the buyer the fee with nothing
 *      bought — the fee write has already been broadcast when the payee
 *      encode throws.
 *   2. `executePayment` re-reads `req.payTo` and hands the RAW string to
 *      `agentTransferToken`. Nothing `assertPayableX402Recipient` returns is
 *      threaded through, so normalising (e.g. trimming) in the guard would
 *      validate one string and sign another.
 *
 * The only way to hold those is to run the real SDK and count the writes. This
 * file therefore does NOT mock `agentwallet-sdk`: it builds a real wallet whose
 * viem transport records every JSON-RPC call, so a broadcast transaction is
 * observable as `eth_sendRawTransaction` and its calldata can be decoded.
 *
 * The control case is load-bearing: it proves the harness *can* see the fee
 * write (and sees it first), so "0 writes" in the hostile cases is a real
 * absence rather than a broken rig.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createWalletClient,
  createPublicClient,
  custom,
  getContract,
  parseTransaction,
  decodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { AgentAccountV2Abi } from 'agentwallet-sdk';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PAYEE = '0x1111111111111111111111111111111111111111';
/** agentwallet-sdk 6.2.1 dist/x402/client.js — X402_PROTOCOL_FEE_BPS collector. */
const FEE_COLLECTOR = '0xff86829393C6C26A4EC122bE0Cc3E466Ef876AdD';
const ACCOUNT_ADDRESS = '0x9999999999999999999999999999999999999999' as Address;
const AGENT_KEY = ('0x' + '11'.repeat(32)) as `0x${string}`;

// ─── Calldata-capturing transport ──────────────────────────────────────────

type Write = { to?: string; functionName: string; args: readonly unknown[] };

const writes: Write[] = [];

/** remainingBudget(address) → (perTxLimit, remainingInPeriod), both huge. */
const UNLIMITED_BUDGET = encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
  2n ** 200n,
  2n ** 200n,
]);

const STUB_BLOCK = {
  number: '0x64',
  hash: '0x' + '11'.repeat(32),
  parentHash: '0x' + '22'.repeat(32),
  baseFeePerGas: '0x3b9aca00',
  gasLimit: '0x1c9c380',
  gasUsed: '0x0',
  timestamp: '0x64',
  miner: '0x' + '00'.repeat(20),
  difficulty: '0x0',
  totalDifficulty: '0x0',
  extraData: '0x',
  logsBloom: '0x' + '00'.repeat(256),
  nonce: '0x0000000000000000',
  transactions: [],
  uncles: [],
  sha3Uncles: '0x' + '00'.repeat(32),
  size: '0x0',
  stateRoot: '0x' + '00'.repeat(32),
  transactionsRoot: '0x' + '00'.repeat(32),
  receiptsRoot: '0x' + '00'.repeat(32),
  mixHash: '0x' + '00'.repeat(32),
};

async function request({
  method,
  params,
}: {
  method: string;
  params?: readonly unknown[];
}): Promise<unknown> {
  switch (method) {
    case 'eth_chainId':
      return '0x2105';
    case 'eth_blockNumber':
      return '0x64';
    case 'eth_getBlockByNumber':
      return STUB_BLOCK;
    case 'eth_maxPriorityFeePerGas':
      return '0x5f5e100';
    case 'eth_gasPrice':
      return '0x3b9aca00';
    case 'eth_getTransactionCount':
      return '0x0';
    case 'eth_estimateGas':
      return '0x186a0';
    case 'eth_call':
      return UNLIMITED_BUDGET;
    case 'eth_sendRawTransaction': {
      // The only state-changing RPC. Anything recorded here is real money.
      const tx = parseTransaction(params![0] as `0x${string}`);
      const decoded = decodeFunctionData({
        abi: AgentAccountV2Abi,
        data: tx.data as `0x${string}`,
      });
      writes.push({
        to: tx.to ?? undefined,
        functionName: decoded.functionName,
        args: (decoded.args ?? []) as readonly unknown[],
      });
      return '0x' + 'ab'.repeat(32);
    }
    default:
      throw new Error(`unstubbed RPC in x402 write-fencing harness: ${method}`);
  }
}

const account = privateKeyToAccount(AGENT_KEY);
const walletClient = createWalletClient({ account, chain: base, transport: custom({ request }) });
const publicClient = createPublicClient({ chain: base, transport: custom({ request }) });

/** Same shape agentwallet-sdk's own `createWallet` returns, minus the live RPC. */
const HARNESS_WALLET = {
  address: ACCOUNT_ADDRESS,
  contract: getContract({
    address: ACCOUNT_ADDRESS,
    abi: AgentAccountV2Abi,
    client: { public: publicClient, wallet: walletClient },
  }),
  publicClient,
  walletClient,
  chain: base,
};

vi.mock('../src/utils/client.js', () => ({
  getConfig: vi.fn(() => ({
    agentPrivateKey: ('0x' + '11'.repeat(32)) as `0x${string}`,
    walletAddress: '0x9999999999999999999999999999999999999999',
    chainId: 8453,
    rpcUrl: 'http://127.0.0.1:1',
  })),
  getWallet: vi.fn(() => HARNESS_WALLET),
  _resetSingletons: vi.fn(),
}));

import { handleX402Pay } from '../src/tools/x402.js';
import { handleX402SessionStart } from '../src/tools/session.js';
import { _clearAllSessions } from '../src/session/manager.js';

// ─── Hostile 402 server ────────────────────────────────────────────────────

function serve402(payTo: unknown, extra: Record<string, unknown> = {}): void {
  const body = JSON.stringify({
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base:8453',
        asset: USDC_BASE,
        amount: '1000000',
        payTo,
        ...extra,
      },
    ],
  });
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      call += 1;
      return call === 1
        ? new Response(body, { status: 402, headers: { 'content-type': 'application/json' } })
        : new Response('paid content', { status: 200 });
    })
  );
}

const PAY_INPUT = {
  url: 'https://merchant.example.com/paid',
  method: 'GET' as const,
  timeout_ms: 30000,
  skip_session_check: true,
};

const SESSION_INPUT = {
  endpoint: 'https://merchant.example.com/paid',
  method: 'GET' as const,
  scope: 'prefix' as const,
  timeout_ms: 30000,
};

describe('x402 on-chain write fencing (real agentwallet-sdk)', () => {
  beforeEach(() => {
    writes.length = 0;
    _clearAllSessions();
  });

  it('control: a canonical payTo does reach the chain, fee transfer first', async () => {
    // Establishes that this harness observes real writes — and reproduces the
    // ordering that makes a late rejection expensive: the 0.77% fee is
    // broadcast before the payee address is ever encoded.
    serve402(PAYEE);

    const result = await handleX402Pay(PAY_INPUT);

    expect(result.isError).toBeUndefined();
    expect(writes).toHaveLength(2);
    expect(writes[0]!.functionName).toBe('agentTransferToken');
    expect(writes[0]!.args[1]).toBe(FEE_COLLECTOR); // fee, sent first
    expect(writes[0]!.args[2]).toBe(7700n); // 1_000_000 * 77 / 10_000
    expect(writes[1]!.args[1]).toBe(PAYEE); // purchase
    expect(writes[1]!.args[2]).toBe(1000000n);
  });

  // Each of these is accepted by a `.trim()`-style guard but rejected by
  // viem's `encodeAddress` inside executePayment — i.e. exactly the shape that
  // used to burn the fee. `null` covers the non-string case JSON.parse allows.
  const HOSTILE_PAY_TO: Array<[string, unknown]> = [
    ['leading and trailing spaces', ` ${PAYEE} `],
    ['trailing newline', `${PAYEE}\n`],
    ['leading tab', `\t${PAYEE}`],
    ['mis-checksummed', '0xAbCdEf0123456789abcdef0123456789AbCdEf01'],
    ['non-string', { toString: () => PAYEE }],
    ['undefined', undefined],
  ];

  for (const [label, payTo] of HOSTILE_PAY_TO) {
    it(`x402_pay: ${label} payTo produces zero on-chain writes`, async () => {
      serve402(payTo);

      const result = await handleX402Pay(PAY_INPUT);

      // Rejection happens in onBeforePayment, which the SDK calls before
      // executePayment — so not even the fee transfer is broadcast.
      expect(writes).toEqual([]);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('did not sign a payment');
    });

    it(`x402_session_start: ${label} payTo produces zero on-chain writes`, async () => {
      serve402(payTo);

      const result = await handleX402SessionStart(SESSION_INPUT);

      expect(writes).toEqual([]);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('did not sign a payment');
    });
  }

  it('a hostile amount is rejected before any write, too', async () => {
    serve402(PAYEE, { amount: '1000000 ' });

    const result = await handleX402Pay(PAY_INPUT);

    expect(writes).toEqual([]);
    expect(result.isError).toBe(true);
  });

  it('a non-string scheme still yields the fenced diagnostic, not a crash', async () => {
    // The bot-reported payload, run through the real client rather than the
    // mocked one: `collectOfferedStrings` drops non-strings and
    // `sanitizeUntrustedInline` coerces unknown, so the full fail-closed
    // explanation survives instead of a `.replace is not a function` stub.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ accepts: [{ scheme: 1 }] }), {
            status: 402,
            headers: { 'content-type': 'application/json' },
          })
      )
    );

    const result = await handleX402Pay(PAY_INPUT);

    const text = result.content[0]!.text;
    expect(writes).toEqual([]);
    expect(result.isError).toBe(true);
    expect(text).not.toContain('is not a function');
    expect(text).toContain('Unsupported x402 Payment Requirement - Failed Closed');
    expect(text).toContain('Offered:   not parseable');
    expect(text).not.toContain('Schemes:');
  });
});
