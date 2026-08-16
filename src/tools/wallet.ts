/**
 * wallet.ts — get_wallet_info, check_spend_limit, queue_approval tools.
 */
import { z } from 'zod';
import { zeroAddress, type Address } from 'viem';
import {
  checkBudget,
  getBudgetForecast,
  getWalletHealth,
  getPendingApprovals,
  approveTransaction,
  cancelTransaction,
} from 'agentwallet-sdk';
import { getWallet, getConfig } from '../utils/client.js';
import { parseAmountStrict } from '../utils/amount.js';
import {
  textContent,
  formatEth,
  formatSpendLimit,
  formatDuration,
  formatTimestamp,
  utilizationBadge,
  explorerAddressUrl,
  chainName,
  formatError,
  formatSuccess,
} from '../utils/format.js';

// ─── NATIVE_TOKEN constant ────────────────────────────────────────────────

const NATIVE_TOKEN = zeroAddress;

// ─── get_wallet_info ───────────────────────────────────────────────────────

export const GetWalletInfoSchema = z.object({
  token: z
    .string()
    .optional()
    .describe(
      'Token address to check budget for. ' +
      'Use "0x0000000000000000000000000000000000000000" for ETH (default). ' +
      'Or use a USDC/ERC20 contract address.'
    ),
});

export type GetWalletInfoInput = z.infer<typeof GetWalletInfoSchema>;

export const getWalletInfoTool = {
  name: 'get_wallet_info',
  description:
    'Get comprehensive wallet information including address, on-chain balance, ' +
    'spend limits, remaining period allowance, and queue depth. ' +
    'Use token parameter to check budget for a specific ERC20 (defaults to ETH).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      token: {
        type: 'string',
        description:
          'Token address to check. Use "0x0000000000000000000000000000000000000000" for ETH (default).',
      },
    },
    required: [],
  },
};

export async function handleGetWalletInfo(
  input: GetWalletInfoInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet();
    const config = getConfig();
    const token = (input.token as Address | undefined) ?? NATIVE_TOKEN;
    const tokenLabel = token === NATIVE_TOKEN ? 'ETH' : token;

    // Parallel fetches for speed
    const [forecast, health, ethBalance] = await Promise.all([
      getBudgetForecast(wallet, token).catch(() => null),
      getWalletHealth(wallet, [], [token]).catch(() => null),
      wallet.publicClient.getBalance({ address: config.walletAddress }).catch(() => null),
    ]);

    const explorerUrl = explorerAddressUrl(config.walletAddress, config.chainId);
    const cname = chainName(config.chainId);

    let out = `📊 **Agent Wallet Info**\n\n`;
    out += `📍 Address: ${config.walletAddress}\n`;
    out += `🌐 Chain: ${cname}\n`;
    out += `🔗 Explorer: ${explorerUrl}\n\n`;

    if (ethBalance !== null) {
      out += `💰 ETH Balance: ${formatEth(ethBalance)}\n\n`;
    }

    if (forecast) {
      const badge = utilizationBadge(forecast.utilizationPercent);
      out += `📈 **Spend Limits (${tokenLabel})**\n`;
      out += `  Per-tx limit:     ${formatSpendLimit(forecast.perTxLimit)}\n`;
      out += `  Period limit:     ${formatSpendLimit(forecast.periodLimit)}\n`;
      out += `  Period spent:     ${formatEth(forecast.periodSpent)}\n`;
      out += `  Remaining:        ${formatEth(forecast.remainingInPeriod)}\n`;
      out += `  Utilization:      ${forecast.utilizationPercent}% ${badge}\n`;
      out += `  Period length:    ${formatDuration(forecast.periodLength)}\n`;
      out += `  Period started:   ${formatTimestamp(forecast.periodStart)}\n`;
      out += `  Resets in:        ${formatDuration(forecast.secondsUntilReset)}\n\n`;
    }

    if (health) {
      out += `🔧 **Wallet Health**\n`;
      out += `  NFT contract:     ${health.tokenContract}\n`;
      out += `  NFT token ID:     ${health.tokenId.toString()}\n`;
      out += `  Operator epoch:   ${health.operatorEpoch.toString()}\n`;
      out += `  Pending queue:    ${health.pendingQueueDepth} transaction(s) awaiting approval\n`;
    }

    return { content: [textContent(out)] };
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'get_wallet_info'))],
      isError: true,
    };
  }
}

// ─── check_spend_limit ─────────────────────────────────────────────────────

export const CheckSpendLimitSchema = z.object({
  amount_eth: z
    .string()
    .describe('Amount in ETH to check (e.g. "0.01"). Use this for native ETH payments.'),
  token: z
    .string()
    .optional()
    .describe(
      'Token contract address to check against. ' +
      'Omit or use zero address for ETH.'
    ),
});

export type CheckSpendLimitInput = z.infer<typeof CheckSpendLimitSchema>;

export const checkSpendLimitTool = {
  name: 'check_spend_limit',
  description:
    'Check whether a proposed payment amount is within the wallet\'s autonomous spend limits. ' +
    'Returns a clear yes/no with remaining budget details. ' +
    'Use this before send_payment to avoid surprise queuing.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      amount_eth: {
        type: 'string',
        description: 'Amount in ETH to check (e.g. "0.01")',
      },
      token: {
        type: 'string',
        description: 'Token address. Omit for native ETH.',
      },
    },
    required: ['amount_eth'],
  },
};

