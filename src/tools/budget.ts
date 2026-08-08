/**
 * budget.ts — set_spend_policy, check_budget tools.
 *
 * set_spend_policy: configure a SpendingPolicy (in-process, persists for server lifetime).
 * check_budget: query on-chain remaining budget via checkBudget().
 */
import { z } from 'zod'
import { SpendingPolicy, checkBudget } from 'agentwallet-sdk'
import { parseEther, zeroAddress, type Address } from 'viem'
import { getWallet } from '../utils/client.js'
import { textContent, formatError } from '../utils/format.js'

// ─── Module-level policy store ─────────────────────────────────────────────

interface PolicyConfig {
  dailyLimitEth?: string
  perTxCapEth?: string
  allowedRecipients?: string[]
}

const DEFAULT_POLICY_SCOPE = 'global'
const _policyConfigByScope = new Map<string, PolicyConfig>()
const _spendingPolicyByScope = new Map<string, InstanceType<typeof SpendingPolicy>>()

export function _resetPolicyStore(): void {
  _policyConfigByScope.clear()
  _spendingPolicyByScope.clear()
}

export type SpendPolicyDecision =
  | { status: 'approved' }
  | { status: 'rejected' | 'draft'; reason?: string; draftId?: string }

/**
 * Enforce the in-process spend policy for a payment attempt.
 * If no policy is configured for the scope, the payment is allowed.
 */
export async function enforceSpendPolicy(input: {
  scopeKey?: string
  merchant: string
  /** Base units as bigint or number. BigInt is preferred for large ETH amounts. */
  amount: number | bigint
}): Promise<SpendPolicyDecision> {
  const scopeKey = input.scopeKey?.trim() || DEFAULT_POLICY_SCOPE
  const policy = _spendingPolicyByScope.get(scopeKey)
  if (!policy) return { status: 'approved' }

  // SpendingPolicy stores caps as JS numbers; only enforce when amount fits safely.
  const amountNumber =
    typeof input.amount === 'bigint' ? Number(input.amount) : input.amount
  if (!Number.isSafeInteger(amountNumber)) {
    return {
      status: 'rejected',
      reason:
        'Payment amount exceeds safe numeric range for in-process spend policy checks. ' +
        'Reduce the amount or clear the spend policy.',
    }
  }

  const result = await policy.check({
    merchant: input.merchant,
    amount: amountNumber,
  })

  if (result.status === 'approved') return { status: 'approved' }
  return {
    status: result.status,
    reason: result.reason,
    draftId: result.draftId,
  }
}

// ─── set_spend_policy ──────────────────────────────────────────────────────

export const SetSpendPolicySchema = z.object({
  scopeKey: z
    .string()
    .optional()
    .describe('Optional session/scope key. Defaults to "global".'),
  dailyLimitEth: z
    .string()
    .optional()
    .describe('Daily spend limit in ETH-equivalent, e.g. "0.1"'),
  perTxCapEth: z
    .string()
    .optional()
    .describe('Per-transaction cap in ETH-equivalent, e.g. "0.01"'),
  allowedRecipients: z
    .array(z.string())
    .optional()
    .describe('Allowlist of recipient addresses (0x-prefixed). Empty = all allowed.'),
})

export type SetSpendPolicyInput = z.infer<typeof SetSpendPolicySchema>

export const setSpendPolicyTool = {
  name: 'set_spend_policy',
  description:
    'Configure the Agent Wallet spend policy. ' +
    'Sets a daily limit, per-transaction cap, and optional recipient allowlist. ' +
    'The policy is enforced in-process for the lifetime of the MCP server.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      scopeKey: {
        type: 'string',
        description: 'Optional session/scope key (default: "global")',
      },
      dailyLimitEth: {
        type: 'string',
        description: 'Daily spend limit in ETH-equivalent (e.g. "0.1")',
      },
      perTxCapEth: {
        type: 'string',
        description: 'Per-tx cap in ETH-equivalent (e.g. "0.01")',
      },
      allowedRecipients: {
        type: 'array',
        items: { type: 'string' },
        description: 'Allowlisted recipient addresses',
      },
    },
    required: [],
  },
}

