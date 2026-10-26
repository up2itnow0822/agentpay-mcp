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
import { isAddress, parseEther, zeroAddress, type Address } from 'viem'
import { getWallet } from '../utils/client.js'
import { textContent, formatError } from '../utils/format.js'
import { DefiniteSpendFailure } from '../utils/spend-intent.js'

// ─── Module-level policy store ─────────────────────────────────────────────
//
// Two principals administer spend policy, with different powers:
//
//   - The OPERATOR configures an immutable policy through the environment
//     (AGENTPAY_POLICY_DAILY_LIMIT_ETH / _PER_TX_CAP_ETH / _ALLOWED_RECIPIENTS).
//     It is loaded once, cannot be changed or cleared through MCP, and is the
//     "trusted policy" every value-moving path requires (default deny).
//   - The MCP CALLER (the constrained agent) may only TIGHTEN. Each
//     set_spend_policy call adds a new layer to its scope; earlier layers —
//     with their rolling-window accounting and any held/locked reservations —
//     stay in force. A request that would loosen or drop a constraint the
//     scope already has is refused. Clearing a policy requires an operator
//     restart.
//
// AGENTPAY_ALLOW_UNPOLICED_SPEND=1 lets an operator run without an operator
// policy, relying solely on AgentAccountV2 on-chain limits. It is off by
// default so a fresh install never spends under no application policy.

interface PolicyConfig {
  dailyLimitEth?: string
  perTxCapEth?: string
  allowedRecipients?: string[]
}

interface PolicyLayer {
  config: PolicyConfig
  dailyLimitUnits?: number
  perTxCapUnits?: number
  allowedRecipients: string[]
  policy: InstanceType<typeof SpendingPolicy>
}

const DEFAULT_POLICY_SCOPE = 'global'
export const OPERATOR_POLICY_SCOPE = 'operator'
export const MAX_POLICY_SCOPES = 32
export const MAX_POLICY_LAYERS_PER_SCOPE = 16
export const OPERATOR_POLICY_ENV = {
  dailyLimitEth: 'AGENTPAY_POLICY_DAILY_LIMIT_ETH',
  perTxCapEth: 'AGENTPAY_POLICY_PER_TX_CAP_ETH',
  allowedRecipients: 'AGENTPAY_POLICY_ALLOWED_RECIPIENTS',
} as const
export const ALLOW_UNPOLICED_SPEND_ENV = 'AGENTPAY_ALLOW_UNPOLICED_SPEND'
/** 1 whole token = 1e9 policy units. SpendingPolicy 6.3.0 rejects > MAX_SAFE_INTEGER. */
export const POLICY_SCALE_DECIMALS = 9
const _layersByScope = new Map<string, PolicyLayer[]>()
let _operatorLoaded = false

