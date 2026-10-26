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
import {
  hasEmptyLabel,
  isPrivateIpv4,
  isPrivateIpv6,
  normalizeHost,
  parseIpv4,
  PRIVATE_HOST_SUFFIXES as KILL_CALLBACK_BLOCKED_HOST_SUFFIXES,
  PRIVATE_HOSTS as KILL_CALLBACK_BLOCKED_HOSTS,
  withDeadline,
} from '../utils/net-guard.js'
import {
  activeConnector,
  createSafeTransport,
  UnsafeDestinationError,
} from '../utils/safe-fetch.js'

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

// ─── Kill-callback constraints ─────────────────────────────────────────────

/** Timeout for the circuit-breaker kill callback POST. */
export const KILL_CALLBACK_TIMEOUT_MS = 10_000

const KILL_CALLBACK_ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])


/**
 * Comma-separated operator allowlist of hosts whose private-space destination is
 * explicitly permitted, for deployments whose circuit-breaker webhook genuinely
 * lives in-VPC (`orchestrator.svc.internal`, a 10/8 address, …). Empty by
 * default, so the private-space rule is fail-closed unless an operator opts a
 * specific host in. It waives only the private/loopback/link-local rule — the
 * http(s)-scheme and no-embedded-credentials rules always apply.
 */
export const KILL_CALLBACK_ALLOWLIST_ENV = 'AGENTPAY_KILL_CALLBACK_ALLOWED_HOSTS'
/** Read the operator allowlist. Read per call so config changes need no restart. */
function killCallbackAllowlist(): Set<string> {
  const raw = process.env[KILL_CALLBACK_ALLOWLIST_ENV]
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((entry) => normalizeHost(entry.trim()))
      .filter((entry) => entry !== '')
  )
}

/**
 * Generic refusal handed back to the MCP caller when a kill callback is not
 * delivered. Every refusal and every transport failure shares this one string
 * on purpose: the destination is caller-supplied, so a reason that varied with
 * what the server found (name resolves / does not resolve, resolves into
 * private space, port closed, port open but silent, HTTP error) would let an
 * untrusted caller enumerate internal DNS and internal services through this
 * tool. The specific reason goes to the server log instead.
 */
export const KILL_CALLBACK_GENERIC_FAILURE = 'Kill callback was not delivered'

/**
 * Reduce a callback URL to scheme + host + port for logging.
 *
 * The path and query of a webhook are routinely the credential — a signed
 * delivery path, a `?token=` capability, a tenant id — so the full URL must not
 * reach the log. The origin is what an operator actually needs to identify
 * which webhook failed, and it carries no secret. Userinfo is dropped too, even
 * though validateKillCallbackUrl already refuses it, so that any future caller
 * of this helper cannot reintroduce the leak.
 */
function redactCallbackUrl(raw: string): string {
  try {
    const parsed = new URL(raw)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '<unparseable callback URL>'
  }
}

/**
 * Record why a kill callback failed where the operator can see it and the
 * caller cannot. stderr is safe for an MCP stdio server: stdout carries the
 * protocol, stderr is the server's log stream.
 *
 * Only the redacted origin is logged: see {@link redactCallbackUrl}. Server
 * logs are shipped, indexed and read by more people than the webhook's owner,
 * so a signed path or a query-string token written there is disclosed.
 */
function logKillCallbackFailure(url: string, detail: string): void {
  console.error(
    `[otel-budget] kill callback not delivered for ${redactCallbackUrl(url)}: ${detail}`
  )
}


