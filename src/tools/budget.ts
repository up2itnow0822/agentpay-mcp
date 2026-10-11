/**
 * budget.ts — set_spend_policy, check_budget tools.
 *
 * set_spend_policy: configure a SpendingPolicy (in-process, persists for server lifetime).
 * check_budget: query on-chain remaining budget via checkBudget().
 *
 * Payment flow uses the SDK 6.3.0 reserve → execute → commit | release | lock
 * surface. `check()` is the backward-compatible reserve-then-commit wrapper
 * and is not used on the payment path.
 */
import { z } from 'zod'
import {
  SpendingPolicy,
  checkBudget,
  type SpendOutcome,
  type SpendReservation as SdkSpendReservation,
} from 'agentwallet-sdk'
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
/** 1 whole token = 1e9 policy units. SpendingPolicy 6.3.0 rejects > MAX_SAFE_INTEGER. */
export const POLICY_SCALE_DECIMALS = 9
const _policyConfigByScope = new Map<string, PolicyConfig>()
const _spendingPolicyByScope = new Map<string, InstanceType<typeof SpendingPolicy>>()

export function _resetPolicyStore(): void {
  _policyConfigByScope.clear()
  _spendingPolicyByScope.clear()
}

function scaleToPolicyUnits(baseUnits: bigint, decimals: number): bigint {
  if (decimals === POLICY_SCALE_DECIMALS) {
    return baseUnits
  }
  if (decimals < POLICY_SCALE_DECIMALS) {
    return baseUnits * 10n ** BigInt(POLICY_SCALE_DECIMALS - decimals)
  }
  const divisor = 10n ** BigInt(decimals - POLICY_SCALE_DECIMALS)
  const scaled = baseUnits / divisor
  return baseUnits % divisor === 0n ? scaled : scaled + 1n
}

function toSafePolicyNumber(scaled: bigint): number | null {
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null
  }
  const amountNumber = Number(scaled)
  if (!Number.isFinite(amountNumber) || BigInt(amountNumber) !== scaled) {
    return null
  }
  return amountNumber
}

export type SpendPolicyDecision =
  | { status: 'approved' }
  | { status: 'rejected' | 'draft'; reason?: string; draftId?: string }

export interface SpendReservationItem {
  policy: InstanceType<typeof SpendingPolicy>
  held: SdkSpendReservation
}

export interface SpendReservation {
  amount: number
  items: SpendReservationItem[]
}

function forEachHeld(
  reservation: SpendReservation | null | undefined,
  apply: (
    policy: InstanceType<typeof SpendingPolicy>,
    held: SdkSpendReservation
  ) => void
): void {
  if (!reservation) {
    return
  }
  for (const item of reservation.items) {
    apply(item.policy, item.held)
  }
}

/**
 * Return held capacity after a definite not-charged outcome.
 * Uses SpendingPolicy.release — locked (hold-unknown) reservations refuse.
 */
export function releaseSpendReservation(
  reservation: SpendReservation | null | undefined
): void {
  forEachHeld(reservation, (policy, held) => {
    policy.release(held)
  })
}

/**
 * Finalize held capacity after a settled outcome.
 */
export function commitSpendReservation(
  reservation: SpendReservation | null | undefined
): void {
  forEachHeld(reservation, (policy, held) => {
    policy.commit(held)
  })
}

/**
 * Keep held capacity after a hold-unknown outcome. A timer never unlocks.
 */
export function lockSpendReservation(
  reservation: SpendReservation | null | undefined
): void {
  forEachHeld(reservation, (policy, held) => {
    policy.lock(held)
  })
}

/**
 * Apply a classified SDK spend outcome to every held reservation.
 * settled → commit; released → release; hold-unknown → lock.
 */
export function applySpendOutcome(
  reservation: SpendReservation | null | undefined,
  outcome: SpendOutcome
): void {
  forEachHeld(reservation, (policy, held) => {
    policy.applyOutcome(held, outcome)
  })
}

