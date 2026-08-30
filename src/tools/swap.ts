/**
 * swap.ts — swap_tokens tool.
 *
 * Wraps agentwallet-sdk v6 attachSwap / SwapModule (Uniswap V3).
 * Supported chains: base, arbitrum, optimism, polygon.
 */
import { z } from 'zod'
import { attachSwap, getGlobalRegistry, parseAmount } from 'agentwallet-sdk'
import type { Address } from 'viem'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWallet = any
import { getWallet } from '../utils/client.js'
import { assertConfiguredChain } from '../utils/wallet-chain.js'
import { textContent, formatError } from '../utils/format.js'
import { enforceSpendPolicy } from './budget.js'

// ─── Schema ────────────────────────────────────────────────────────────────

export const SwapTokensSchema = z.object({
  fromSymbol: z.string().describe('Symbol of the token to sell, e.g. "USDC"'),
  toSymbol: z.string().describe('Symbol of the token to buy, e.g. "WETH"'),
  amount: z.string().describe('Amount to sell in human-readable units, e.g. "100" for 100 USDC'),
  chainId: z
    .number()
    .int()
    .describe('Chain ID of the configured wallet (must match CHAIN_ID, e.g. 8453)'),
  slippageBps: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe('Slippage tolerance in basis points (default: 50 = 0.5%)'),
})

export type SwapTokensInput = z.infer<typeof SwapTokensSchema>

// ─── Tool definition ───────────────────────────────────────────────────────

export const swapTokensTool = {
  name: 'swap_tokens',
  description:
    'Swap one ERC-20 token for another using Uniswap V3. ' +
    'Resolves token addresses from the registry, executes the swap via SwapModule. ' +
    'Supported chains: base (8453), arbitrum (42161), optimism (10), polygon (137).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      fromSymbol: { type: 'string', description: 'Symbol of token to sell (e.g. "USDC")' },
      toSymbol: { type: 'string', description: 'Symbol of token to buy (e.g. "WETH")' },
      amount: { type: 'string', description: 'Amount to sell in human-readable units' },
      chainId: {
        type: 'number',
        description: 'Chain ID of the configured wallet (must match CHAIN_ID; 8453=Base Mainnet)',
      },
      slippageBps: { type: 'number', description: 'Slippage in basis points (default: 50)' },
    },
    required: ['fromSymbol', 'toSymbol', 'amount', 'chainId'],
  },
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleSwapTokens(
  input: SwapTokensInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet()
    const registry = getGlobalRegistry()
    const chainId = assertConfiguredChain(input.chainId)

    const fromToken = registry.getToken(input.fromSymbol.toUpperCase(), chainId)
    if (!fromToken) {
      throw new Error(
        `Token "${input.fromSymbol}" not found for chain ${input.chainId}. ` +
        'Use add_custom_token to register it first.'
      )
    }

    const toToken = registry.getToken(input.toSymbol.toUpperCase(), chainId)
    if (!toToken) {
      throw new Error(
        `Token "${input.toSymbol}" not found for chain ${input.chainId}. ` +
        'Use add_custom_token to register it first.'
      )
    }

    const rawAmountIn = parseAmount(input.amount, fromToken.decimals)

    // Enforce the in-process spend policy on the amount sold before swapping.
    // rawAmountIn is in fromToken base units (e.g. 6 decimals for USDC);
    // enforceSpendPolicy normalises it to the policy's 18-decimal
    // ETH-equivalent caps (1 whole token counts as 1 ETH-equivalent). The SDK
    // SwapModule custodies tokens at — and sends swap proceeds to — the agent
    // smart-account address (attachSwap passes wallet.address as
    // accountAddress and uses it as the swap recipient), so that address is
    // the policy merchant: allowlist-only policies must include the agent
    // wallet (smart-account) address to permit swaps.
    const swapRecipient = wallet.address
    if (!swapRecipient) {
      throw new Error('Wallet has no address; cannot verify spend policy for swap_tokens.')
    }
    const policyDecision = await enforceSpendPolicy({
      merchant: swapRecipient,
      amount: rawAmountIn,
      decimals: fromToken.decimals,
    })
    if (policyDecision.status === 'rejected') {
      throw new Error(
        policyDecision.reason ??
          `Swap blocked by spend policy for wallet ${swapRecipient}.`
      )
    }
    if (policyDecision.status === 'draft') {
      throw new Error(
        `Swap exceeds per-tx spend policy and was queued as draft` +
          `${policyDecision.draftId ? ` (${policyDecision.draftId})` : ''}. ` +
          (policyDecision.reason ?? 'Approve the draft before executing.')
      )
    }

    const swapWallet = attachSwap(wallet as AnyWallet)

    const result = await swapWallet.swap(
      fromToken.address as Address,
      toToken.address as Address,
      rawAmountIn,
      { slippageBps: input.slippageBps }
    )

    return {
      content: [
        textContent(
          JSON.stringify({
            success: true,
            txHash: result.txHash,
            feeTxHash: result.feeTxHash ?? null,
            approvalRequired: result.approvalRequired,
            approvalTxHash: result.approvalTxHash ?? null,
            fromToken: fromToken.symbol,
            toToken: toToken.symbol,
            amountIn: input.amount,
            rawAmountIn: rawAmountIn.toString(),
            quote: result.quote
              ? {
                  amountInNet: result.quote.amountInNet?.toString(),
                  amountOutMinimum: result.quote.amountOutMinimum?.toString(),
                  poolFeeTier: result.quote.poolFeeTier,
                  feeAmount: result.quote.feeAmount?.toString(),
                  gasEstimate: result.quote.gasEstimate?.toString(),
                }
              : null,
            chainId,
          })
        ),
      ],
    }
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'swap_tokens'))],
      isError: true,
    }
  }
}
