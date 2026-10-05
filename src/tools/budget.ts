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
import { DefiniteSpendFailure } from '../utils/spend-intent.js'

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

export interface SpendReservation {
  amount: number
  policies: Array<InstanceType<typeof SpendingPolicy>>
}

type SpendWindowEntry = { amount: number; ts: number }

function getSpendWindow(
  policy: InstanceType<typeof SpendingPolicy>
): SpendWindowEntry[] | undefined {
  const window = (policy as unknown as { spendWindow?: SpendWindowEntry[] }).spendWindow
  return Array.isArray(window) ? window : undefined
}

/**
 * Undo a reservation recorded by SpendingPolicy.check() on approve.
 * Pops the last matching rolling-window entry from each reserved policy.
 */
export function releaseSpendReservation(
  reservation: SpendReservation | null | undefined
): void {
  if (!reservation) {
    return
  }
  for (const policy of reservation.policies) {
    const window = getSpendWindow(policy)
    if (!window || window.length === 0) {
      continue
    }
    for (let i = window.length - 1; i >= 0; i--) {
      if (window[i]!.amount === reservation.amount) {
        window.splice(i, 1)
        break
      }
    }
  }
}

/**
 * Reserve spend (policy.check records on approve), run the attempt, then
 * settle | release | hold-unknown. Definite not-charged failures release
 * the reservation so a retry can use the same remaining cap.
 */
export async function withReservedSpend<T>(
  input: {
    merchant: string
    amount: number | bigint
    decimals: number | (() => number)
  },
  run: () => Promise<T>
): Promise<T> {
  const { decision, reservation } = await reserveSpendPolicy(input)
  if (decision.status === 'rejected') {
    throw new DefiniteSpendFailure(
      decision.reason ?? `Spend blocked by spend policy for ${input.merchant}.`
    )
  }
  if (decision.status === 'draft') {
    throw new DefiniteSpendFailure(
      `Payment exceeds per-tx spend policy and was queued as draft` +
        `${decision.draftId ? ` (${decision.draftId})` : ''}. ` +
        (decision.reason ?? 'Approve the draft before executing.')
    )
  }
  try {
    return await run()
  } catch (error: unknown) {
    if (error instanceof DefiniteSpendFailure) {
      releaseSpendReservation(reservation)
    }
    throw error
  }
}

/**
 * Enforce the in-process spend policy for a payment attempt.
 * If no policy is configured at all, the payment is allowed.
 *
 * Scopes: every configured policy — the "global" scope and any policy set
 * under a custom scopeKey — is enforced together (union). All of them must
 * approve; the first rejection or draft decision wins. This keeps scoped
 * policies fail-closed: a policy stored under any scopeKey is consulted on
 * every value-moving path, never silently ignored.
 *
 * Units: `amount` is in the asset's own base units (wei for ETH, 1e-6 for
 * USDC), with `decimals` naming that asset's decimals. Policy caps from
 * set_spend_policy are stored in 18-decimal "ETH-equivalent" units
 * (parseEther of the human string), so the amount is normalised here by
 * scaling base units × 10^(18 - decimals) before comparison. One whole token
 * therefore counts as 1 ETH-equivalent: with perTxCapEth "5", a 10 USDC
 * payment (10_000_000 base units → 1e19) is over the 5e18 cap and blocked.
 * Never compare 6-decimal USDC base units against wei-scale caps directly —
 * that silently loosens every cap by a factor of 1e12.
 *
 * `decimals` may be a thunk so that asset-decimal resolution (which can throw
 * for unregistered assets) only runs when a policy is actually configured.
 *
 * Fail closed: ANY error while evaluating the policy — decimals resolution,
 * numeric conversion, or the policy engine itself — rejects the payment, and
 * unrecognised policy statuses are treated as rejections.
 */