/**
 * Reserve spend, run the attempt, then commit | release | lock.
 * Definite not-charged failures release so a retry can use the same cap.
 * Unclear post-broadcast errors lock the hold (never auto-unlock).
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
    const value = await run()
    commitSpendReservation(reservation)
    return value
  } catch (error: unknown) {
    if (error instanceof DefiniteSpendFailure) {
      releaseSpendReservation(reservation)
    } else {
      // After execute, only lock. classifySpendError treats unknown errors
      // as released (pre-broadcast); that is unsafe once a write may exist.
      lockSpendReservation(reservation)
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
 * set_spend_policy are stored in 9-decimal ETH-equivalent policy units
 * (parseEther of the human string / 1e9). SpendingPolicy 6.3.0 requires a
 * safe integer, so 18-decimal wei cannot be the engine unit: 10 USDC would
 * become 1e19. One whole token still counts as 1 ETH-equivalent: with
 * perTxCapEth "5", a 10 USDC payment (10_000_000 base units → 1e10) is over
 * the 5e9 cap and blocked. Never compare 6-decimal USDC base units against
 * wei-scale caps directly — that silently loosens every cap by 1e12.
 *
 * `decimals` may be a thunk so that asset-decimal resolution (which can throw
 * for unregistered assets) only runs when a policy is actually configured.
 *
 * Fail closed: ANY error while evaluating the policy — decimals resolution,
 * numeric conversion, or the policy engine itself — rejects the payment, and
 * unrecognised policy statuses are treated as rejections.
 *
 * Payment-path callers that still use `enforceSpendPolicy` get reserve-then
 * commit (the same net effect as the legacy `check()` wrapper). Prefer
 * `withReservedSpend` or explicit reserve/commit/release when the outcome
 * is known after execute.
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

    // Normalise to 9-decimal ETH-equivalent policy units (safe integers).
    // 18-decimal wei overflows Number.MAX_SAFE_INTEGER for ordinary USDC sizes.
    const scaled = scaleToPolicyUnits(baseUnits, decimals)
    const amountNumber = toSafePolicyNumber(scaled)
    if (amountNumber === null) {
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

    const reservedItems: SpendReservationItem[] = []

    for (const [scope, policy] of policies) {
      const result = await policy.reserve({
        merchant: input.merchant,
        amount: amountNumber,
      })

      if (result.status === 'reserved' && result.reservation) {
        reservedItems.push({ policy, held: result.reservation })
        continue
      }
      if (result.status === 'draft') {
        releaseSpendReservation({ amount: amountNumber, items: reservedItems })
        return {
          decision: { status: 'draft', reason: result.reason, draftId: result.draftId },
          reservation: null,
        }
      }
      // 'rejected', reserved-without-handle, and anything unrecognised deny.
      releaseSpendReservation({ amount: amountNumber, items: reservedItems })
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
        reservedItems.length > 0
          ? { amount: amountNumber, items: reservedItems }
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
  const { decision, reservation } = await reserveSpendPolicy(input)
  if (decision.status === 'approved') {
    commitSpendReservation(reservation)
  }
  return decision
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
    const ethToPolicyUnits = (eth: string): number => {
      const normalized = eth.trim()
      if (normalized.length === 0) throw new Error(`Invalid ETH amount: "${eth}"`)
      if (!/^\d*\.?\d+$/.test(normalized)) throw new Error(`Invalid ETH amount: "${eth}"`)

      const wei = parseEther(normalized)
      if (wei <= 0n) throw new Error(`Invalid ETH amount: "${eth}"`)
      const policyUnits = toSafePolicyNumber(scaleToPolicyUnits(wei, 18))
      if (policyUnits === null) {
        throw new Error(`ETH amount is too large: "${eth}"`)
      }
      return policyUnits
    }

    const scopeKey = input.scopeKey?.trim() || DEFAULT_POLICY_SCOPE
    const merchantAllowlist = input.allowedRecipients ?? []

    // Build SpendingPolicyConfig from inputs
    // rollingCap uses a 24-hour window for dailyLimitEth
    const rollingCap = input.dailyLimitEth
      ? {
          maxAmount: ethToPolicyUnits(input.dailyLimitEth),
          windowMs: 86_400_000, // 24 hours
        }
      : undefined

    // draftThreshold maps to perTxCap — payments above this go to draft
    const draftThreshold = input.perTxCapEth
      ? ethToPolicyUnits(input.perTxCapEth)
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
