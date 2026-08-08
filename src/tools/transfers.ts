/**
 * transfers.ts — send_token, get_balances tools.
 *
 * Wraps agentwallet-sdk v6 agentTransferToken + getBalances.
 */
import { z } from 'zod'
import { getGlobalRegistry, agentTransferToken, getBalances, parseAmount } from 'agentwallet-sdk'
import type { Address } from 'viem'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCtx = any
import { getWallet, getConfig } from '../utils/client.js'
import { textContent, formatError } from '../utils/format.js'
import { enforceSpendPolicy } from './budget.js'

// ─── send_token ────────────────────────────────────────────────────────────

export const SendTokenSchema = z.object({
  tokenSymbol: z.string().describe('Token symbol, e.g. "USDC"'),
  chainId: z.number().int().describe('Chain ID where the token lives, e.g. 8453'),
  recipientAddress: z.string().describe('Recipient wallet address (0x-prefixed)'),
  amount: z
    .string()
    .describe('Amount in human-readable units, e.g. "10.5" for 10.5 USDC'),
})

export type SendTokenInput = z.infer<typeof SendTokenSchema>

export const sendTokenTool = {
  name: 'send_token',
  description:
    'Send any ERC-20 token from the Agent Wallet to a recipient. ' +
    'Resolves the token address and decimals from the global registry, ' +
    'then calls agentTransferToken through the AgentAccountV2 contract. ' +
    'Subject to configured spend limits.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tokenSymbol: { type: 'string', description: 'Token symbol (e.g. "USDC", "WETH")' },
      chainId: { type: 'number', description: 'Chain ID (e.g. 8453 for Base Mainnet)' },
      recipientAddress: { type: 'string', description: 'Recipient address (0x-prefixed)' },
      amount: { type: 'string', description: 'Amount in human-readable units (e.g. "10.5")' },
    },
    required: ['tokenSymbol', 'chainId', 'recipientAddress', 'amount'],
  },
}

export async function handleSendToken(
  input: SendTokenInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet()
    const registry = getGlobalRegistry()

    const token = registry.getToken(input.tokenSymbol.toUpperCase(), input.chainId)
    if (!token) {
      throw new Error(
        `Token "${input.tokenSymbol}" not found for chain ${input.chainId}. ` +
        'Use add_custom_token to register it first.'
      )
    }

    const rawAmount = parseAmount(input.amount, token.decimals)

    const policyDecision = await enforceSpendPolicy({
      merchant: input.recipientAddress,
      amount: rawAmount,
    })
    if (policyDecision.status === 'rejected') {
      throw new Error(
        policyDecision.reason ??
          `Transfer blocked by spend policy for recipient ${input.recipientAddress}.`
      )
    }
    if (policyDecision.status === 'draft') {
      throw new Error(
        `Transfer exceeds per-tx spend policy and was queued as draft` +
          `${policyDecision.draftId ? ` (${policyDecision.draftId})` : ''}. ` +
          (policyDecision.reason ?? 'Approve the draft before executing.')
      )
    }

    const txHash = await agentTransferToken(wallet, {
      token: token.address as Address,
      to: input.recipientAddress as Address,
      amount: rawAmount,
    })

    return {
      content: [
        textContent(
          JSON.stringify({
            success: true,
            txHash,
            token: token.symbol,
            to: input.recipientAddress,
            amount: input.amount,
            rawAmount: rawAmount.toString(),
            chainId: input.chainId,
          })
        ),
      ],
    }
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'send_token'))],
      isError: true,
    }
  }
}

// ─── get_balances ──────────────────────────────────────────────────────────

export const GetBalancesSchema = z.object({
  chainId: z
    .number()
    .int()
    .optional()
    .describe('Chain ID to query balances on. Defaults to the configured wallet chain.'),
})

export type GetBalancesInput = z.infer<typeof GetBalancesSchema>

export const getBalancesTool = {
  name: 'get_balances',
  description:
    'Get all ERC-20 token balances for the configured Agent Wallet address. ' +
    'Uses the global token registry to enumerate tokens for the given chain.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      chainId: {
        type: 'number',
        description: 'Chain ID (defaults to the configured wallet chain)',
      },
    },
    required: [],
  },
}

export async function handleGetBalances(
  input: GetBalancesInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet()
    const config = getConfig()
    const chainId = input.chainId ?? config.chainId

    const ctx: AnyCtx = {
      publicClient: wallet.publicClient,
      walletClient: wallet.walletClient,
      account: wallet.walletClient.account!.address,
      chainId,
    }

    const balances = await getBalances(ctx)

    // Serialize bigints to strings for JSON
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialized = balances.map((b: any) => ({
      ...b,
      rawBalance: typeof b.rawBalance === 'bigint' ? b.rawBalance.toString() : b.rawBalance,
    }))

    return {
      content: [
        textContent(
          JSON.stringify({
            walletAddress: wallet.walletClient.account!.address,
            chainId,
            count: serialized.length,
            balances: serialized,
          })
        ),
      ],
    }
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'get_balances'))],
      isError: true,
    }
  }
}