/**
 * Validate a kill-callback URL against the rules for outbound webhooks:
 * must parse as an absolute URL, must use the http: or https: scheme, must
 * not embed credentials (userinfo), and must not name a host inside the
 * private/loopback/link-local ranges the server itself can reach — the URL
 * comes from an untrusted MCP caller, so an unconstrained destination is an
 * SSRF against internal services. Returns a human-readable error message naming
 * the violated rule, or null if the URL is acceptable.
 *
 * This check is literal-only: it sees IP literals in every encoding the WHATWG
 * URL parser normalizes (decimal/octal/hex/short IPv4, IPv4-mapped, NAT64, 6to4,
 * Teredo and IPv4-compatible IPv6), but it cannot see where a DNS name points.
 * Names are resolved and re-checked at fire time by
 * {@link resolvedHostIsPrivate}; see its notes for the residual rebinding gap.
 *
 * The private-space rule (only that rule) is waived for hosts an operator has
 * opted in via {@link KILL_CALLBACK_ALLOWLIST_ENV}.
 *
 * Applied at configuration time (registerPolicy drops a callback URL that fails
 * this check, keeping the rest of the policy) and again at fire time
 * (invokeKillCallback) as defense in depth. It gates the callback only: it
 * never gates whether the spend cap itself is registered and enforced.
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

  const ipv6Literal = parsed.hostname.startsWith('[')
  // No empty-host case: the WHATWG parser rejects an http(s) URL without a host
  // outright, so `new URL` above has already thrown for those.
  // Unresolvable empty-label names are refused ahead of everything else, so a
  // dot-padded spelling of an allowlisted host cannot claim its waiver.
  if (!ipv6Literal && hasEmptyLabel(parsed.hostname)) {
    return `killCallbackUrl must not target a private, loopback or link-local host — "${parsed.hostname}" is not externally routable`
  }
  const host = normalizeHost(parsed.hostname)
  // Operator opt-in: this host's private destination is intentional.
  if (killCallbackAllowlist().has(host)) return null
  const ipv4 = parseIpv4(host)
  const privateHost =
    KILL_CALLBACK_BLOCKED_HOSTS.has(host) ||
    KILL_CALLBACK_BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    (ipv4 !== null ? isPrivateIpv4(ipv4) : ipv6Literal && isPrivateIpv6(host))
  if (privateHost) {
    return `killCallbackUrl must not target a private, loopback or link-local host — "${parsed.hostname}" is not externally routable`
  }
  // Public webhooks must be https: the URL routinely carries a signed
  // capability and the POST carries the budget decision, so plaintext lets a
  // network attacker read or suppress the kill signal. Plain http stays
  // available only for operator-allowlisted hosts (returned above) and in
  // private-network development mode.
  if (parsed.protocol !== 'https:' && !privateNetworkDevMode()) {
    return 'killCallbackUrl must use https: for a public host (http is allowed only for hosts in ' +
      `${KILL_CALLBACK_ALLOWLIST_ENV})`
  }
  return null
}

/** AGENTPAY_ALLOW_PRIVATE_NETWORK=1: development mode that also permits http. */
function privateNetworkDevMode(): boolean {
  const value = process.env.AGENTPAY_ALLOW_PRIVATE_NETWORK?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}


/**
 * Resolve a callback host and report whether any address it maps to sits in
 * private space. This is what closes the DNS half of the SSRF: without it a
 * caller-supplied name pointing at 169.254.169.254 passes the literal checks
 * above and gets fetched verbatim.
 *
 * Fails closed — a name that cannot be resolved is refused rather than fetched.
 * Skipped for hosts an operator has opted in via
 * {@link KILL_CALLBACK_ALLOWLIST_ENV}.
 *
 * `deadline` is the one budget for the whole callback path, shared with the
 * POST that follows. Without it the awaited lookup was unbounded: a resolver
 * that accepts the query and never answers held the caller — and, through
 * otel_evaluate_spend, the caller's span evaluation — open indefinitely, well
 * past KILL_CALLBACK_TIMEOUT_MS, because the abort signal used to be created
 * only for the fetch afterwards. node:dns/promises takes no signal of its own,
 * so the lookup is raced against the deadline instead.
 *
 * The reason string returned here is detailed on purpose — it is for the server
 * log. It must not be handed to the MCP caller verbatim: "resolves into private
 * space" vs "does not resolve" vs "resolves to nothing" would let an untrusted
 * caller enumerate the server's internal DNS view. invokeKillCallback replaces
 * it with {@link KILL_CALLBACK_GENERIC_FAILURE} before returning.
 *
 * invokeKillCallback no longer calls this: it goes through the safe
 * transport (utils/safe-fetch.ts), which performs the same refusal AND pins
 * the connection to the validated answer set, closing the rebinding gap this
 * function alone could not. Kept as a stand-alone pre-flight check.
 */
