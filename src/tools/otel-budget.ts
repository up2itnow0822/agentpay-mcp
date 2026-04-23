/**
 * otel-budget.ts — OpenTelemetry Budget Circuit-Breaker for AWS AgentCore
 *
 * Reads OTel span data from AgentCore-instrumented agents, applies per-agent
 * and per-task budget policies against accumulated spend, emits budget
 * enforcement decisions as OTel events, and supports circuit-breaker patterns
 * (auto-kill agent runs exceeding budget thresholds).
 *
 * Why this exists: AWS AgentCore Policy Controls (GA March 2026) provide
 * observability and guardrails but NO native per-agent/per-session spend cap
 * APIs. This module fills that gap by sitting between the OTel telemetry
 * pipeline and agentpay-mcp's existing budget enforcement.
 *
 * @module otel-budget
 * @since 4.2.0
 */

import { z } from 'zod'
import { textContent, formatError } from '../utils/format.js'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AgentBudgetPolicy {
  /** Unique agent or session identifier */
  agentId: string
  /** Optional task-level identifier for fine-grained budgets */
  taskId?: string
  /** Maximum spend in USD for this agent/task */
  maxSpendUsd: number
  /** Rolling window in milliseconds (0 = lifetime budget) */
  windowMs: number
  /** Action when budget exceeded: 'warn' | 'block' | 'kill' */
  breachAction: 'warn' | 'block' | 'kill'
  /** Optional callback URL for circuit-breaker kill signal */
  killCallbackUrl?: string
}

export interface SpendRecord {
  agentId: string
  taskId?: string
  amountUsd: number
  timestamp: number
  spanId: string
  traceId: string
}

export interface BudgetDecision {
  agentId: string
  taskId?: string
  action: 'allow' | 'warn' | 'block' | 'kill'
  accumulatedSpendUsd: number
  budgetLimitUsd: number
  remainingUsd: number
  utilizationPct: number
  reason: string
  timestamp: number
}

export interface OTelSpanCostAttributes {
  /** OTel span attribute: agentcore.agent.id */
  'agentcore.agent.id'?: string
  /** OTel span attribute: agentcore.task.id */
  'agentcore.task.id'?: string
  /** OTel span attribute: agentcore.cost.usd — cost incurred in this span */
  'agentcore.cost.usd'?: number
  /** OTel span attribute: gen_ai.usage.input_tokens */
  'gen_ai.usage.input_tokens'?: number
  /** OTel span attribute: gen_ai.usage.output_tokens */
  'gen_ai.usage.output_tokens'?: number
  /** OTel span attribute: gen_ai.usage.cost */
  'gen_ai.usage.cost'?: number
  /** Standard OTel trace/span IDs */
  traceId?: string
  spanId?: string
}

// ─── In-memory stores ──────────────────────────────────────────────────────

const _policies: Map<string, AgentBudgetPolicy> = new Map()
const _spendLedger: SpendRecord[] = []
const _decisions: BudgetDecision[] = []

/** Build a policy key from agentId + optional taskId */
function policyKey(agentId: string, taskId?: string): string {
  return taskId ? `${agentId}::${taskId}` : agentId
}

/** Reset all state — useful for testing */
export function _resetOTelBudgetState(): void {
  _policies.clear()
  _spendLedger.length = 0
  _decisions.length = 0
}

// ─── Core Logic ────────────────────────────────────────────────────────────

/**
 * Register a budget policy for an agent or agent+task combination.
 */
export function registerPolicy(policy: AgentBudgetPolicy): void {
  const key = policyKey(policy.agentId, policy.taskId)
  _policies.set(key, policy)
}

function getApplicablePolicy(agentId: string, taskId?: string): AgentBudgetPolicy | undefined {
  const taskPolicy = taskId ? _policies.get(policyKey(agentId, taskId)) : undefined
  const agentPolicy = _policies.get(policyKey(agentId))
  return taskPolicy ?? agentPolicy
}

/**
 * Get accumulated spend for an agent within the policy's rolling window.
 */
