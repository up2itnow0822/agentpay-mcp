/**
 * escrow.ts — create_escrow tool.
 *
 * Wraps agentwallet-sdk v6 MutualStakeEscrow for on-chain mutual-stake escrow creation.
 */
import { z } from 'zod'
import { MutualStakeEscrow } from 'agentwallet-sdk'
import type { Address } from 'viem'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any
import { getWallet, getConfig } from '../utils/client.js'
import { textContent, formatError } from '../utils/format.js'
import { enforceSpendPolicy } from './budget.js'

// ─── Schema ────────────────────────────────────────────────────────────────

export const CreateEscrowSchema = z.object({
  counterpartyAddress: z
    .string()
    .describe('Seller / counterparty address (0x-prefixed)'),
  stakeAmount: z
    .string()
    .describe('Payment amount in human-readable USDC units, e.g. "100" for 100 USDC'),
  terms: z
    .string()
    .describe('Human-readable description of the escrow terms'),
  factoryAddress: z
    .string()
    .optional()
    .describe(
      'StakeVaultFactory contract address. ' +
      'Defaults to FACTORY_ADDRESS env var.'
    ),
  deadlineDays: z
    .number()
    .int()
    .min(1)
    .optional()
    .default(7)
    .describe('Deadline in days from now (default: 7)'),
  challengeWindowHours: z
    .number()
    .int()
    .min(1)
    .optional()
    .default(24)
    .describe('Challenge window in hours after fulfillment (default: 24)'),
})

export type CreateEscrowInput = z.infer<typeof CreateEscrowSchema>

// ─── Tool definition ───────────────────────────────────────────────────────

export const createEscrowTool = {
  name: 'create_escrow',
  description:
    'Create a mutual-stake escrow vault between the Agent Wallet (buyer) and a counterparty (seller). ' +
    'Both parties lock collateral (equal to payment amount) ensuring aligned incentives. ' +
    'Uses USDC as the payment token. Requires FACTORY_ADDRESS env var or factoryAddress param.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      counterpartyAddress: {
        type: 'string',
        description: 'Seller / counterparty address (0x-prefixed)',
      },
      stakeAmount: {
        type: 'string',
        description: 'Payment amount in human-readable USDC units (e.g. "100")',
      },
      terms: {
        type: 'string',
        description: 'Human-readable description of the escrow terms',
      },
      factoryAddress: {
        type: 'string',
        description: 'StakeVaultFactory address (optional if FACTORY_ADDRESS env var set)',
      },
      deadlineDays: {
        type: 'number',
        description: 'Deadline in days from now (default: 7)',
        default: 7,
      },
      challengeWindowHours: {
        type: 'number',
        description: 'Challenge window in hours (default: 24)',
        default: 24,
      },
    },
    required: ['counterpartyAddress', 'stakeAmount', 'terms'],
  },
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleCreateEscrow(
  input: CreateEscrowInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet()
    const config = getConfig()

    const factoryAddress =
      (input.factoryAddress as Address | undefined) ??
      (config.factoryAddress as Address | undefined)

    if (!factoryAddress) {
      throw new Error(
        'factoryAddress is required. Pass it as a parameter or set FACTORY_ADDRESS env var.'
      )
    }

    // Parse USDC amount (6 decimals)
    const USDC_DECIMALS = 6
    const amountFloat = parseFloat(input.stakeAmount)
    if (isNaN(amountFloat) || amountFloat <= 0) {
      throw new Error(`Invalid stakeAmount: "${input.stakeAmount}". Must be a positive number.`)
    }
    const paymentAmount = BigInt(Math.round(amountFloat * 10 ** USDC_DECIMALS))

    // Enforce the in-process spend policy before creating the escrow. The
    // buyer commits paymentAmount plus an equal buyerStake, so the policy is
    // checked against the total buyer commitment (2× paymentAmount) in USDC
    // 6-decimal base units; enforceSpendPolicy normalises that to the
    // policy's 18-decimal ETH-equivalent caps (1 USDC counts as
    // 1 ETH-equivalent) — never compare 6-decimal base units against
    // wei-scale caps directly. The merchant is the escrow counterparty.
    const buyerCommitment = paymentAmount * 2n // paymentAmount + buyerStake
    const policyDecision = await enforceSpendPolicy({
      merchant: input.counterpartyAddress,
      amount: buyerCommitment,
      decimals: USDC_DECIMALS,
    })
    if (policyDecision.status === 'rejected') {
      throw new Error(
        policyDecision.reason ??
          `Escrow creation blocked by spend policy for counterparty ${input.counterpartyAddress}.`
      )
    }
    if (policyDecision.status === 'draft') {
      throw new Error(
        `Escrow commitment exceeds per-tx spend policy and was queued as draft` +
          `${policyDecision.draftId ? ` (${policyDecision.draftId})` : ''}. ` +
          (policyDecision.reason ?? 'Approve the draft before executing.')
      )
    }

    // Deadline: N days from now
    const deadlineSecs = input.deadlineDays ?? 7
    const deadline = Math.floor(Date.now() / 1000) + deadlineSecs * 86400

    // Challenge window in seconds
    const challengeWindowHours = input.challengeWindowHours ?? 24
    const challengeWindow = challengeWindowHours * 3600

    const escrow = new MutualStakeEscrow({
      publicClient: wallet.publicClient as AnyClient,
      walletClient: wallet.walletClient as AnyClient,
      factoryAddress,
      chainId: config.chainId,
    })

    const result = await escrow.create({
      seller: input.counterpartyAddress as Address,
      paymentAmount,
      buyerStake: paymentAmount,
      sellerStake: paymentAmount,
      verifier: 'optimistic' as const,
      deadline,
      challengeWindow,
    })

    return {
      content: [
        textContent(
          JSON.stringify({
            success: true,
            vaultAddress: result.address,
            txHash: result.txHash,
            buyer: wallet.walletClient.account!.address,
            seller: input.counterpartyAddress,
            paymentAmount: input.stakeAmount,
            rawPaymentAmount: paymentAmount.toString(),
            terms: input.terms,
            deadline: new Date(deadline * 1000).toISOString(),
            challengeWindowHours,
          })
        ),
      ],
    }
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'create_escrow'))],
      isError: true,
    }
  }
}
