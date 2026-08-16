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
  /**
   * True when this span had already been counted against the ledger (an OTel
   * re-delivery or a client retry) and therefore added no new spend. The
   * decision itself still reflects current accumulated spend.
   */
  duplicateSpan?: boolean
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

// ─── Kill-callback constraints ─────────────────────────────────────────────

/** Timeout for the circuit-breaker kill callback POST. */
export const KILL_CALLBACK_TIMEOUT_MS = 10_000

const KILL_CALLBACK_ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * Validate a kill-callback URL against the rules for outbound webhooks:
 * must parse as an absolute URL, must use the http: or https: scheme, and
 * must not embed credentials (userinfo). Returns a human-readable error
 * message naming the violated rule, or null if the URL is acceptable.
 *
 * Applied fail-closed at configuration time (registerPolicy / the
 * otel_register_budget_policy schema) and again at fire time
 * (invokeKillCallback) as defense in depth.
 */
export function validateKillCallbackUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return `killCallbackUrl must be an absolute http(s) URL — "${raw}" is not a valid URL`
  }
  if (!KILL_CALLBACK_ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return `killCallbackUrl must use the http: or https: scheme — got "${parsed.protocol}"`
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'killCallbackUrl must not embed credentials (user:pass@host) — remove the userinfo component'
  }
  return null
}

// ─── In-memory stores ──────────────────────────────────────────────────────

/**
 * Hard ceiling on per-span records held in the spend ledger. Matched to
 * MAX_SEEN_SPANS so the dedupe horizon is never shallower than the ledger:
 * no span whose own record is still retained can be counted twice.
 */
export const MAX_LEDGER_ENTRIES = 10_000

/** Maximum number of span identities retained for duplicate detection. */
export const MAX_SEEN_SPANS = 10_000

/** Hard ceiling on retained budget decisions (audit/history only). */
export const MAX_DECISION_HISTORY = 1_000

/**
 * Floor on how long a spend record stays in the ledger before it may be
 * retired into the archived totals. Retention is never shorter than this and
 * never shorter than the widest rolling window any policy consults.
 */
export const MIN_LEDGER_RETENTION_MS = 24 * 60 * 60 * 1000

/** Maximum number of distinct spend scopes retained in the archive. */
export const MAX_ARCHIVE_SCOPES = 1_000

/**
 * Spend that has been retired from the per-span ledger, rolled up per
 * (agentId, taskId) scope. `throughTs` is the newest timestamp folded in,
 * which is what lets a rolling-window query tell "all of this is older than
 * my window" (exclude it — exact) from "some of it might not be" (include
 * it — over-counts, never under-counts).
 */
interface ArchivedSpend {
  agentId: string
  taskId?: string
  amountUsd: number
  throughTs: number
}

const _policies: Map<string, AgentBudgetPolicy> = new Map()
const _spendLedger: SpendRecord[] = []
const _decisions: BudgetDecision[] = []
const _archivedSpend: Map<string, ArchivedSpend> = new Map()

/** Widest rolling window any registered policy consults. */
let _maxPolicyWindowMs = 0

/**
 * Span identities already counted against the spend ledger, in insertion
 * order. Bounded FIFO: past MAX_SEEN_SPANS the oldest identity is evicted,
 * so dedupe covers the most recent MAX_SEEN_SPANS distinct spans.
 *
 * Tradeoff, deliberately taken: a re-delivery that arrives after its identity
 * has been evicted is counted a second time. That is the fail-safe direction
 * (spend is over-counted, so the breaker trips early rather than letting a
 * budget over-run), re-deliveries in practice arrive close behind the
 * original, and an unbounded seen-set would simply recreate the unbounded
 * growth this module is otherwise trying to avoid.
 */
const _seenSpans: Set<string> = new Set()

/** Build a policy key from agentId + optional taskId */
function policyKey(agentId: string, taskId?: string): string {
  return taskId ? `${agentId}::${taskId}` : agentId
}