export async function resolvedHostIsPrivate(
  rawUrl: string,
  deadline?: AbortSignal
): Promise<string | null> {
  let hostname: string
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return 'killCallbackUrl is not a valid URL'
  }
  // Bracketed literals were already checked exactly by validateKillCallbackUrl.
  if (hostname.startsWith('[')) return null
  hostname = normalizeHost(hostname)
  if (killCallbackAllowlist().has(hostname)) return null
  if (parseIpv4(hostname) !== null) return null

  let addresses: Array<{ address: string; family: number }>
  try {
    const { lookup } = await import('node:dns/promises')
    addresses = await withDeadline(lookup(hostname, { all: true, verbatim: true }), deadline)
  } catch {
    return deadline?.aborted
      ? `killCallbackUrl host "${hostname}" was not resolved within the ` +
          `${KILL_CALLBACK_TIMEOUT_MS}ms kill-callback deadline`
      : `killCallbackUrl host "${hostname}" could not be resolved`
  }
  if (addresses.length === 0) {
    return `killCallbackUrl host "${hostname}" resolved to no addresses`
  }

  for (const { address } of addresses) {
    const ipv4 = parseIpv4(address)
    const isPrivate = ipv4 !== null ? isPrivateIpv4(ipv4) : isPrivateIpv6(address.toLowerCase())
    if (isPrivate) {
      return `killCallbackUrl host "${hostname}" resolves to a private, loopback or link-local address`
    }
  }
  return null
}

// ─── In-memory stores ──────────────────────────────────────────────────────

// All OTel state is bounded (F10). Callers are untrusted MCP clients, so every
// collection has a hard cardinality, identifiers have a length cap, windowed
// spend is kept in compacting per-(agent, task) rings rather than one
// process-lifetime array, and repeated span IDs are counted once.

/** Hard limits on OTel state. */
export const OTEL_LIMITS = {
  maxPolicies: 1000,
  maxIdentifierLength: 128,
  maxWindowMs: 30 * 24 * 60 * 60 * 1000,
  maxAgents: 1000,
  maxTasksPerAgent: 32,
  maxRecordsPerTask: 512,
  maxTotalRecords: 100_000,
  maxDecisions: 1000,
  maxSeenSpans: 100_000,
  maxHistoryLimit: 200,
} as const

interface WindowRecord {
  timestamp: number
  amountUsd: number
}

interface TaskLedger {
  lifetimeUsd: number
  recent: WindowRecord[]
}

interface AgentLedger {
  lifetimeUsd: number
  /** Keyed by taskId ('' = no task). */
  tasks: Map<string, TaskLedger>
}

const _policies: Map<string, AgentBudgetPolicy> = new Map()
const _ledgers: Map<string, AgentLedger> = new Map()
let _totalRecords = 0
const _decisions: BudgetDecision[] = []
/** Span identity → largest cost already counted for it. */
const _seenSpans: Map<string, number> = new Map()

/** Build a policy key from agentId + optional taskId */
function policyKey(agentId: string, taskId?: string): string {
  return taskId ? `${agentId}::${taskId}` : agentId
}

/** Reset all state — useful for testing */
export function _resetOTelBudgetState(): void {
  _policies.clear()
  _ledgers.clear()
  _totalRecords = 0
  _decisions.length = 0
  _seenSpans.clear()
}

