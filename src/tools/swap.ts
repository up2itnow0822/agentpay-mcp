/** swap_tokens — disabled on agentwallet-sdk 7.0.0 (CTO route A). */
import { z } from 'zod'
import { textContent, formatError } from '../utils/format.js'
import { DefiniteSpendFailure, IdempotencyKeyZodSchema, IDEMPOTENCY_KEY_JSON_SCHEMA } from '../utils/spend-intent.js'

export const SWAP_DISABLED_MESSAGE =
  'swap_tokens is disabled in agentpay-mcp 5.0.0 while pinned to agentwallet-sdk 7.0.0. ' +
  'SDK 7 cannot enforce an independent swap output floor on the AgentAccountV2 path; ' +
  'upgrade to a future release with agentwallet-sdk 8.x.'

export const SwapTokensSchema = z.object({
  fromSymbol: z.string(),
  toSymbol: z.string(),
  amount: z.string(),
  chainId: z.number().int(),
  slippageBps: z.number().int().min(0).max(10000).optional(),
  idempotencyKey: IdempotencyKeyZodSchema.optional(),
})

export type SwapTokensInput = z.infer<typeof SwapTokensSchema>

export const swapTokensTool = {
  name: 'swap_tokens',
  description: 'Swap ERC-20 tokens via Uniswap V3 (disabled on SDK 7.0.0).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      fromSymbol: { type: 'string' },
      toSymbol: { type: 'string' },
      amount: { type: 'string' },
      chainId: { type: 'number' },
      slippageBps: { type: 'number' },
      idempotencyKey: { ...IDEMPOTENCY_KEY_JSON_SCHEMA },
    },
    required: ['fromSymbol', 'toSymbol', 'amount', 'chainId'],
  },
}

export async function handleSwapTokens(_input: SwapTokensInput) {
  try {
    throw new DefiniteSpendFailure(SWAP_DISABLED_MESSAGE)
  } catch (error: unknown) {
    return { content: [textContent(formatError(error, 'swap_tokens'))], isError: true }
  }
}