/**
 * Identity of a span for dedupe purposes: the owning agent plus the OTel
 * (traceId, spanId) pair carried by the span attributes.
 *
 * Spans without a spanId have no usable identity and are never deduplicated
 * (they are counted every time, again the fail-safe direction). Callers that
 * supply a spanId but omit traceId are asserting that the spanId alone
 * identifies the span within that agent — reusing one across spans then reads
 * as a re-delivery.
 */
function spanDedupeKey(agentId: string, attrs: OTelSpanCostAttributes): string | null {
  if (!attrs.spanId) return null
  return `${agentId}::${attrs.traceId ?? ''}::${attrs.spanId}`
}

function markSpanSeen(key: string): void {
  _seenSpans.add(key)
  if (_seenSpans.size > MAX_SEEN_SPANS) {
    // Sets iterate in insertion order — evict the oldest identity.
    const oldest = _seenSpans.values().next().value
    if (oldest !== undefined) _seenSpans.delete(oldest)
  }
}

/** Unambiguous key for a spend scope — [agentId, taskId] cannot collide. */
function spendScopeKey(agentId: string, taskId?: string): string {
  return JSON.stringify([agentId, taskId ?? null])
}

/**
 * Fold a retired spend record into its scope's archived total.
 *
 * Retiring a record never discards its spend: lifetime budgets read the
 * archive back in full, so eviction cannot make a lifetime budget under-count.
 *
 * The archive itself is bounded by MAX_ARCHIVE_SCOPES on a least-recently-
 * archived basis. Documented tradeoff: a lifetime budget (windowMs = 0) is an
 * unbounded window, and nothing can retain unbounded history, so the explicit
 * bound is "exact for the MAX_ARCHIVE_SCOPES most recently active scopes". A
 * scope only loses history if it stays idle while that many other scopes retire
 * records, and only its already-retired history — its live ledger records, and
 * therefore every recent span, still count.
 */
function archiveRecord(record: SpendRecord): void {
  const key = spendScopeKey(record.agentId, record.taskId)
  const existing = _archivedSpend.get(key)

  if (existing) {
    existing.amountUsd += record.amountUsd
    existing.throughTs = Math.max(existing.throughTs, record.timestamp)
    // Re-insert to refresh recency — Maps iterate in insertion order.
    _archivedSpend.delete(key)
    _archivedSpend.set(key, existing)
    return
  }

  _archivedSpend.set(key, {
    agentId: record.agentId,
    taskId: record.taskId,
    amountUsd: record.amountUsd,
    throughTs: record.timestamp,
  })

  if (_archivedSpend.size > MAX_ARCHIVE_SCOPES) {
    const stalest = _archivedSpend.keys().next().value
    if (stalest !== undefined) _archivedSpend.delete(stalest)
  }
}

/**
 * Retire the oldest spend records so the ledger stays bounded.
 *
 * Records are appended with Date.now(), so the ledger is ordered oldest-first
 * and a prefix scan is enough. Two rules, in order:
 *
 *  1. Age. A record may be retired once it is older than the retention
 *     horizon — MIN_LEDGER_RETENTION_MS, widened to the widest rolling window
 *     any registered policy consults. A record that an active budget window
 *     still reaches is therefore never retired, so windowed budgets keep
 *     summing exactly the records they did before.
 *  2. Ceiling. MAX_LEDGER_ENTRIES caps the ledger regardless of age, so a
 *     burst cannot grow it without limit. This is the only path that can
 *     retire a record an active window still reaches; getAccumulatedSpend
 *     handles that by falling back to the archived total, which over-counts
 *     rather than under-counts.
 */
function pruneLedger(): void {
  const horizon = Math.max(MIN_LEDGER_RETENTION_MS, _maxPolicyWindowMs)
  const cutoff = Date.now() - horizon

  let retire = 0
  while (retire < _spendLedger.length && _spendLedger[retire].timestamp < cutoff) {
    retire++
  }
  if (_spendLedger.length - retire > MAX_LEDGER_ENTRIES) {
    retire = _spendLedger.length - MAX_LEDGER_ENTRIES
  }
  if (retire === 0) return

  for (let i = 0; i < retire; i++) {
    archiveRecord(_spendLedger[i])
  }
  _spendLedger.splice(0, retire)
}

