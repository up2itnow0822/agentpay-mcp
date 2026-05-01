/**
 * history.ts — get_transaction_history tool.
 * Queries on-chain event logs for the wallet's transaction history.
 */
import { z } from 'zod';
import { getActivityHistory } from 'agentwallet-sdk';
import { getWallet, getConfig } from '../utils/client.js';
import {
  textContent,
  explorerTxUrl,
  chainName,
  formatEth,
  formatError,
} from '../utils/format.js';
import type { ActivityEntry } from 'agentwallet-sdk';

// ─── Schema ────────────────────────────────────────────────────────────────

export const GetTransactionHistorySchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .default(20)
    .describe('Maximum number of entries to return (default: 20, max: 100)'),
  from_block: z
    .string()
    .optional()
    .describe('Start block number (hex or decimal string). Defaults to recent history.'),
  to_block: z
    .string()
    .optional()
    .describe('End block number. Defaults to latest.'),
  event_type: z
    .enum(['all', 'execution', 'queued', 'approved', 'cancelled', 'policy_update', 'operator_update'])
    .optional()
    .default('all')
    .describe('Filter by event type (default: all)'),
});

export type GetTransactionHistoryInput = z.infer<typeof GetTransactionHistorySchema>;

// ─── Tool definition ───────────────────────────────────────────────────────

export const getTransactionHistoryTool = {
  name: 'get_transaction_history',
  description:
    'Retrieve the wallet\'s recent on-chain transaction history from event logs. ' +
    'Shows executions, queued transactions, approvals, cancellations, ' +
    'spend policy updates, and operator changes. ' +
    'Filter by event type or block range for targeted queries.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      limit: {
        type: 'number',
        description: 'Max entries to return (default: 20, max: 100)',
        default: 20,
      },
      from_block: {
        type: 'string',
        description: 'Start block (decimal string). Defaults to 1000 blocks ago.',
      },
      to_block: {
        type: 'string',
        description: 'End block (decimal string). Defaults to latest.',
      },
      event_type: {
        type: 'string',
        enum: ['all', 'execution', 'queued', 'approved', 'cancelled', 'policy_update', 'operator_update'],
        description: 'Filter by event type (default: all)',
        default: 'all',
      },
    },
    required: [],
  },
};

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleGetTransactionHistory(
  input: GetTransactionHistoryInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet();
    const config = getConfig();

    // Default: look back ~1000 blocks if no range specified
    let fromBlock: bigint | undefined;
    let toBlock: bigint | undefined;

    if (input.from_block) {
      fromBlock = BigInt(input.from_block);
    } else {
      // Get current block and look back ~1000 blocks
      const latest = await wallet.publicClient.getBlockNumber();
      fromBlock = latest > 1000n ? latest - 1000n : 0n;
    }

    if (input.to_block) {
      toBlock = BigInt(input.to_block);
    }

    const allEntries = await getActivityHistory(wallet, {
      fromBlock,
      toBlock,
    });

    // Filter by event type
    const eventType = input.event_type ?? 'all';
    const filtered = eventType === 'all'
      ? allEntries
      : allEntries.filter((e) => e.type === eventType);

    // Apply limit (most recent first after sort)
    const limit = input.limit ?? 20;
    const recent = filtered.slice(-limit).reverse();

    if (recent.length === 0) {
      return {
        content: [
          textContent(
            `📜 **Transaction History**\n\n` +
            `No transactions found in the queried range.\n\n` +
            `  Block range: ${fromBlock?.toString() ?? '0'} → ${toBlock?.toString() ?? 'latest'}\n` +
            `  Event type:  ${eventType}\n\n` +
            `Try expanding the from_block range for older history.`
          ),
        ],
      };
    }

    let out = `📜 **Transaction History** (${recent.length} entries)\n`;
    out += `  Chain:       ${chainName(config.chainId)}\n`;
    out += `  Block range: ${fromBlock?.toString() ?? '0'} → ${toBlock?.toString() ?? 'latest'}\n`;
    out += `  Filter:      ${eventType}\n\n`;

    for (const entry of recent) {
      out += formatActivityEntry(entry, config.chainId);
      out += '\n';
    }

    return { content: [textContent(out)] };
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'get_transaction_history'))],
      isError: true,
    };
  }
}

// ─── Entry formatter ───────────────────────────────────────────────────────

function formatActivityEntry(entry: ActivityEntry, chainId: number): string {
  const emoji = typeEmoji(entry.type);
  const label = typeLabel(entry.type);
  const txUrl = explorerTxUrl(entry.transactionHash, chainId);

  let out = `${emoji} **${label}**\n`;
  out += `   Block:  ${entry.blockNumber.toString()}\n`;
  out += `   TX:     ${entry.transactionHash}\n`;
  out += `   🔗 ${txUrl}\n`;

  // Format args based on type
  const args = entry.args as Record<string, unknown>;

  if (entry.type === 'execution' && args) {
    if (args['target']) out += `   To:     ${args['target']}\n`;
    if (args['value'] !== undefined) out += `   Value:  ${formatEth(BigInt(String(args['value'])))}\n`;
    if (args['executor']) out += `   By:     ${args['executor']}\n`;
  }

  if (entry.type === 'queued' && args) {
    if (args['txId'] !== undefined) out += `   Queue ID: ${args['txId']}\n`;
    if (args['to']) out += `   To:       ${args['to']}\n`;
    if (args['value'] !== undefined) out += `   Value:    ${formatEth(BigInt(String(args['value'])))}\n`;
  }

  if (entry.type === 'approved' && args) {
    if (args['txId'] !== undefined) out += `   Queue ID: ${args['txId']}\n`;
  }

  if (entry.type === 'cancelled' && args) {
    if (args['txId'] !== undefined) out += `   Queue ID: ${args['txId']}\n`;
  }

  if (entry.type === 'policy_update' && args) {
    if (args['token']) out += `   Token:   ${args['token']}\n`;
    if (args['perTxLimit'] !== undefined) out += `   Per-tx:  ${formatEth(BigInt(String(args['perTxLimit'])))}\n`;
    if (args['periodLimit'] !== undefined) out += `   Period:  ${formatEth(BigInt(String(args['periodLimit'])))}\n`;
  }

  if (entry.type === 'operator_update' && args) {
    if (args['operator']) out += `   Operator:  ${args['operator']}\n`;
    if (args['authorized'] !== undefined) out += `   Status:    ${args['authorized'] ? '✅ Added' : '❌ Removed'}\n`;
  }

  return out;
}

function typeEmoji(type: ActivityEntry['type']): string {
  const map: Record<ActivityEntry['type'], string> = {
    execution: '⚡',
    queued: '⏳',
    approved: '✅',
    cancelled: '🚫',
    policy_update: '📋',
    operator_update: '🔑',
  };
  return map[type] ?? '📄';
}

function typeLabel(type: ActivityEntry['type']): string {
  const map: Record<ActivityEntry['type'], string> = {
    execution: 'Transaction Executed',
    queued: 'Transaction Queued',
    approved: 'Transaction Approved',
    cancelled: 'Transaction Cancelled',
    policy_update: 'Spend Policy Updated',
    operator_update: 'Operator Updated',
  };
  return map[type] ?? type;
}
