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
import { assertConfiguredChain } from '../utils/wallet-chain.js'
import {
  DefiniteSpendFailure,
  IDEMPOTENCY_KEY_JSON_SCHEMA,
  sendTokenIntentIdentity,
  withSpendIntent,
} from '../utils/spend-intent.js'
import { enforceSpendPolicy } from './budget.js'

// ─── send_token ────────────────────────────────────────────────────────────

export const SendTokenSchema = z.object({
  tokenSymbol: z.string().describe('Token symbol, e.g. "USDC"'),
  chainId: z.number().int().describe('Chain ID where the token lives, e.g. 8453'),
  recipientAddress: z.string().describe('Recipient wallet address (0x-prefixed)'),
  amount: z
    .string()
    .describe('Amount in human-readable units, e.g. "10.5" for 10.5 USDC'),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Caller-supplied idempotency key. Distinct keys allow two equal payments; ' +
        'the same key replays the original transfer; reusing it with a different ' +
        'payload is refused. MCP retries without a key still collapse on the ' +
        'settled payload for five minutes.'
    ),
})

export type SendTokenInput = z.infer<typeof SendTokenSchema>

export const sendTokenTool = {
  name: 'send_token',
  description:
    'Send any ERC-20 token from the Agent Wallet to a recipient. ' +
    'Resolves the token address and decimals from the global registry, ' +
    'then calls agentTransferToken through the AgentAccountV2 contract. ' +
    'Subject to configured spend limits. Identical retries replay the original ' +
    'tx; pass idempotencyKey to distinguish two equal invoices. An RPC drop ' +
    'after broadcast fail-closes instead of sending a second transfer.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tokenSymbol: { type: 'string', description: 'Token symbol (e.g. "USDC", "WETH")' },
      chainId: { type: 'number', description: 'Chain ID (e.g. 8453 for Base Mainnet)' },
      recipientAddress: { type: 'string', description: 'Recipient address (0x-prefixed)' },
      amount: { type: 'string', description: 'Amount in human-readable units (e.g. "10.5")' },
      idempotencyKey: {
        ...IDEMPOTENCY_KEY_JSON_SCHEMA,
        description:
          'Optional idempotency key (1-128 non-whitespace chars). Distinct keys allow two equal payments.',
      },
    },
    required: ['tokenSymbol', 'chainId', 'recipientAddress', 'amount'],
  },
}

export async function handleSendToken(
  input: SendTokenInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    assertConfiguredChain(input.chainId, 'send_token')
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
    const intent = sendTokenIntentIdentity({
      chainId: input.chainId,
      tokenAddress: token.address,
      recipientAddress: input.recipientAddress,
      rawAmount,
      idempotencyKey: input.idempotencyKey,
    })

    const { value, replayed } = await withSpendIntent(intent.key, async () => {
      // rawAmount is in the token's base units; decimals lets the policy
      // normalise to its 18-decimal ETH-equivalent caps.
      const policyDecision = await enforceSpendPolicy({
        merchant: input.recipientAddress,
        amount: rawAmount,
        decimals: token.decimals,
      })
      if (policyDecision.status === 'rejected') {
        throw new DefiniteSpendFailure(
          policyDecision.reason ??
            `Transfer blocked by spend policy for recipient ${input.recipientAddress}.`
        )
      }
      if (policyDecision.status === 'draft') {
        throw new DefiniteSpendFailure(
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
        success: true as const,
        txHash,
        token: token.symbol,
        to: input.recipientAddress,
        amount: input.amount,
        rawAmount: rawAmount.toString(),
        chainId: input.chainId,
      }
    }, {
      durable: Boolean(input.idempotencyKey?.trim()),
      fingerprint: intent.fingerprint,
    })

    return {
      content: [
        textContent(
          JSON.stringify(
            replayed ? { ...value, idempotentRetry: true } : value
          )
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
    if (input.chainId !== undefined) {
      assertConfiguredChain(input.chainId, 'get_balances')
    }
    const wallet = getWallet()
    const config = getConfig()
    const chainId = config.chainId
    // Funds live on AgentAccountV2 (wallet.address). The viem walletClient
    // account is only the EOA signer and typically holds no tokens.
    const walletAddress = wallet.address ?? config.walletAddress

    const ctx: AnyCtx = {
      publicClient: wallet.publicClient,
      walletClient: wallet.walletClient,
      account: walletAddress,
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
            walletAddress,
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