export async function reserveSpendPolicy(input: {
  merchant: string
  /** Amount in the asset's base units. BigInt is preferred for exactness. */
  amount: number | bigint
  /** Decimals of the asset `amount` is denominated in (0–18), or a thunk. */
  decimals: number | (() => number)
}): Promise<{ decision: SpendPolicyDecision; reservation: SpendReservation | null }> {
  const policies = Array.from(_spendingPolicyByScope.entries())
  if (policies.length === 0) {
    return { decision: { status: 'approved' }, reservation: null }
  }

  try {
    const decimals =
      typeof input.decimals === 'function' ? input.decimals() : input.decimals
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
      return {
        decision: {
          status: 'rejected',
          reason:
            `Spend policy check failed (fail-closed): unsupported asset decimals ` +
            `${String(decimals)}. Expected an integer between 0 and 18.`,
        },
        reservation: null,
      }
    }

    const baseUnits =
      typeof input.amount === 'bigint' ? input.amount : BigInt(input.amount)
    if (baseUnits < 0n) {
      return {
        decision: {
          status: 'rejected',
          reason: 'Spend policy check failed (fail-closed): negative amount.',
        },
        reservation: null,
      }
    }

    // Normalise to the policy's canonical 18-decimal ETH-equivalent scale.
    const scaled = baseUnits * 10n ** BigInt(18 - decimals)

    // SpendingPolicy tracks amounts as JS numbers. Convert exactly where
    // possible; when the bigint exceeds float precision and rounds down,
    // bias one ULP upward so boundary comparisons fail closed (the policy
    // must never see less than the true amount).
    let amountNumber = Number(scaled)
    if (!Number.isFinite(amountNumber)) {
      return {
        decision: {
          status: 'rejected',
          reason:
            'Spend policy check failed (fail-closed): amount too large to evaluate. ' +
            'Reduce the amount or clear the spend policy.',
        },
        reservation: null,
      }
    }
    if (BigInt(amountNumber) < scaled) {
      amountNumber *= 1 + Number.EPSILON
    }

    const snapshots = policies.map(([, policy]) => ({
      policy,
      beforeLength: getSpendWindow(policy)?.length ?? 0,
    }))
    const reservedPolicies: Array<InstanceType<typeof SpendingPolicy>> = []

    for (const [scope, policy] of policies) {
      const result = await policy.check({
        merchant: input.merchant,
        amount: amountNumber,
      })

      if (result.status === 'approved') {
        const afterLength = getSpendWindow(policy)?.length ?? 0
        if (afterLength > (snapshots.find((s) => s.policy === policy)?.beforeLength ?? 0)) {
          reservedPolicies.push(policy)
        }
        continue
      }
      if (result.status === 'draft') {
        releaseSpendReservation({ amount: amountNumber, policies: reservedPolicies })
        return {
          decision: { status: 'draft', reason: result.reason, draftId: result.draftId },
          reservation: null,
        }
      }
      // 'rejected' and anything unrecognised both deny.
      releaseSpendReservation({ amount: amountNumber, policies: reservedPolicies })
      return {
        decision: {
          status: 'rejected',
          reason:
            result.reason ??
            `Spend policy (scope "${scope}") returned unexpected status ` +
              `"${String(result.status)}" (fail-closed).`,
        },
        reservation: null,
      }
    }
    return {
      decision: { status: 'approved' },
      reservation:
        reservedPolicies.length > 0
          ? { amount: amountNumber, policies: reservedPolicies }
          : null,
    }
  } catch (error: unknown) {
    return {
      decision: {
        status: 'rejected',
        reason: `Spend policy check failed (fail-closed): ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      reservation: null,
    }
  }
}

export async function enforceSpendPolicy(input: {
  merchant: string
  /** Amount in the asset's base units. BigInt is preferred for exactness. */
  amount: number | bigint
  /** Decimals of the asset `amount` is denominated in (0–18), or a thunk. */
  decimals: number | (() => number)
}): Promise<SpendPolicyDecision> {
  return (await reserveSpendPolicy(input)).decision
}

// ─── set_spend_policy ──────────────────────────────────────────────────────

export const SetSpendPolicySchema = z.object({
  scopeKey: z
    .string()
    .optional()
    .describe(
      'Optional session/scope key. Defaults to "global". Policies from ALL ' +
      'scopes are enforced together on every value-moving path (union); a ' +
      'scoped policy is never bypassed.'
    ),
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
    'The policy is enforced in-process for the lifetime of the MCP server; ' +
    'policies from all scopes are enforced together (union).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      scopeKey: {
        type: 'string',
        description:
          'Optional session/scope key (default: "global"). All scopes are ' +
          'enforced together on every value-moving path.',
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