export async function handleSetSpendPolicy(
  input: SetSpendPolicyInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const ethToWeiNumber = (eth: string): number => {
      const normalized = eth.trim()
      if (normalized.length === 0) throw new Error(`Invalid ETH amount: "${eth}"`)
      if (!/^\d*\.?\d+$/.test(normalized)) throw new Error(`Invalid ETH amount: "${eth}"`)

      const wei = parseEther(normalized)
      if (wei <= 0n) throw new Error(`Invalid ETH amount: "${eth}"`)
      const weiAsNumber = Number(wei)
      if (!Number.isFinite(weiAsNumber)) {
        throw new Error(`ETH amount is too large: "${eth}"`)
      }
      return weiAsNumber
    }

    const scopeKey = input.scopeKey?.trim() || DEFAULT_POLICY_SCOPE
    const merchantAllowlist = input.allowedRecipients ?? []

    // Build SpendingPolicyConfig from inputs
    // rollingCap uses a 24-hour window for dailyLimitEth
    const rollingCap = input.dailyLimitEth
      ? {
          maxAmount: ethToWeiNumber(input.dailyLimitEth),
          windowMs: 86_400_000, // 24 hours
        }
      : undefined

    // draftThreshold maps to perTxCap — payments above this go to draft
    const draftThreshold = input.perTxCapEth
      ? ethToWeiNumber(input.perTxCapEth)
      : undefined

    _spendingPolicyByScope.set(scopeKey, new SpendingPolicy({
      merchantAllowlist,
      rollingCap,
      draftThreshold,
    }))

    _policyConfigByScope.set(scopeKey, {
      dailyLimitEth: input.dailyLimitEth,
      perTxCapEth: input.perTxCapEth,
      allowedRecipients: merchantAllowlist,
    })

    return {
      content: [
        textContent(
          JSON.stringify({
            success: true,
            scopeKey,
            policy: {
              dailyLimitEth: input.dailyLimitEth ?? null,
              perTxCapEth: input.perTxCapEth ?? null,
              allowedRecipients: merchantAllowlist,
            },
          })
        ),
      ],
    }
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'set_spend_policy'))],
      isError: true,
    }
  }
}

// ─── check_budget ──────────────────────────────────────────────────────────

export const CheckBudgetSchema = z.object({
  scopeKey: z
    .string()
    .optional()
    .describe('Optional session/scope key. Defaults to "global".'),
  token: z
    .string()
    .optional()
    .describe(
      'Token address to check budget for. ' +
      'Use "0x0000000000000000000000000000000000000000" for ETH (default). ' +
      'Or a USDC/ERC20 contract address.'
    ),
})

export type CheckBudgetInput = z.infer<typeof CheckBudgetSchema>

export const checkBudgetTool = {
  name: 'check_budget',
  description:
    'Check the remaining on-chain budget for the Agent Wallet. ' +
    'Returns per-transaction limit and period remaining. ' +
    'Optionally include any configured spend policy details.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      scopeKey: {
        type: 'string',
        description: 'Optional session/scope key (default: "global")',
      },
      token: {
        type: 'string',
        description: 'Token address (default: ETH / zero address)',
      },
    },
    required: [],
  },
}

export async function handleCheckBudget(
  input: CheckBudgetInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet()
    const scopeKey = input.scopeKey?.trim() || DEFAULT_POLICY_SCOPE
    const token = (input.token as Address | undefined) ?? zeroAddress

    const budget = await checkBudget(wallet, token)

    return {
      content: [
        textContent(
          JSON.stringify({
            token,
            scopeKey,
            perTxLimit: budget.perTxLimit.toString(),
            remainingInPeriod: budget.remainingInPeriod.toString(),
            policy: _policyConfigByScope.get(scopeKey) ?? null,
          })
        ),
      ],
    }
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'check_budget'))],
      isError: true,
    }
  }
}
