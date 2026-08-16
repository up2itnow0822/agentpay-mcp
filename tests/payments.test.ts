/**
 * Tests for send_payment, check_spend_limit, queue_approval, and parseTokenAmount.
 * All blockchain calls are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

vi.mock('agentwallet-sdk', () => ({
  agentExecute: vi.fn(),
  agentTransferToken: vi.fn(),
  checkBudget: vi.fn(),
  getBudgetForecast: vi.fn(),
  getPendingApprovals: vi.fn(),
  approveTransaction: vi.fn(),
  cancelTransaction: vi.fn(),
  getWalletHealth: vi.fn(),
  createWallet: vi.fn(),
  SpendingPolicy: vi.fn(),
  getGlobalRegistry: vi.fn(() => ({
    getTokenByAddress: (address: string, chainId: number) => {
      if (
        chainId === 8453 &&
        address.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
      ) {
        return { symbol: 'USDC', decimals: 6, address, chainId };
      }
      return undefined;
    },
    getToken: () => undefined,
  })),
}));

// ─── Mock client utils ─────────────────────────────────────────────────────

const MOCK_WALLET = {
  address: '0x1234567890123456789012345678901234567890' as `0x${string}`,
  publicClient: { getBalance: vi.fn() },
  walletClient: {},
  contract: {},
  chain: { id: 8453 },
};

vi.mock('../src/utils/client.js', () => ({
  getConfig: vi.fn(() => ({
    agentPrivateKey: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    walletAddress: '0x1234567890123456789012345678901234567890',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
  })),
  getWallet: vi.fn(() => MOCK_WALLET),
  _resetSingletons: vi.fn(),
}));

import {
  handleSendPayment,
  parseTokenAmount,
  resolveTokenDecimals,
} from '../src/tools/payments.js';
import {
  handleCheckSpendLimit,
  handleQueueApproval,
} from '../src/tools/wallet.js';
import {
  handleSetSpendPolicy,
  _resetPolicyStore,
} from '../src/tools/budget.js';
import {
  agentExecute,
  agentTransferToken,
  checkBudget,
  getBudgetForecast,
  getPendingApprovals,
  approveTransaction,
  cancelTransaction,
  SpendingPolicy,
} from 'agentwallet-sdk';

const mockAgentExecute = vi.mocked(agentExecute);
const mockAgentTransferToken = vi.mocked(agentTransferToken);
const mockCheckBudget = vi.mocked(checkBudget);
const mockGetBudgetForecast = vi.mocked(getBudgetForecast);
const mockGetPendingApprovals = vi.mocked(getPendingApprovals);
const mockApproveTransaction = vi.mocked(approveTransaction);
const mockCancelTransaction = vi.mocked(cancelTransaction);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`;
const MOCK_TX_HASH = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as `0x${string}`;

// ─── parseTokenAmount tests ────────────────────────────────────────────────

describe('parseTokenAmount', () => {
  it('parses integer amounts', () => {
    expect(parseTokenAmount('1', 18)).toBe(1000000000000000000n);
  });

  it('parses decimal amounts with 18 decimals', () => {
    expect(parseTokenAmount('0.001', 18)).toBe(1000000000000000n);
  });

  it('parses USDC amounts (6 decimals)', () => {
    expect(parseTokenAmount('1.5', 6)).toBe(1500000n);
    expect(parseTokenAmount('100', 6)).toBe(100000000n);
  });

  it('truncates excess decimal places', () => {
    // 0.0000000000000000001 ETH with 18 decimals = 0 (too small)
    expect(parseTokenAmount('0.0000000000000000001', 18)).toBe(0n);
  });

  it('handles whole numbers correctly', () => {
    expect(parseTokenAmount('5', 6)).toBe(5000000n);
  });

  it('throws on invalid input', () => {
    expect(() => parseTokenAmount('not-a-number', 18)).toThrow();
  });

  it('handles zero', () => {
    expect(parseTokenAmount('0', 18)).toBe(0n);
  });
});

// ─── send_payment tests ────────────────────────────────────────────────────

describe('resolveTokenDecimals', () => {
  it('defaults native ETH to 18 decimals', () => {
    expect(
      resolveTokenDecimals(
        '0x0000000000000000000000000000000000000000',
        undefined,
        8453
      )
    ).toBe(18);
  });

  it('uses the registry for known USDC addresses', () => {
    expect(resolveTokenDecimals(USDC_BASE as `0x${string}`, undefined, 8453)).toBe(6);
  });
});

describe('send_payment tool', () => {
  const VALID_TO = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

  beforeEach(() => {
    vi.clearAllMocks();
    _resetPolicyStore();
    vi.mocked(SpendingPolicy).mockImplementation(function () {
      return { check: vi.fn().mockResolvedValue({ status: 'approved' }) };
    } as any);
    mockAgentExecute.mockResolvedValue({
      executed: true,
      txHash: MOCK_TX_HASH,
    });
    mockAgentTransferToken.mockResolvedValue(MOCK_TX_HASH);
  });

  // ─── Happy path: ETH ────────────────────────────────────────────────────

  it('sends native ETH successfully', async () => {
    const result = await handleSendPayment({
      to: VALID_TO,
      amount_eth: '0.001',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('Payment Sent');
    expect(result.content[0]!.text).toContain(VALID_TO);
    expect(result.content[0]!.text).toContain('ETH');
    expect(mockAgentExecute).toHaveBeenCalledOnce();
  });

  it('uses agentExecute for native ETH (not agentTransferToken)', async () => {
    await handleSendPayment({
      to: VALID_TO,
      amount_eth: '0.5',
    });

    expect(mockAgentExecute).toHaveBeenCalledOnce();
    expect(mockAgentTransferToken).not.toHaveBeenCalled();
  });

  it('includes explorer URL in success response', async () => {
    const result = await handleSendPayment({
      to: VALID_TO,
      amount_eth: '0.001',
    });

    expect(result.content[0]!.text).toContain('basescan.org');
    expect(result.content[0]!.text).toContain(MOCK_TX_HASH);
  });

  // ─── Happy path: ERC20 ──────────────────────────────────────────────────

  it('sends ERC20 tokens using agentTransferToken', async () => {
    const result = await handleSendPayment({
      to: VALID_TO,
      amount_eth: '10',
      token: USDC_BASE,
      token_decimals: 6,
    });

    expect(result.isError).toBeFalsy();
    expect(mockAgentTransferToken).toHaveBeenCalledOnce();
    expect(mockAgentExecute).not.toHaveBeenCalled();

    // 10 USDC = 10_000_000 base units
    const callArgs = mockAgentTransferToken.mock.calls[0]![1];
    expect(callArgs.amount).toBe(10_000_000n);
  });

  it('resolves USDC decimals from the registry when token_decimals is omitted', async () => {
    const result = await handleSendPayment({
      to: VALID_TO,
      amount_eth: '1',
      token: USDC_BASE,
    });

    expect(result.isError).toBeFalsy();
    const callArgs = mockAgentTransferToken.mock.calls[0]![1];
    // 1 USDC with 6 decimals — NOT 1e18 (the old catastrophic default)
    expect(callArgs.amount).toBe(1_000_000n);
  });

  it('rejects unknown ERC-20 tokens when token_decimals is omitted', async () => {
    const result = await handleSendPayment({
      to: VALID_TO,
      amount_eth: '1',
      token: '0x1111111111111111111111111111111111111111',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Unknown decimals');
    expect(mockAgentTransferToken).not.toHaveBeenCalled();
  });

  it('blocks payments that violate set_spend_policy allowlists', async () => {
    const check = vi.fn().mockResolvedValue({
      status: 'rejected',
      reason: 'Merchant "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" is not on the allowlist.',
    });
    vi.mocked(SpendingPolicy).mockImplementation(function () {
      return { check };
    } as any);

    await handleSetSpendPolicy({
      allowedRecipients: ['0x0000000000000000000000000000000000000001'],
    });

    const result = await handleSendPayment({
      to: VALID_TO,
      amount_eth: '0.001',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('allowlist');
    expect(mockAgentExecute).not.toHaveBeenCalled();
  });

  it('includes memo in response when provided', async () => {
    const result = await handleSendPayment({
      to: VALID_TO,
      amount_eth: '0.001',
      memo: 'Payment for API access',
    });

    expect(result.content[0]!.text).toContain('Payment for API access');
  });

  it('treats zero address as native ETH', async () => {
    await handleSendPayment({
      to: VALID_TO,
      amount_eth: '0.1',
      token: ZERO_ADDRESS,
    });

    expect(mockAgentExecute).toHaveBeenCalledOnce();
    expect(mockAgentTransferToken).not.toHaveBeenCalled();
  });

  // ─── Error paths ────────────────────────────────────────────────────────

  it('returns error for invalid recipient address', async () => {
    const result = await handleSendPayment({
      to: 'not-an-address',
      amount_eth: '0.001',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('❌');
    expect(result.content[0]!.text).toContain('Invalid recipient');
  });

  it('returns error for invalid amount', async () => {
    const result = await handleSendPayment({
      to: VALID_TO,
      amount_eth: '-1',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('❌');
  });

  it('returns error for non-numeric amount', async () => {
    const result = await handleSendPayment({
      to: VALID_TO,
      amount_eth: 'one ETH',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('❌');
  });

  it('handles SDK error gracefully', async () => {
    mockAgentExecute.mockRejectedValueOnce(new Error('Insufficient gas'));

    const result = await handleSendPayment({
      to: VALID_TO,
      amount_eth: '0.001',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Insufficient gas');
  });
});

// ─── check_spend_limit tests ───────────────────────────────────────────────

describe('check_spend_limit tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckBudget.mockResolvedValue({
      token: ZERO_ADDRESS,
      perTxLimit: 1_000_000_000_000_000n, // 0.001 ETH
      remainingInPeriod: 10_000_000_000_000_000n, // 0.01 ETH
    });
    mockGetBudgetForecast.mockResolvedValue({
      token: ZERO_ADDRESS,
      perTxLimit: 1_000_000_000_000_000n,
      remainingInPeriod: 10_000_000_000_000_000n,
      periodLimit: 100_000_000_000_000_000n,
      periodLength: 86400,
      periodSpent: 90_000_000_000_000_000n,
      periodStart: Math.floor(Date.now() / 1000) - 3600,
      secondsUntilReset: 82800,
      utilizationPercent: 90,
    });
  });

  it('reports approved for within-limit amount', async () => {
    const result = await handleCheckSpendLimit({
      amount_eth: '0.0001', // under 0.001 ETH per-tx limit
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('APPROVED');
  });

  it('reports queued for over-limit amount', async () => {
    const result = await handleCheckSpendLimit({
      amount_eth: '0.01', // over 0.001 ETH per-tx limit
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('QUEUED');
  });

  it('reports blocked when no spend policy configured', async () => {
    mockCheckBudget.mockResolvedValueOnce({
      token: ZERO_ADDRESS,
      perTxLimit: 0n,
      remainingInPeriod: 0n,
    });
    mockGetBudgetForecast.mockResolvedValueOnce({
      token: ZERO_ADDRESS,
      perTxLimit: 0n,
      remainingInPeriod: 0n,
      periodLimit: 0n,
      periodLength: 0,
      periodSpent: 0n,
      periodStart: 0,
      secondsUntilReset: 0,
      utilizationPercent: 0,
    });

    const result = await handleCheckSpendLimit({
      amount_eth: '0.001',
    });

    expect(result.content[0]!.text).toContain('BLOCKED');
  });

  it('includes reset time in response', async () => {
    const result = await handleCheckSpendLimit({
      amount_eth: '0.0001',
    });

    expect(result.content[0]!.text).toMatch(/Resets in/);
  });

  it('returns error for negative amount', async () => {
    const result = await handleCheckSpendLimit({
      amount_eth: '-0.5',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('❌');
  });

  it('returns error for invalid amount string', async () => {
    const result = await handleCheckSpendLimit({
      amount_eth: 'abc',
    });

    expect(result.isError).toBe(true);
  });

  it('rejects comma-formatted amount ("1,000") instead of checking limits for 1 ETH', async () => {
    const result = await handleCheckSpendLimit({
      amount_eth: '1,000',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Invalid amount: "1,000"');
    expect(mockCheckBudget).not.toHaveBeenCalled();
  });

  it('rejects exponent, hex, multi-dot, and empty amounts', async () => {
    for (const bad of ['1e3', '0x10', '1.2.3', '']) {
      const result = await handleCheckSpendLimit({
        amount_eth: bad,
      });

      expect(result.isError, `amount_eth "${bad}" should be rejected`).toBe(true);
      expect(result.content[0]!.text).toContain('Invalid amount');
    }
    expect(mockCheckBudget).not.toHaveBeenCalled();
  });

  it('rejects amounts with more than 18 decimal places', async () => {
    const result = await handleCheckSpendLimit({
      amount_eth: '0.0000000000000000001', // 19 decimal places
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Too many decimal places (max 18)');
  });

  it('checks the exact wei amount for high-precision values (no float rounding)', async () => {
    // parseFloat collapses this 17-decimal value to exactly 1 ETH.
    const result = await handleCheckSpendLimit({
      amount_eth: '1.00000000000000001',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('1.00000000000000001 ETH');
  });

  it('accepts whitespace-padded amounts (" 0.0001 ")', async () => {
    const result = await handleCheckSpendLimit({
      amount_eth: ' 0.0001 ',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('APPROVED');
  });

  it('handles SDK error gracefully', async () => {
    mockCheckBudget.mockRejectedValueOnce(new Error('RPC timeout'));

    const result = await handleCheckSpendLimit({
      amount_eth: '0.001',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('RPC timeout');
  });
});

// ─── queue_approval tests ──────────────────────────────────────────────────

describe('queue_approval tool', () => {
  const MOCK_PENDING = [
    {
      txId: 0n,
      to: '0xrecipient000000000000000000000000000000' as `0x${string}`,
      value: 1_000_000_000_000_000n,
      data: '0x' as `0x${string}`,
      token: ZERO_ADDRESS,
      amount: 0n,
      createdAt: Math.floor(Date.now() / 1000) - 3600,
      executed: false,
      cancelled: false,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPendingApprovals.mockResolvedValue(MOCK_PENDING);
    mockApproveTransaction.mockResolvedValue(MOCK_TX_HASH);
    mockCancelTransaction.mockResolvedValue(MOCK_TX_HASH);
  });

  it('lists pending transactions', async () => {
    const result = await handleQueueApproval({ action: 'list' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('Pending Approvals');
    expect(result.content[0]!.text).toContain('Queue ID'); // txId shown
  });

  it('shows empty state when no pending transactions', async () => {
    mockGetPendingApprovals.mockResolvedValueOnce([]);

    const result = await handleQueueApproval({ action: 'list' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]!.text).toContain('No transactions awaiting approval');
  });

  it('approves a transaction by ID', async () => {
    const result = await handleQueueApproval({
      action: 'approve',
      tx_id: '0',
    });

    expect(result.isError).toBeFalsy();
    expect(mockApproveTransaction).toHaveBeenCalledWith(expect.anything(), 0n);
    expect(result.content[0]!.text).toContain('approved');
  });

  it('cancels a transaction by ID', async () => {
    const result = await handleQueueApproval({
      action: 'cancel',
      tx_id: '0',
    });

    expect(result.isError).toBeFalsy();
    expect(mockCancelTransaction).toHaveBeenCalledWith(expect.anything(), 0n);
    expect(result.content[0]!.text).toContain('cancelled');
  });

  it('returns error when tx_id missing for approve', async () => {
    const result = await handleQueueApproval({
      action: 'approve',
      // no tx_id
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('❌');
    expect(result.content[0]!.text).toContain('tx_id');
  });

  it('returns error when tx_id missing for cancel', async () => {
    const result = await handleQueueApproval({
      action: 'cancel',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('tx_id');
  });

  it('handles SDK error on approve gracefully', async () => {
    mockApproveTransaction.mockRejectedValueOnce(new Error('Not authorized'));

    const result = await handleQueueApproval({
      action: 'approve',
      tx_id: '0',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Not authorized');
  });

  it('handles SDK error on list gracefully', async () => {
    mockGetPendingApprovals.mockRejectedValueOnce(new Error('Network error'));

    const result = await handleQueueApproval({ action: 'list' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Network error');
  });
});