/** Current state sizes (tests and diagnostics). */
export function _otelStateSizes(): {
  policies: number
  agents: number
  records: number
  decisions: number
  seenSpans: number
} {
  return {
    policies: _policies.size,
    agents: _ledgers.size,
    records: _totalRecords,
    decisions: _decisions.length,
    seenSpans: _seenSpans.size,
  }
}

function assertIdentifier(value: string, field: string): void {
  if (value.length === 0 || value.length > OTEL_LIMITS.maxIdentifierLength) {
    throw new Error(`${field} must be 1-${OTEL_LIMITS.maxIdentifierLength} characters`)
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must not contain control characters`)
  }
}

/** Merge the two oldest records; keeps the later timestamp (over-counts, never under). */
function compactOldest(ring: WindowRecord[]): void {
  if (ring.length < 2) return
  const [a, b] = ring as [WindowRecord, WindowRecord]
  ring.splice(0, 2, { timestamp: b.timestamp, amountUsd: a.amountUsd + b.amountUsd })
  _totalRecords--
}

function pruneRing(ring: WindowRecord[], now: number): void {
  const cutoff = now - OTEL_LIMITS.maxWindowMs
  let drop = 0
  while (drop < ring.length && ring[drop]!.timestamp < cutoff) drop++
  if (drop > 0) {
    ring.splice(0, drop)
    _totalRecords -= drop
  }
}

/** Largest ring anywhere (only scanned when the global budget is exhausted). */
function largestRing(): WindowRecord[] | null {
  let best: WindowRecord[] | null = null
  for (const ledger of _ledgers.values()) {
    for (const task of ledger.tasks.values()) {
      if (!best || task.recent.length > best.length) best = task.recent
    }
  }
  return best && best.length >= 2 ? best : null
}

/**
 * Record a spend. Returns false (fail closed) when a new agent or task would
 * exceed the cardinality limits; the caller then blocks the span.
 */
function recordSpend(agentId: string, taskId: string | undefined, amountUsd: number, now: number): boolean {
  let ledger = _ledgers.get(agentId)
  if (!ledger) {
    if (_ledgers.size >= OTEL_LIMITS.maxAgents) return false
    ledger = { lifetimeUsd: 0, tasks: new Map() }
    _ledgers.set(agentId, ledger)
  }
  const taskKey = taskId ?? ''
  let task = ledger.tasks.get(taskKey)
  if (!task) {
    if (ledger.tasks.size >= OTEL_LIMITS.maxTasksPerAgent) return false
    task = { lifetimeUsd: 0, recent: [] }
    ledger.tasks.set(taskKey, task)
  }
  pruneRing(task.recent, now)
  if (task.recent.length >= OTEL_LIMITS.maxRecordsPerTask) compactOldest(task.recent)
  if (_totalRecords >= OTEL_LIMITS.maxTotalRecords) {
    const victim = task.recent.length >= 2 ? task.recent : largestRing()
    if (!victim) return false
    compactOldest(victim)
  }
  task.recent.push({ timestamp: now, amountUsd })
  _totalRecords++
  task.lifetimeUsd += amountUsd
  ledger.lifetimeUsd += amountUsd
  return true
}

/**
 * Amount of this span's cost not yet counted.
 *
 * Spans are identified by (agent, task, trace, span) — never by trace/span
 * alone, so one agent's IDs cannot suppress another agent's spend. A replay
 * of a known span counts only the increase over the cost already recorded
 * for it (a replay can never LOWER accumulated spend or hide a larger cost).
 * Spans without both IDs are always counted in full.
 *
 * Read-only: call `markCounted()` only after the amount was actually
 * recorded, so a span refused at capacity is not remembered as counted (a
 * replay of it must be refused again, not waved through as a duplicate).
 */
function uncountedCost(
  agentId: string,
  taskId: string | undefined,
  traceId: string | undefined,
  spanId: string | undefined,
  costUsd: number
): { amount: number; markCounted: () => void } {
  if (!traceId || !spanId) return { amount: costUsd, markCounted: () => {} }
  const key = `${agentId}\u0000${taskId ?? ''}\u0000${traceId}\u0000${spanId}`
  const seen = _seenSpans.get(key)
  if (seen !== undefined && costUsd <= seen) return { amount: 0, markCounted: () => {} }
  return {
    amount: seen === undefined ? costUsd : costUsd - seen,
    markCounted: () => {
      _seenSpans.delete(key)
      _seenSpans.set(key, Math.max(costUsd, seen ?? 0))
      while (_seenSpans.size > OTEL_LIMITS.maxSeenSpans) {
        const oldest = _seenSpans.keys().next()
        if (oldest.done) break
        // Forgetting an old span can only make a later replay count twice —
        // over-reporting spend, which is the fail-safe direction for a budget.
        _seenSpans.delete(oldest.value)
      }
    },
  }
}

function pushDecision(decision: BudgetDecision): void {
  _decisions.push(decision)
  if (_decisions.length > OTEL_LIMITS.maxDecisions) {
    _decisions.splice(0, _decisions.length - OTEL_LIMITS.maxDecisions)
  }
}

// ─── Core Logic ────────────────────────────────────────────────────────────

/** Outcome of {@link registerPolicy}. */
export interface PolicyRegistrationResult {
  /**
   * Present when the policy's killCallbackUrl was refused and dropped. The
   * policy — including its spend cap — was still registered.
   */
  killCallbackWarning?: string
}

/**
 * Register a budget policy for an agent or agent+task combination.
 *
 * Fail-closed on the kill-callback URL, but scoped to the callback alone: a
 * policy naming a destination this server must not POST to (non-http(s) scheme,
 * embedded credentials, private / loopback / link-local host) is stored with
 * that URL stripped and a warning returned, rather than being rejected.
 *
 * Refusing the whole policy would be a worse outcome than the SSRF it prevents:
 * the caller asked for a $N spend ceiling, and dropping the registration
 * silently leaves that agent's spend uncapped (evaluateSpan falls through to
 * "No budget policy registered", action 'allow', limit Infinity). Stripping the
 * URL refuses the SSRF just as completely — nothing is ever POSTed to it — while
 * the cap the caller actually asked for takes effect. Operators whose webhook
 * legitimately lives in private space can opt that host in via
 * {@link KILL_CALLBACK_ALLOWLIST_ENV}.
 */
export function registerPolicy(policy: AgentBudgetPolicy): PolicyRegistrationResult {
  assertIdentifier(policy.agentId, 'agentId')
  if (policy.taskId !== undefined) assertIdentifier(policy.taskId, 'taskId')
  if (!Number.isFinite(policy.maxSpendUsd) || policy.maxSpendUsd <= 0) {
    throw new Error('maxSpendUsd must be a positive finite number')
  }
  if (!Number.isFinite(policy.windowMs) || policy.windowMs < 0 || policy.windowMs > OTEL_LIMITS.maxWindowMs) {
    throw new Error(`windowMs must be between 0 and ${OTEL_LIMITS.maxWindowMs}`)
  }
  const registrationKey = policyKey(policy.agentId, policy.taskId)
  if (!_policies.has(registrationKey) && _policies.size >= OTEL_LIMITS.maxPolicies) {
    throw new Error(`At most ${OTEL_LIMITS.maxPolicies} OTel budget policies may be registered`)
  }
  let stored = policy
  let killCallbackWarning: string | undefined

  if (policy.killCallbackUrl !== undefined) {
    const urlError = validateKillCallbackUrl(policy.killCallbackUrl)
    if (urlError) {
      killCallbackWarning =
        `Kill callback disabled — ${urlError}. The spend cap is registered and ` +
        `enforced; no callback will be sent on breach. If this webhook is a ` +
        `trusted internal host, add it to ${KILL_CALLBACK_ALLOWLIST_ENV}.`
      const { killCallbackUrl: _refused, ...withoutCallback } = policy
      stored = withoutCallback
    }
  }

  const key = policyKey(policy.agentId, policy.taskId)
  _policies.set(key, stored)
  return killCallbackWarning ? { killCallbackWarning } : {}
}

function getApplicablePolicy(agentId: string, taskId?: string): AgentBudgetPolicy | undefined {
  const taskPolicy = taskId ? _policies.get(policyKey(agentId, taskId)) : undefined
  const agentPolicy = _policies.get(policyKey(agentId))
  return taskPolicy ?? agentPolicy
}

/**
 * Accumulated spend for an agent (optionally one task) within a window.
 * Lifetime totals are O(1); windowed sums scan only that agent's bounded
 * rings.
 */
function getAccumulatedSpend(agentId: string, taskId?: string, windowMs?: number): number {
  const ledger = _ledgers.get(agentId)
  if (!ledger) return 0
  const tasks =
    taskId === undefined
      ? Array.from(ledger.tasks.values())
      : ledger.tasks.has(taskId)
        ? [ledger.tasks.get(taskId)!]
        : []
  if (!windowMs || windowMs <= 0) {
    return taskId === undefined
      ? ledger.lifetimeUsd
      : tasks.reduce((sum, task) => sum + task.lifetimeUsd, 0)
  }
  const cutoff = Date.now() - windowMs
  let sum = 0
  for (const task of tasks) {
    for (const record of task.recent) {
      if (record.timestamp >= cutoff) sum += record.amountUsd
    }
  }
  return sum
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

  if (!Number.isFinite(costUsd) || costUsd <= 0) return null
  assertIdentifier(agentId, 'agentId')
  if (taskId !== undefined) assertIdentifier(taskId, 'taskId')

  // A replayed span is evaluated but only its uncounted increase is recorded.
  const uncounted = uncountedCost(agentId, taskId, attrs.traceId, attrs.spanId, costUsd)
  if (uncounted.amount > 0) {
    if (recordSpend(agentId, taskId, uncounted.amount, Date.now())) {
      uncounted.markCounted()
    } else {
      const refused: BudgetDecision = {
        agentId,
        taskId,
        action: 'block',
        accumulatedSpendUsd: getAccumulatedSpend(agentId, taskId),
        budgetLimitUsd: 0,
        remainingUsd: 0,
        utilizationPct: 100,
        reason: 'OTel budget state is at capacity for new agents/tasks (fail-closed).',
        timestamp: Date.now(),
      }
      pushDecision(refused)
      return refused
    }
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

  pushDecision(decision)
  return decision
}

/**
 * POST the kill decision to the policy's circuit-breaker webhook.
 *
 * Failure handling is loud but non-fatal: an invalid URL, a host that resolves
 * into private space, a timeout, or a network/HTTP failure is reported in the
 * returned object (surfaced verbatim in the
 * otel_evaluate_spend result) and never throws. The breaker decision is
 * computed before this runs and is never altered or swallowed by it — a broken
 * webhook cannot turn a kill into an allow. Redirects are not followed: a 3xx
 * is reported as a failed callback rather than re-issued against a host that
 * never passed validation.
 *
 * KILL_CALLBACK_TIMEOUT_MS is one deadline for the whole path, DNS resolution
 * included, not a per-leg timeout: a resolver that never answers cannot hold
 * span evaluation open past it.
 *
 * Every unsuccessful outcome — refused URL host, refused DNS answer, closed
 * port, open-but-silent port, HTTP error status, timeout — returns the same
 * {@link KILL_CALLBACK_GENERIC_FAILURE} string, and the response status is
 * never returned. The destination is caller-supplied, so any reason that varied
 * with what the server found would be a probe oracle: distinct strings for
 * "resolves into private space" / "does not resolve" / "connection refused" /
 * "timed out" / "HTTP error" are between them a working internal DNS
 * enumerator and port scanner. The specific reason is logged server-side.
 *
 * What remains visible to the caller is two bits, not one, plus how long the
 * call took: `ok` (was the POST delivered) and `attempted` (did the request
 * leave this process at all). `attempted` is false for exactly the two
 * pre-flight refusals — the literal-URL check and the DNS gate.
 *
 * On the literal-URL side that second bit carries nothing: those refusals are a
 * pure function of the string the caller itself supplied (bad scheme, embedded
 * credentials, a private address written out as a literal), so the caller learns
 * only what it already knew. That is also why those refusals keep their specific
 * message rather than collapsing to the generic one.
 *
 * On the DNS side it is a real oracle, and a deliberately accepted one:
 * attempted=false says "this name did not yield a usable public address from
 * this server". Judgement: acceptable. The three underlying states — resolves
 * into private space, does not resolve, resolves to nothing — still collapse
 * into that single value, so the primitive that actually enumerates an internal
 * network (does this name exist? does it point somewhere private?) stays shut.
 * What leaks is one bit per name, and it says something a public resolver does
 * not already say only where the name is split-horizon. The alternative —
 * reporting attempted=true for a callback that never left the process — would
 * tell an operator their circuit-breaker webhook fired when it never did, so
 * neither bit can be removed without lying about whether the breaker fired.
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

  // One deadline for the whole callback path — DNS resolution and the POST
  // share it.
  const deadline = AbortSignal.timeout(KILL_CALLBACK_TIMEOUT_MS)

  // The safe transport resolves the host once, refuses any private answer,
  // and connects ONLY to an address from that validated set (pinned lookup),
  // so a rebinding resolver cannot redirect the POST after the check (F9).
  // `attempted` flips only when the connector — the socket — is reached.
  let attempted = false
  const connector = activeConnector()
  const allowlist = killCallbackAllowlist()
  const callbackHost = (() => {
    try {
      return normalizeHost(new URL(policy.killCallbackUrl).hostname)
    } catch {
      return ''
    }
  })()
  const transport = createSafeTransport({
    // https everywhere except an operator-allowlisted (typically in-VPC) host.
    requireHttps: !allowlist.has(callbackHost),
    allowedPrivateHosts: allowlist,
    maxResponseBytes: 64 * 1024,
    connector: (url, init, pinned, limits) => {
      attempted = true
      return connector(url, init, pinned, limits)
    },
  })

  let response: Response
  try {
    response = await transport(policy.killCallbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      // Do not follow redirects: a validated public URL must not be able to
      // 302 the POST into the private hosts validateKillCallbackUrl refuses.
      redirect: 'manual',
      signal: deadline,
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
  } catch (error: unknown) {
    // Pre-connection refusals (DNS gate, timeout during lookup) report
    // attempted=false; transport failures after connecting report true. The
    // reason is logged, never returned: see the enumeration-oracle notes.
    logKillCallbackFailure(
      policy.killCallbackUrl,
      error instanceof UnsafeDestinationError
        ? error.reason
        : deadline.aborted
          ? `not delivered within the ${KILL_CALLBACK_TIMEOUT_MS}ms kill-callback deadline`
          : `transport failure: ${error instanceof Error ? error.message : String(error)}`
    )
    return { attempted, ok: false, error: KILL_CALLBACK_GENERIC_FAILURE }
  }
  try {
    await response.body?.cancel()
  } catch {
    // ignore
  }
  // No status code, and the same string an unreachable host produces: the
  // destination is caller-supplied, and a reason that distinguished "spoke
  // HTTP and refused" from "never spoke" is a service scanner.
  if (!response.ok) {
    logKillCallbackFailure(policy.killCallbackUrl, `webhook returned HTTP ${response.status}`)
  }
  return {
    attempted: true,
    ok: response.ok,
    ...(response.ok ? {} : { error: KILL_CALLBACK_GENERIC_FAILURE }),
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
  const bounded = Math.max(0, Math.min(Math.floor(limit) || 0, OTEL_LIMITS.maxHistoryLimit))
  if (bounded === 0) return []
  return _decisions
    .filter((d) => d.agentId === agentId)
    .slice(-bounded)
}

/**
 * Get all registered policies (for introspection).
 */
export function listPolicies(): AgentBudgetPolicy[] {
  return Array.from(_policies.values())
}

// ─── MCP Tool Definitions ──────────────────────────────────────────────────

export const OTelRegisterPolicySchema = z.object({
  agentId: z.string().min(1).max(128).describe('Agent or session identifier from AgentCore'),
  taskId: z.string().min(1).max(128).optional().describe('Optional task-level identifier'),
  maxSpendUsd: z.number().positive().finite().describe('Maximum spend in USD'),
  windowMs: z
    .number()
    .min(0)
    .max(30 * 24 * 60 * 60 * 1000)
    .default(0)
    .describe('Rolling window in ms (0 = lifetime budget)'),
  breachAction: z
    .enum(['warn', 'block', 'kill'])
    .default('block')
    .describe('Action on budget breach: warn, block, or kill (circuit-breaker)'),
  // Deliberately NOT rejected here. A schema-level refusal fails the whole
  // otel_register_budget_policy call, which would leave the agent with no
  // spend cap at all — a strictly worse outcome than the SSRF being refused.
  // registerPolicy drops an unacceptable URL and keeps the cap; see its notes.
  killCallbackUrl: z
    .string()
    .optional()
    .describe(
      'Webhook URL to invoke when circuit-breaker trips (kill action). ' +
        'Must be http(s), must not embed credentials, and must not point at a ' +
        'private, loopback or link-local host. A URL that fails those rules is ' +
        'dropped with a warning; the spend cap is still registered and enforced.'
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
        description:
          'Circuit-breaker webhook URL (http(s) only, no embedded credentials, ' +
          'no private/loopback/link-local hosts). A URL failing those rules is ' +
          'dropped with a killCallbackWarning — the spend cap is still ' +
          'registered and enforced. Host names are resolved once before the ' +
          'callback fires, a host with any private answer is refused, and the ' +
          'connection is pinned to the validated address (no DNS rebinding). ' +
          'Undelivered ' +
          'callbacks report only ok=false and a single generic reason; the ' +
          'response status and the specific failure are never returned.',
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

    const { killCallbackWarning } = registerPolicy(policy)
    if (killCallbackWarning) {
      // The callback was refused, so do not echo the rejected URL back as if
      // it were in force.
      delete policy.killCallbackUrl
    }

    return {
      content: [
        textContent(
          JSON.stringify({
            success: true,
            policy: {
              key: policyKey(policy.agentId, policy.taskId),
              ...policy,
            },
            ...(killCallbackWarning ? { killCallbackWarning } : {}),
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
  agentId: z.string().min(1).max(128).describe('Agent ID from OTel span attribute agentcore.agent.id'),
  taskId: z.string().min(1).max(128).optional().describe('Task ID from OTel span attribute agentcore.task.id'),
  costUsd: z.number().finite().describe('Cost in USD from this span'),
  spanId: z.string().max(128).optional().describe('OTel span ID (replays of a trace/span pair are counted once)'),
  traceId: z.string().max(128).optional().describe('OTel trace ID'),
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
  agentId: z.string().min(1).max(128).describe('Agent ID to check budget status for'),
  includeHistory: z
    .boolean()
    .default(false)
    .describe('Include recent decision history'),
  historyLimit: z.number().int().min(1).max(200).default(20).describe('Max history entries to return (1-200)'),
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