export function _resetPolicyStore(): void {
  _layersByScope.clear()
  _operatorLoaded = false
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function normalizeRecipient(address: string): string {
  return address.trim().toLowerCase()
}

function ethToPolicyUnits(eth: string): number {
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

function buildLayer(config: PolicyConfig): PolicyLayer {
  const dailyLimitUnits = config.dailyLimitEth ? ethToPolicyUnits(config.dailyLimitEth) : undefined
  const perTxCapUnits = config.perTxCapEth ? ethToPolicyUnits(config.perTxCapEth) : undefined
  const allowedRecipients = (config.allowedRecipients ?? []).map(normalizeRecipient)
  for (const recipient of allowedRecipients) {
    if (!isAddress(recipient, { strict: false })) {
      throw new Error(`Invalid allowlisted recipient address: "${recipient}"`)
    }
  }
  return {
    config: { ...config, allowedRecipients },
    dailyLimitUnits,
    perTxCapUnits,
    allowedRecipients,
    policy: new SpendingPolicy({
      merchantAllowlist: allowedRecipients,
      // rollingCap uses a 24-hour window for dailyLimitEth
      rollingCap:
        dailyLimitUnits !== undefined
          ? { maxAmount: dailyLimitUnits, windowMs: 86_400_000 }
          : undefined,
      // draftThreshold maps to perTxCap — payments above this go to draft
      draftThreshold: perTxCapUnits,
    }),
  }
}

/** Load the operator policy from the environment exactly once. */
function ensureOperatorPolicy(): void {
  if (_operatorLoaded) return
  _operatorLoaded = true
  const dailyLimitEth = process.env[OPERATOR_POLICY_ENV.dailyLimitEth]?.trim() || undefined
  const perTxCapEth = process.env[OPERATOR_POLICY_ENV.perTxCapEth]?.trim() || undefined
  const recipientsRaw = process.env[OPERATOR_POLICY_ENV.allowedRecipients]?.trim()
  const allowedRecipients = recipientsRaw
    ? recipientsRaw.split(',').map((entry) => entry.trim()).filter(Boolean)
    : undefined
  if (!dailyLimitEth && !perTxCapEth && !allowedRecipients) return
  // A malformed operator value must not silently mean "no policy".
  _layersByScope.set(OPERATOR_POLICY_SCOPE, [
    buildLayer({ dailyLimitEth, perTxCapEth, allowedRecipients }),
  ])
}

/** Every SpendingPolicy layer currently in force, across all scopes. */
function allLayers(): Array<[string, PolicyLayer]> {
  ensureOperatorPolicy()
  const out: Array<[string, PolicyLayer]> = []
  for (const [scope, layers] of _layersByScope) {
    for (const layer of layers) out.push([scope, layer])
  }
  return out
}

/**
 * Refuse a caller policy update that would loosen anything the scope already
 * enforces. Constraints are compared against the TIGHTEST existing layer.
 */
function assertTightens(existing: PolicyLayer[], next: PolicyLayer): void {
  const tightest = (pick: (_layer: PolicyLayer) => number | undefined): number | undefined => {
    let min: number | undefined
    for (const layer of existing) {
      const value = pick(layer)
      if (value !== undefined && (min === undefined || value < min)) min = value
    }
    return min
  }
  const daily = tightest((layer) => layer.dailyLimitUnits)
  if (daily !== undefined && (next.dailyLimitUnits === undefined || next.dailyLimitUnits > daily)) {
    throw new Error(
      'set_spend_policy can only tighten an existing policy: dailyLimitEth must be present ' +
        'and no larger than the limit already in force. Loosening requires an operator restart.'
    )
  }
  const perTx = tightest((layer) => layer.perTxCapUnits)
  if (perTx !== undefined && (next.perTxCapUnits === undefined || next.perTxCapUnits > perTx)) {
    throw new Error(
      'set_spend_policy can only tighten an existing policy: perTxCapEth must be present ' +
        'and no larger than the cap already in force. Loosening requires an operator restart.'
    )
  }
  for (const layer of existing) {
    if (layer.allowedRecipients.length === 0) continue
    const allowed = new Set(layer.allowedRecipients)
    if (
      next.allowedRecipients.length === 0 ||
      next.allowedRecipients.some((recipient) => !allowed.has(recipient))
    ) {
      throw new Error(
        'set_spend_policy can only tighten an existing policy: allowedRecipients must be a ' +
          'non-empty subset of the allowlist already in force. Loosening requires an operator restart.'
      )
    }
  }
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
  const policies = allLayers()
  if (!_layersByScope.has(OPERATOR_POLICY_SCOPE) && !envFlag(ALLOW_UNPOLICED_SPEND_ENV)) {
    // Default deny: without a trusted (operator) policy there is no
    // authority for value movement beyond what the agent set for itself.
    return {
      decision: {
        status: 'rejected',
        reason:
          'No operator spend policy is configured (fail-closed). Set ' +
          `${OPERATOR_POLICY_ENV.dailyLimitEth} / ${OPERATOR_POLICY_ENV.perTxCapEth} / ` +
          `${OPERATOR_POLICY_ENV.allowedRecipients} in the server environment, or set ` +
          `${ALLOW_UNPOLICED_SPEND_ENV}=1 to rely solely on on-chain AgentAccountV2 limits.`,
      },
      reservation: null,
    }
  }
  if (policies.length === 0) {
    return { decision: { status: 'approved' }, reservation: null }
  }

  const reservedItems: SpendReservationItem[] = []
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

    for (const [scope, { policy }] of policies) {
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
    releaseSpendReservation({ amount: 0, items: reservedItems })
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
    'Tighten the Agent Wallet spend policy for a scope. ' +
    'Adds a daily limit, per-transaction cap, and/or recipient allowlist. ' +
    'Policies only tighten: a request that would raise a limit, drop a constraint, or widen ' +
    'an allowlist is refused, and earlier layers keep their accounting. ' +
    'Policies from all scopes plus the operator policy are enforced together (union).',
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
    ensureOperatorPolicy()
    const scopeKey = input.scopeKey?.trim() || DEFAULT_POLICY_SCOPE
    if (scopeKey === OPERATOR_POLICY_SCOPE) {
      throw new Error(
        `Scope "${OPERATOR_POLICY_SCOPE}" is reserved for the operator policy and is configured ` +
          'only through the server environment.'
      )
    }
    if (scopeKey.length > 64 || /[\u0000-\u001f\u007f]/.test(scopeKey)) {
      throw new Error('scopeKey must be at most 64 printable characters.')
    }

    const layer = buildLayer({
      dailyLimitEth: input.dailyLimitEth,
      perTxCapEth: input.perTxCapEth,
      allowedRecipients: input.allowedRecipients,
    })

    const existing = _layersByScope.get(scopeKey)
    if (existing) {
      assertTightens(existing, layer)
      if (existing.length >= MAX_POLICY_LAYERS_PER_SCOPE) {
        throw new Error(
          `Scope "${scopeKey}" already has ${MAX_POLICY_LAYERS_PER_SCOPE} policy layers; ` +
            'further tightening requires an operator restart.'
        )
      }
      existing.push(layer)
    } else {
      const callerScopes = Array.from(_layersByScope.keys()).filter(
        (key) => key !== OPERATOR_POLICY_SCOPE
      )
      if (callerScopes.length >= MAX_POLICY_SCOPES) {
        throw new Error(`At most ${MAX_POLICY_SCOPES} policy scopes may be configured.`)
      }
      _layersByScope.set(scopeKey, [layer])
    }

    return {
      content: [
        textContent(
          JSON.stringify({
            success: true,
            scopeKey,
            layers: _layersByScope.get(scopeKey)!.length,
            policy: {
              dailyLimitEth: input.dailyLimitEth ?? null,
              perTxCapEth: input.perTxCapEth ?? null,
              allowedRecipients: layer.allowedRecipients,
            },
            note:
              'Policies only tighten: earlier layers and their accounting stay in force, and the ' +
              'operator policy (if configured) always applies.',
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

/** Effective (tightest) view of a scope for display. */
function describeScope(scopeKey: string): PolicyConfig | null {
  const layers = _layersByScope.get(scopeKey)
  if (!layers || layers.length === 0) return null
  const latest = layers[layers.length - 1]!
  return { ...latest.config, allowedRecipients: latest.allowedRecipients }
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
            policy: describeScope(scopeKey),
            operatorPolicy: describeScope(OPERATOR_POLICY_SCOPE),
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