function getAccumulatedSpend(agentId: string, taskId?: string, windowMs?: number): number {
  const now = Date.now()
  const cutoff = windowMs && windowMs > 0 ? now - windowMs : 0

  return _spendLedger
    .filter(
      (r) =>
        r.agentId === agentId &&
        (taskId === undefined || r.taskId === taskId) &&
        r.timestamp >= cutoff
    )
    .reduce((sum, r) => sum + r.amountUsd, 0)
}

/**
 * Process an OTel span and evaluate budget. Returns a BudgetDecision.
 *
 * This is the main entry point: feed it span attributes from an
 * AgentCore-instrumented agent, and it returns an enforcement decision.
 */
export function evaluateSpan(attrs: OTelSpanCostAttributes): BudgetDecision | null {
  const agentId = attrs['agentcore.agent.id']
  if (!agentId) return null

  const taskId = attrs['agentcore.task.id']
  const costUsd =
    attrs['agentcore.cost.usd'] ?? attrs['gen_ai.usage.cost'] ?? 0

  if (costUsd <= 0) return null

  // Record spend
  const record: SpendRecord = {
    agentId,
    taskId,
    amountUsd: costUsd,
    timestamp: Date.now(),
    spanId: attrs.spanId ?? 'unknown',
    traceId: attrs.traceId ?? 'unknown',
  }
  _spendLedger.push(record)

  // Find applicable policy (task-specific first, then agent-level)
  const policy = getApplicablePolicy(agentId, taskId)

  if (!policy) {
    // No policy = allow (but we still recorded the spend)
    return {
      agentId,
      taskId,
      action: 'allow',
      accumulatedSpendUsd: getAccumulatedSpend(agentId, taskId),
      budgetLimitUsd: Infinity,
      remainingUsd: Infinity,
      utilizationPct: 0,
      reason: 'No budget policy registered for this agent',
      timestamp: Date.now(),
    }
  }

  const spendScopeTaskId = policy.taskId === undefined ? undefined : taskId
  const accumulated = getAccumulatedSpend(agentId, spendScopeTaskId, policy.windowMs)
  const remaining = Math.max(0, policy.maxSpendUsd - accumulated)
  const utilization = (accumulated / policy.maxSpendUsd) * 100

  let action: BudgetDecision['action'] = 'allow'
  let reason = 'Within budget'

  if (accumulated > policy.maxSpendUsd) {
    action = policy.breachAction
    reason = `Budget exceeded: $${accumulated.toFixed(4)} / $${policy.maxSpendUsd.toFixed(4)} (${utilization.toFixed(1)}%)`
  } else if (utilization >= 90) {
    action = 'warn'
    reason = `Approaching budget limit: $${accumulated.toFixed(4)} / $${policy.maxSpendUsd.toFixed(4)} (${utilization.toFixed(1)}%)`
  }

  const decision: BudgetDecision = {
    agentId,
    taskId,
    action,
    accumulatedSpendUsd: accumulated,
    budgetLimitUsd: policy.maxSpendUsd,
    remainingUsd: remaining,
    utilizationPct: utilization,
    reason,
    timestamp: Date.now(),
  }

  _decisions.push(decision)
  return decision
}

export async function invokeKillCallback(
  policy: AgentBudgetPolicy,
  decision: BudgetDecision
): Promise<
  | {
      attempted: boolean
      ok: boolean
      status?: number
      error?: string
    }
  | null
