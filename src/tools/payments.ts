/**
 * payments.ts — send_payment tool.
 * Executes ETH or ERC20 token transfers via the AgentAccountV2 contract.
 */
import { z } from 'zod';
import { zeroAddress, type Address } from 'viem';
import { agentExecute, agentTransferToken, getGlobalRegistry } from 'agentwallet-sdk';
import { getWallet, getConfig } from '../utils/client.js';
import {
  textContent,
  explorerTxUrl,
  chainName,
  formatError,
} from '../utils/format.js';
import { enforceSpendPolicy } from './budget.js';

const NATIVE_TOKEN = zeroAddress;

// ─── Schema ────────────────────────────────────────────────────────────────

export const SendPaymentSchema = z.object({
  to: z
    .string()
    .describe('Recipient address (0x-prefixed, checksummed or lowercase)'),
  amount_eth: z
    .string()
    .describe(
      'Amount to send, expressed in ETH (e.g. "0.001"). ' +
      'For ERC20 tokens, this is the human-readable amount (e.g. "1.5" for 1.5 USDC). ' +
      'Use the token_decimals parameter to control precision.'
    ),
  token: z
    .string()
    .optional()
    .describe(
      'ERC20 token contract address. ' +
      'Omit or use "0x0000000000000000000000000000000000000000" for native ETH.'
    ),
  token_decimals: z
    .number()
    .int()
    .min(0)
    .max(18)
    .optional()
    .describe(
      'Token decimal places. Optional for native ETH (18) and registry-known tokens ' +
      '(e.g. USDC=6). Required for unknown ERC-20 addresses.'
    ),
  memo: z
    .string()
    .max(200)
    .optional()
    .describe('Optional memo/note for this payment (logged locally, not on-chain).'),
});

export type SendPaymentInput = z.infer<typeof SendPaymentSchema>;

// ─── Tool definition ───────────────────────────────────────────────────────

export const sendPaymentTool = {
  name: 'send_payment',
  description:
    'Send ETH or ERC20 tokens from the Agent Wallet. ' +
    'If the amount is within the configured spend limits, it executes immediately and returns the tx hash. ' +
    'If it exceeds limits, the transaction is queued for owner approval (use queue_approval to manage). ' +
    'Always check spend limits first with check_spend_limit to avoid surprises.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: {
        type: 'string',
        description: 'Recipient wallet address (0x-prefixed)',
      },
      amount_eth: {
        type: 'string',
        description: 'Amount in ETH (or token units). E.g. "0.001" for 0.001 ETH, "1.5" for 1.5 USDC',
      },
      token: {
        type: 'string',
        description: 'ERC20 token address. Omit for native ETH.',
      },
      token_decimals: {
        type: 'number',
        description:
          'Token decimals. Omit for ETH (18) or registry-known tokens like USDC (6). ' +
          'Required for unknown ERC-20 addresses.',
      },
      memo: {
        type: 'string',
        description: 'Optional memo for this payment (not stored on-chain)',
        maxLength: 200,
      },
    },
    required: ['to', 'amount_eth'],
  },
};

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleSendPayment(
  input: SendPaymentInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet();
    const config = getConfig();

    // Validate recipient address
    if (!input.to.startsWith('0x') || input.to.length !== 42) {
      throw new Error(
        `Invalid recipient address: "${input.to}". Must be a 0x-prefixed 42-character hex string.`
      );
    }
    const toAddress = input.to as Address;

    // Parse amount
    const amountCheck = parseFloat(input.amount_eth);
    if (isNaN(amountCheck) || amountCheck <= 0) {
      throw new Error(`Invalid amount: "${input.amount_eth}". Must be a positive number.`);
    }

    const isNativeEth = !input.token || input.token === NATIVE_TOKEN || input.token === '0x0000000000000000000000000000000000000000';
    const tokenAddress = isNativeEth ? NATIVE_TOKEN : (input.token as Address);
    const tokenLabel = isNativeEth ? 'ETH' : input.token ?? 'ETH';
    const decimals = resolveTokenDecimals(tokenAddress, input.token_decimals, config.chainId);
    const amountWei = parseTokenAmount(input.amount_eth, decimals);

    // Enforce in-process spend policy (set_spend_policy) before any transfer.
    // amountWei is in the token's own base units; decimals lets the policy
    // normalise to its 18-decimal ETH-equivalent caps.
    const policyDecision = await enforceSpendPolicy({
      merchant: toAddress,
      amount: amountWei,
      decimals,
    });
    if (policyDecision.status === 'rejected') {
      throw new Error(
        policyDecision.reason ??
          `Payment blocked by spend policy for recipient ${toAddress}.`
      );
    }
    if (policyDecision.status === 'draft') {
      throw new Error(
        `Payment exceeds per-tx spend policy and was queued as draft` +
          `${policyDecision.draftId ? ` (${policyDecision.draftId})` : ''}. ` +
          (policyDecision.reason ?? 'Approve the draft before executing.')
      );
    }

    let txHash: string;

    if (isNativeEth) {
      // Native ETH transfer via agentExecute
      const result = await agentExecute(wallet, {
        to: toAddress,
        value: amountWei,
      });
      txHash = result.txHash;
    } else {
      // ERC20 transfer via agentTransferToken
      txHash = await agentTransferToken(wallet, {
        token: tokenAddress,
        to: toAddress,
        amount: amountWei,
      });
    }

    const explorerUrl = explorerTxUrl(txHash as `0x${string}`, config.chainId);
    const memoLine = input.memo ? `\n📝 Memo: ${input.memo}` : '';

    return {
      content: [
        textContent(
          `✅ **Payment Sent**\n\n` +
          `  To:      ${toAddress}\n` +
          `  Amount:  ${input.amount_eth} ${tokenLabel}\n` +
          `  Token:   ${tokenLabel}\n` +
          `  Network: ${chainName(config.chainId)}\n` +
          `  TX Hash: ${txHash}\n` +
          `  🔗 ${explorerUrl}` +
          memoLine + '\n\n' +
          `ℹ️  If the transaction was over-limit, it was queued for owner approval.\n` +
          `   Use queue_approval (action="list") to check pending transactions.`
        ),
      ],
    };
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'send_payment'))],
      isError: true,
    };
  }
}

// ─── Token amount parser ───────────────────────────────────────────────────

/**
 * Resolve ERC-20 decimals from an explicit override or the TokenRegistry.
 * Never assume 18 decimals for an arbitrary token address — that silently
 * overpays by 10^12 for USDC (6 decimals) when callers omit token_decimals.
 */
export function resolveTokenDecimals(
  token: Address,
  explicitDecimals: number | undefined,
  chainId: number
): number {
  if (explicitDecimals !== undefined) return explicitDecimals;
  if (token === NATIVE_TOKEN) return 18;

  const entry = getGlobalRegistry().getTokenByAddress(token, chainId);
  if (entry) return entry.decimals;

  throw new Error(
    `Unknown decimals for token ${token} on chain ${chainId}. ` +
      'Pass token_decimals explicitly (use 6 for USDC).'
  );
}

/**
 * Parse a human-readable token amount string into base units (bigint).
 * Handles floating-point precision correctly without using JavaScript floats.
 * e.g., "1.5" with decimals=6 → 1500000n
 */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed || isNaN(Number(trimmed))) {
    throw new Error(`Invalid amount: "${amount}"`);
  }

  const [intPart, fracPart = ''] = trimmed.split('.');
  const fracTrimmed = fracPart.slice(0, decimals).padEnd(decimals, '0');
  const intStr = (intPart ?? '0') + fracTrimmed;

  return BigInt(intStr);
}