/**
 * Drop the oldest decisions past MAX_DECISION_HISTORY. Decisions are an audit
 * trail only — no budget math reads them — so trimming them cannot affect
 * enforcement.
 */
function pruneDecisions(): void {
  if (_decisions.length > MAX_DECISION_HISTORY) {
    _decisions.splice(0, _decisions.length - MAX_DECISION_HISTORY)
  }
}

/** Reset all state — useful for testing */
export function _resetOTelBudgetState(): void {
  _policies.clear()
  _spendLedger.length = 0
  _decisions.length = 0
  _seenSpans.clear()
  _archivedSpend.clear()
  _maxPolicyWindowMs = 0
}

/** Current size of each bounded store — for tests and operational checks. */
export function _getOTelBudgetStoreSizes(): {
  ledger: number
  decisions: number
  seenSpans: number
  archivedScopes: number
} {
  return {
    ledger: _spendLedger.length,
    decisions: _decisions.length,
    seenSpans: _seenSpans.size,
    archivedScopes: _archivedSpend.size,
  }
}

// ─── Core Logic ────────────────────────────────────────────────────────────

/**
 * Register a budget policy for an agent or agent+task combination.
 *
 * Fails closed: a policy carrying an invalid killCallbackUrl (non-http(s)
 * scheme, embedded credentials, or unparseable) is rejected outright rather
 * than stored with a callback that would be refused at fire time.
 */
export function registerPolicy(policy: AgentBudgetPolicy): void {
  if (policy.killCallbackUrl !== undefined) {
    const urlError = validateKillCallbackUrl(policy.killCallbackUrl)
    if (urlError) {
      throw new Error(`Refusing to register budget policy: ${urlError}`)
    }
  }
  const key = policyKey(policy.agentId, policy.taskId)
  _policies.set(key, policy)
  // Ledger retention must cover every window the budget math consults.
  _maxPolicyWindowMs = Math.max(_maxPolicyWindowMs, policy.windowMs)
}

function getApplicablePolicy(agentId: string, taskId?: string): AgentBudgetPolicy | undefined {
  const taskPolicy = taskId ? _policies.get(policyKey(agentId, taskId)) : undefined
  const agentPolicy = _policies.get(policyKey(agentId))
  return taskPolicy ?? agentPolicy
}

/**
 * Get accumulated spend for an agent within the policy's rolling window.
 *
 * Reads both halves of the bounded ledger: the retained per-span records
 * (rescanned in full — the ledger is capped at MAX_LEDGER_ENTRIES) plus the
 * archived totals of records already retired by pruneLedger.
 *
 * The archive is folded in so eviction can never under-count:
 *  - lifetime (windowMs 0/undefined) counts every archived dollar — exact;
 *  - a rolling window skips the archive when its newest archived timestamp
 *    predates the window, which is the normal case because pruneLedger will
 *    not retire a record any active window still reaches — also exact;
 *  - only when the MAX_LEDGER_ENTRIES ceiling forced a still-in-window record
 *    out does the window count the whole archived total. That over-counts,
 *    which trips the breaker early instead of letting a budget over-run, and
 *    it self-clears once the window advances past the retired records.
 */
function getAccumulatedSpend(agentId: string, taskId?: string, windowMs?: number): number {
  const now = Date.now()
  const window = windowMs && windowMs > 0 ? windowMs : 0
  const cutoff = window > 0 ? now - window : 0

  let total = _spendLedger
    .filter(
      (r) =>
        r.agentId === agentId &&
        (taskId === undefined || r.taskId === taskId) &&
        r.timestamp >= cutoff
    )
    .reduce((sum, r) => sum + r.amountUsd, 0)

  for (const archived of _archivedSpend.values()) {
    if (archived.agentId !== agentId) continue
    if (taskId !== undefined && archived.taskId !== taskId) continue
    if (window === 0 || archived.throughTs >= cutoff) {
      total += archived.amountUsd
    }
  }

  return total
}