> {
  if (decision.action !== 'kill' || !policy.killCallbackUrl) {
    return null
  }

  try {
    const response = await fetch(policy.killCallbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        event: 'agentpay.budget.kill',
        decision,
        policy: {
          agentId: policy.agentId,
          taskId: policy.taskId,
          maxSpendUsd: policy.maxSpendUsd,
          windowMs: policy.windowMs,
          breachAction: policy.breachAction,
        },
      }),
    })

    return {
      attempted: true,
      ok: response.ok,
      status: response.status,
      ...(response.ok ? {} : { error: `Kill callback returned HTTP ${response.status}` }),
    }
  } catch (error: unknown) {
    return {
      attempted: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Convert a BudgetDecision to OTel-compatible event attributes.
 * These can be emitted as span events for AgentCore dashboard visibility.
 */
export function decisionToOTelEvent(decision: BudgetDecision): Record<string, string | number | boolean> {
  return {
    'event.name': 'agentpay.budget.decision',
    'agentpay.agent_id': decision.agentId,
    'agentpay.task_id': decision.taskId ?? '',
    'agentpay.action': decision.action,
    'agentpay.accumulated_spend_usd': decision.accumulatedSpendUsd,
    'agentpay.budget_limit_usd': decision.budgetLimitUsd,
    'agentpay.remaining_usd': decision.remainingUsd,
    'agentpay.utilization_pct': decision.utilizationPct,
    'agentpay.reason': decision.reason,
    'agentpay.circuit_breaker_tripped': decision.action === 'kill',
  }
}

/**
 * Get recent decisions for an agent (for dashboard/audit).
 */
export function getDecisionHistory(
  agentId: string,
  limit: number = 50
): BudgetDecision[] {
  return _decisions
    .filter((d) => d.agentId === agentId)
    .slice(-limit)
}

/**
 * Get all registered policies (for introspection).
 */
export function listPolicies(): AgentBudgetPolicy[] {
  return Array.from(_policies.values())
}

// ─── MCP Tool Definitions ──────────────────────────────────────────────────

export const OTelRegisterPolicySchema = z.object({
  agentId: z.string().describe('Agent or session identifier from AgentCore'),
  taskId: z.string().optional().describe('Optional task-level identifier'),
  maxSpendUsd: z.number().positive().describe('Maximum spend in USD'),
  windowMs: z
    .number()
    .min(0)
    .default(0)
    .describe('Rolling window in ms (0 = lifetime budget)'),
  breachAction: z
    .enum(['warn', 'block', 'kill'])
    .default('block')
    .describe('Action on budget breach: warn, block, or kill (circuit-breaker)'),
  killCallbackUrl: z
    .string()
    .optional()
    .describe('Webhook URL to invoke when circuit-breaker trips (kill action)'),
})

export type OTelRegisterPolicyInput = z.infer<typeof OTelRegisterPolicySchema>

export const otelRegisterPolicyTool = {
  name: 'otel_register_budget_policy',
  description:
    'Register a budget policy for an AWS AgentCore agent or task. ' +
    'When OTel spans report costs exceeding this budget, agentpay-mcp will ' +
    'enforce the configured action (warn/block/kill circuit-breaker). ' +
    'This fills the gap left by AgentCore Policy Controls which provide ' +
    'observability but no native per-agent spend caps.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      agentId: { type: 'string', description: 'Agent/session ID from AgentCore' },
      taskId: { type: 'string', description: 'Optional task-level ID' },
      maxSpendUsd: { type: 'number', description: 'Max spend in USD' },
      windowMs: { type: 'number', description: 'Rolling window in ms (0 = lifetime)' },
      breachAction: {
        type: 'string',
        enum: ['warn', 'block', 'kill'],
        description: 'Action on breach',
      },
      killCallbackUrl: { type: 'string', description: 'Circuit-breaker webhook URL' },
    },
    required: ['agentId', 'maxSpendUsd'],
  },
}

export async function handleOTelRegisterPolicy(
  input: OTelRegisterPolicyInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const policy: AgentBudgetPolicy = {
      agentId: input.agentId,
      taskId: input.taskId,
      maxSpendUsd: input.maxSpendUsd,
      windowMs: input.windowMs ?? 0,
      breachAction: input.breachAction ?? 'block',
      killCallbackUrl: input.killCallbackUrl,
    }

    registerPolicy(policy)

    return {
      content: [
        textContent(
          JSON.stringify({
            success: true,
            policy: {
              key: policyKey(policy.agentId, policy.taskId),
              ...policy,
            },
          })
        ),
      ],
    }
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'otel_register_budget_policy'))],
      isError: true,
    }
  }
}

// ─── otel_evaluate_spend ───────────────────────────────────────────────────

export const OTelEvaluateSpendSchema = z.object({
  agentId: z.string().describe('Agent ID from OTel span attribute agentcore.agent.id'),
  taskId: z.string().optional().describe('Task ID from OTel span attribute agentcore.task.id'),
  costUsd: z.number().describe('Cost in USD from this span'),
  spanId: z.string().optional().describe('OTel span ID'),
  traceId: z.string().optional().describe('OTel trace ID'),
})

