/**
 * swap.ts — swap_tokens tool.
 *
 * Route A (MCP 5.0.0): disabled — schema retained, no on-chain execution.
 */
import { z } from 'zod'
import { textContent, formatError } from '../utils/format.js'
import {
  DefiniteSpendFailure,
  IDEMPOTENCY_KEY_JSON_SCHEMA,
  IdempotencyKeyZodSchema,
} from '../utils/spend-intent.js'

// ─── Schema ────────────────────────────────────────────────────────────────

export const SwapTokensSchema = z.object({
  fromSymbol: z.string().describe('Symbol of the token to sell, e.g. "USDC"'),
  toSymbol: z.string().describe('Symbol of the token to buy, e.g. "WETH"'),
  amount: z.string().describe('Amount to sell in human-readable units, e.g. "100" for 100 USDC'),
  chainId: z
    .number()
    .int()
    .describe('Chain ID where the swap would execute (e.g. 8453 for Base Mainnet)'),
  slippageBps: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe('Slippage tolerance in basis points (default: 50 = 0.5%)'),
  minAmountOut: z
    .string()
    .describe(
      'Minimum output amount in human units of the buy token (required when swaps are enabled).'
    ),
  idempotencyKey: IdempotencyKeyZodSchema.optional()
    .describe(
      'Caller-supplied idempotency key. Distinct keys allow two equal swaps; ' +
        'the same key replays the original swap when swaps are enabled.'
    ),
})

export type SwapTokensInput = z.infer<typeof SwapTokensSchema>

// ─── Tool definition ───────────────────────────────────────────────────────

export const swapTokensTool = {
  name: 'swap_tokens',
  description:
    'Swap one ERC-20 token for another using Uniswap V3. ' +
    'DISABLED in AgentPay MCP 5.0.0 (route A): the tool is registered for schema ' +
    'compatibility and returns a disabled error without any on-chain swap.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      fromSymbol: { type: 'string', description: 'Symbol of token to sell (e.g. "USDC")' },
      toSymbol: { type: 'string', description: 'Symbol of token to buy (e.g. "WETH")' },
      amount: { type: 'string', description: 'Amount to sell in human-readable units' },
      chainId: { type: 'number', description: 'Chain ID (8453=Base, 42161=Arbitrum, 10=Optimism, 137=Polygon)' },
      slippageBps: {
        type: 'number',
        description: 'Slippage tolerance in basis points (50 = 0.5%)',
      },
      minAmountOut: {
        type: 'string',
        description: 'Minimum output amount in human units of the buy token',
      },
      idempotencyKey: {
        ...IDEMPOTENCY_KEY_JSON_SCHEMA,
        description: 'Optional idempotency key when swaps are enabled in a future release.',
      },
    },
    required: ['fromSymbol', 'toSymbol', 'amount', 'chainId', 'minAmountOut'],
  },
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleSwapTokens(
  _input: SwapTokensInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    throw new DefiniteSpendFailure(
      'swap_tokens is disabled in AgentPay MCP 5.0.0 (route A). ' +
        'The tool keeps its schema for compatibility; no on-chain swap is performed.'
    )
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'swap_tokens'))],
      isError: true,
    }
  }
}