export async function handleCheckSpendLimit(
  input: CheckSpendLimitInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet();
    const token = (input.token as Address | undefined) ?? NATIVE_TOKEN;
    const tokenLabel = token === NATIVE_TOKEN ? 'ETH' : token;

    // Parse amount (ETH string → wei bigint) — strict string parsing, no float rounding
    const ETH_DECIMALS = 18;
    const amountWei = parseAmountStrict(input.amount_eth, ETH_DECIMALS);

    const budget = await checkBudget(wallet, token);
    const forecast = await getBudgetForecast(wallet, token);

    const perTxOk = amountWei <= budget.perTxLimit && budget.perTxLimit > 0n;
    const periodOk = amountWei <= budget.remainingInPeriod && budget.remainingInPeriod > 0n;
    const canExecute = perTxOk && periodOk;

    let out = `🔍 **Spend Limit Check**\n\n`;
    out += `  Token:            ${tokenLabel}\n`;
    out += `  Amount:           ${formatEth(amountWei)}\n\n`;
    out += `  Per-tx limit:     ${formatSpendLimit(budget.perTxLimit)}\n`;
    out += `  Within per-tx:    ${perTxOk ? '✅ Yes' : '❌ No (exceeds per-tx limit)'}\n\n`;
    out += `  Remaining period: ${formatEth(budget.remainingInPeriod)}\n`;
    out += `  Within period:    ${periodOk ? '✅ Yes' : '❌ No (would exceed period budget)'}\n\n`;
    out += `  Resets in:        ${formatDuration(forecast.secondsUntilReset)}\n\n`;

    if (canExecute) {
      out += `✅ **APPROVED** — This payment can execute autonomously.\n`;
    } else if (budget.perTxLimit === 0n) {
      out += `🚫 **BLOCKED** — No spend policy configured for ${tokenLabel}. Set a spend policy first.\n`;
    } else {
      out += `⏳ **QUEUED** — This payment will be queued for owner approval.\n`;
      if (!perTxOk) {
        out += `   Reason: Amount exceeds per-tx limit of ${formatEth(budget.perTxLimit)}.\n`;
      } else {
        out += `   Reason: Amount exceeds remaining period budget of ${formatEth(budget.remainingInPeriod)}.\n`;
        out += `   Budget resets in: ${formatDuration(forecast.secondsUntilReset)}\n`;
      }
    }

    return { content: [textContent(out)] };
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'check_spend_limit'))],
      isError: true,
    };
  }
}

// ─── queue_approval ────────────────────────────────────────────────────────

export const QueueApprovalSchema = z.object({
  action: z
    .enum(['list', 'approve', 'cancel'])
    .describe(
      '"list" — show all pending transactions awaiting approval. ' +
      '"approve" — approve a queued transaction by ID. ' +
      '"cancel" — cancel a queued transaction by ID.'
    ),
  tx_id: z
    .string()
    .optional()
    .describe('Transaction queue ID (required for approve and cancel actions).'),
});

export type QueueApprovalInput = z.infer<typeof QueueApprovalSchema>;

export const queueApprovalTool = {
  name: 'queue_approval',
  description:
    'Manage over-limit transactions queued for owner review. ' +
    'Use action="list" to see pending transactions, ' +
    '"approve" to approve one by ID, or "cancel" to cancel one by ID. ' +
    'Approve/cancel require the agent key to have owner privileges.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'approve', 'cancel'],
        description: 'Action: "list", "approve", or "cancel"',
      },
      tx_id: {
        type: 'string',
        description: 'Transaction queue ID (required for approve/cancel)',
      },
    },
    required: ['action'],
  },
};

export async function handleQueueApproval(
  input: QueueApprovalInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet();
    const config = getConfig();

    if (input.action === 'list') {
      const pending = await getPendingApprovals(wallet, 0n);

      if (pending.length === 0) {
        return {
          content: [
            textContent(`📋 **Pending Approvals**\n\nNo transactions awaiting approval. ✅`),
          ],
        };
      }

      let out = `📋 **Pending Approvals** (${pending.length} transaction${pending.length > 1 ? 's' : ''})\n\n`;
      for (const tx of pending) {
        out += `─────────────────────────\n`;
        out += `  Queue ID:   ${tx.txId.toString()}\n`;
        out += `  To:         ${tx.to}\n`;
        out += `  Value:      ${formatEth(tx.value)}\n`;
        out += `  Token:      ${tx.token === NATIVE_TOKEN ? 'ETH' : tx.token}\n`;
        if (tx.token !== NATIVE_TOKEN) {
          out += `  Amount:     ${tx.amount.toString()} (base units)\n`;
        }
        out += `  Queued at:  ${formatTimestamp(tx.createdAt)}\n`;
        out += '\n';
      }
      out += `Use action="approve" with tx_id to approve, or action="cancel" to cancel.`;

      return { content: [textContent(out)] };
    }

    if (input.action === 'approve' || input.action === 'cancel') {
      if (!input.tx_id) {
        throw new Error(`tx_id is required for action="${input.action}"`);
      }

      const txId = BigInt(input.tx_id);
      let txHash: string;

      if (input.action === 'approve') {
        txHash = await approveTransaction(wallet, txId);
        return {
          content: [
            textContent(
              formatSuccess(`Transaction ${txId.toString()} approved!`, {
                'Approval TX': txHash,
                'Chain': chainName(config.chainId),
              })
            ),
          ],
        };
      } else {
        txHash = await cancelTransaction(wallet, txId);
        return {
          content: [
            textContent(
              formatSuccess(`Transaction ${txId.toString()} cancelled.`, {
                'Cancel TX': txHash,
              })
            ),
          ],
        };
      }
    }

    throw new Error(`Unknown action: ${input.action}`);
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'queue_approval'))],
      isError: true,
    };
  }
}