export type OTelEvaluateSpendInput = z.infer<typeof OTelEvaluateSpendSchema>

export const otelEvaluateSpendTool = {
  name: 'otel_evaluate_spend',
  description:
    'Evaluate a spend event from an OTel span against registered budget policies. ' +
    'Returns a budget decision (allow/warn/block/kill) with utilization details. ' +
    'The decision is also formatted as OTel event attributes for re-emission ' +
    'into the AgentCore telemetry pipeline.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      agentId: { type: 'string', description: 'Agent ID from OTel span' },
      taskId: { type: 'string', description: 'Task ID from OTel span' },
      costUsd: { type: 'number', description: 'Span cost in USD' },
      spanId: { type: 'string', description: 'OTel span ID' },
      traceId: { type: 'string', description: 'OTel trace ID' },
    },
    required: ['agentId', 'costUsd'],
  },
}

export async function handleOTelEvaluateSpend(
  input: OTelEvaluateSpendInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const policy = getApplicablePolicy(input.agentId, input.taskId)
    const decision = evaluateSpan({
      'agentcore.agent.id': input.agentId,
      'agentcore.task.id': input.taskId,
      'agentcore.cost.usd': input.costUsd,
      spanId: input.spanId,
      traceId: input.traceId,
    })

    if (!decision) {
      return {
        content: [
          textContent(
            JSON.stringify({ action: 'skip', reason: 'No cost or agent ID in span' })
          ),
        ],
      }
    }

    const otelEvent = decisionToOTelEvent(decision)
    const killCallback = policy
      ? await invokeKillCallback(policy, decision)
      : null

    return {
      content: [
        textContent(
          JSON.stringify({
            decision,
            otelEvent,
            killCallback,
          })
        ),
      ],
    }
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'otel_evaluate_spend'))],
      isError: true,
    }
  }
}

// ─── otel_budget_status ────────────────────────────────────────────────────

export const OTelBudgetStatusSchema = z.object({
  agentId: z.string().describe('Agent ID to check budget status for'),
  includeHistory: z
    .boolean()
    .default(false)
    .describe('Include recent decision history'),
  historyLimit: z.number().default(20).describe('Max history entries to return'),
})

export type OTelBudgetStatusInput = z.infer<typeof OTelBudgetStatusSchema>

export const otelBudgetStatusTool = {
  name: 'otel_budget_status',
  description:
    'Get the current budget status for an AgentCore agent, including ' +
    'accumulated spend, remaining budget, utilization percentage, and ' +
    'optional decision history. Useful for dashboards and audit trails.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      agentId: { type: 'string', description: 'Agent ID' },
      includeHistory: { type: 'boolean', description: 'Include decision history' },
      historyLimit: { type: 'number', description: 'Max history entries' },
    },
    required: ['agentId'],
  },
}

export async function handleOTelBudgetStatus(
  input: OTelBudgetStatusInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const agentPolicies = Array.from(_policies.values()).filter(
      (p) => p.agentId === input.agentId
    )

    const statuses = agentPolicies.map((policy) => {
      const accumulated = getAccumulatedSpend(
        policy.agentId,
        policy.taskId,
        policy.windowMs
      )
      return {
        policyKey: policyKey(policy.agentId, policy.taskId),
        policy,
        accumulatedSpendUsd: accumulated,
        remainingUsd: Math.max(0, policy.maxSpendUsd - accumulated),
        utilizationPct: (accumulated / policy.maxSpendUsd) * 100,
      }
    })

    const result: Record<string, unknown> = {
      agentId: input.agentId,
      policies: statuses,
      totalAccumulatedUsd: getAccumulatedSpend(input.agentId),
    }

    if (input.includeHistory) {
      result.recentDecisions = getDecisionHistory(
        input.agentId,
        input.historyLimit ?? 20
      )
    }

    return { content: [textContent(JSON.stringify(result))] }
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'otel_budget_status'))],
      isError: true,
    }
  }
}