/**
 * Process an OTel span and evaluate budget. Returns a BudgetDecision.
 *
 * This is the main entry point: feed it span attributes from an
 * AgentCore-instrumented agent, and it returns an enforcement decision.
 *
 * Spend accounting is at-most-once per span identity: OTel pipelines and
 * MCP clients both re-deliver by design, so a span that has already been
 * counted is still evaluated against current accumulated spend — the caller
 * gets the enforcement decision it asked for — but adds nothing to the
 * ledger. Without this, one retried span at $4 against a $10 budget trips
 * the breaker at $8 of apparent spend for $4 of real cost.
 */
export function evaluateSpan(attrs: OTelSpanCostAttributes): BudgetDecision | null {
  const agentId = attrs['agentcore.agent.id']
  if (!agentId) return null

  const taskId = attrs['agentcore.task.id']
  const costUsd =
    attrs['agentcore.cost.usd'] ?? attrs['gen_ai.usage.cost'] ?? 0

  if (costUsd <= 0) return null

  // Record spend — once per span identity
  const dedupeKey = spanDedupeKey(agentId, attrs)
  const duplicateSpan = dedupeKey !== null && _seenSpans.has(dedupeKey)

  if (!duplicateSpan) {
    const record: SpendRecord = {
      agentId,
      taskId,
      amountUsd: costUsd,
      timestamp: Date.now(),
      spanId: attrs.spanId ?? 'unknown',
      traceId: attrs.traceId ?? 'unknown',
    }
    _spendLedger.push(record)
    if (dedupeKey !== null) markSpanSeen(dedupeKey)
    pruneLedger()
  }

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
      duplicateSpan,
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
    duplicateSpan,
  }

  _decisions.push(decision)
  pruneDecisions()
  return decision
}

/**
 * POST the kill decision to the policy's circuit-breaker webhook.
 *
 * Failure handling is loud but non-fatal: an invalid URL, timeout
 * (KILL_CALLBACK_TIMEOUT_MS), or network/HTTP failure is reported in the
 * returned object (surfaced verbatim in the otel_evaluate_spend result) and
 * never throws, so a broken webhook cannot crash budget evaluation.
 *
 * Retry policy: no in-process retry. Spend evaluation must not block on
 * webhook health, and every subsequent over-budget span evaluation fires the
 * callback again, which gives natural at-least-once redelivery while the
 * breach persists. Callers that need stronger guarantees should act on the
 * returned ok/error fields.
 */
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

  // Fire-time re-validation (defense in depth — registerPolicy already
  // rejects these). Refuse to POST rather than let an invalid URL through.
  const urlError = validateKillCallbackUrl(policy.killCallbackUrl)
  if (urlError) {
    return {
      attempted: false,
      ok: false,
      error: `Kill callback not invoked: ${urlError}`,
    }
  }

  try {
    const response = await fetch(policy.killCallbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(KILL_CALLBACK_TIMEOUT_MS),
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
    'agentpay.duplicate_span': decision.duplicateSpan === true,
  }
}

/**
 * Get recent decisions for an agent (for dashboard/audit). The underlying log
 * keeps only the most recent MAX_DECISION_HISTORY decisions across all agents.
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
    .superRefine((value, ctx) => {
      const urlError = validateKillCallbackUrl(value)
      if (urlError) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: urlError })
      }
    })
    .optional()
    .describe(
      'Webhook URL to invoke when circuit-breaker trips (kill action). ' +
        'Must be http(s) and must not embed credentials.'
    ),
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
      killCallbackUrl: {
        type: 'string',
        description: 'Circuit-breaker webhook URL (http(s) only, no embedded credentials)',
      },
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
    'into the AgentCore telemetry pipeline. Safe to retry: a span already ' +
    'counted (same agent, traceId and spanId) is re-evaluated but not ' +
    'charged twice, and the decision is flagged duplicateSpan.',
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
