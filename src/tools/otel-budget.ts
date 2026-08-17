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

// ─── Kill-callback constraints ─────────────────────────────────────────────

/** Timeout for the circuit-breaker kill callback POST. */
export const KILL_CALLBACK_TIMEOUT_MS = 10_000

const KILL_CALLBACK_ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** Name suffixes that only ever resolve inside a private network. */
const KILL_CALLBACK_BLOCKED_HOST_SUFFIXES = ['.internal', '.local', '.localhost', '.home.arpa']

/** Exact host names that are never a legitimate external webhook. */
const KILL_CALLBACK_BLOCKED_HOSTS = new Set(['localhost', 'metadata.google.internal'])

/** Parse a dotted-quad IPv4 literal into octets, or null if it is not one. */
function parseIpv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return null
  return octets
}

/**
 * True for IPv4 space that is not routable on the public internet: this-network,
 * loopback, RFC1918, link-local (which is where cloud instance-metadata lives),
 * CGNAT, multicast and reserved.
 */
function isPrivateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

/**
 * Expand an IPv6 literal into its eight 16-bit hextets, or null if it is not a
 * well-formed IPv6 address. Handles "::" compression and a trailing dotted-quad
 * (::ffff:127.0.0.1), because a textual prefix test cannot see through either.
 * The URL parser canonicalises the dotted-quad tail out of bracketed literals,
 * but a resolver answer is raw text and does carry that form, so both are
 * handled here.
 */
function parseIpv6(host: string): number[] | null {
  if (host.includes('.')) {
    // Trailing dotted-quad form: rewrite the IPv4 tail as two hextets first.
    const lastColon = host.lastIndexOf(':')
    if (lastColon === -1) return null
    const v4 = parseIpv4(host.slice(lastColon + 1))
    if (v4 === null) return null
    const [a, b, c, d] = v4
    host = `${host.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }

  const halves = host.split('::')
  if (halves.length > 2) return null
  const parseGroup = (group: string): number[] | null => {
    if (group === '') return []
    const parts = group.split(':')
    const out: number[] = []
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null
      out.push(parseInt(part, 16))
    }
    return out
  }

  const head = parseGroup(halves[0])
  const tail = halves.length === 2 ? parseGroup(halves[1]) : []
  if (head === null || tail === null) return null

  if (halves.length === 1) return head.length === 8 ? head : null
  const gap = 8 - head.length - tail.length
  if (gap < 1) return null
  return [...head, ...Array<number>(gap).fill(0), ...tail]
}

/** True when a pair of hextets encodes an IPv4 address in private space. */
function embeddedIpv4IsPrivate(hi: number, lo: number): boolean {
  return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff])
}

/**
 * True for IPv6 space that is not routable on the public internet, or that
 * tunnels an IPv4 target that is not: unspecified, loopback, unique-local
 * (fc00::/7), link-local (fe80::/10), and every transition format that carries
 * an IPv4 address inside an IPv6 literal — IPv4-mapped (::ffff:0:0/96),
 * IPv4-compatible (::a.b.c.d, e.g. ::a9fe:a9fe for the metadata service), NAT64
 * (64:ff9b::/96), 6to4 (2002::/16) and Teredo (2001:0::/32). Each of those
 * would otherwise smuggle a private IPv4 destination past the IPv4 checks.
 */
function isPrivateIpv6(host: string): boolean {
  const h = parseIpv6(host)
  if (h === null) return true // Unparseable literal in brackets — refuse it.

  const zeroPrefix = (n: number): boolean => h.slice(0, n).every((x) => x === 0)

  // Unspecified (::) and loopback (::1). Deliberately redundant with the
  // IPv4-compatible rule below (:: is ::0.0.0.0 and ::1 is ::0.0.0.1, both of
  // which land in 0.0.0.0/8): the two most important addresses in this list
  // stay refused even if either rule is later narrowed.
  if (zeroPrefix(7) && (h[7] === 0 || h[7] === 1)) return true
  // Unique-local fc00::/7 and link-local fe80::/10.
  if ((h[0] & 0xfe00) === 0xfc00) return true
  if ((h[0] & 0xffc0) === 0xfe80) return true
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d.
  if (zeroPrefix(5) && h[5] === 0xffff) return embeddedIpv4IsPrivate(h[6], h[7])
  if (zeroPrefix(6)) return embeddedIpv4IsPrivate(h[6], h[7])
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48.
  if (h[0] === 0x0064 && h[1] === 0xff9b) {
    return h[2] === 0x0001 || embeddedIpv4IsPrivate(h[6], h[7])
  }
  // 6to4 2002::/16 carries the IPv4 address in the next 32 bits.
  if (h[0] === 0x2002) return embeddedIpv4IsPrivate(h[1], h[2])
  // Teredo 2001:0::/32 carries the (bit-inverted) client IPv4 in the last 32.
  if (h[0] === 0x2001 && h[1] === 0x0000) {
    return embeddedIpv4IsPrivate(~h[6] & 0xffff, ~h[7] & 0xffff)
  }
  return false
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

  const hostname = parsed.hostname.toLowerCase()
  const ipv6Literal = hostname.startsWith('[')
  const host = ipv6Literal
    ? hostname.slice(1, -1)
    : // "localhost." is the same host as "localhost" — drop the FQDN root dot.
      hostname.replace(/\.$/, '')
  // No empty-host case: the WHATWG parser rejects an http(s) URL without a host
  // outright, so `new URL` above has already thrown for those.
  const ipv4 = parseIpv4(host)
  const privateHost =
    KILL_CALLBACK_BLOCKED_HOSTS.has(host) ||
    KILL_CALLBACK_BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    (ipv4 !== null ? isPrivateIpv4(ipv4) : ipv6Literal && isPrivateIpv6(host))
  if (privateHost) {
    return `killCallbackUrl must not target a private, loopback or link-local host — "${parsed.hostname}" is not externally routable`
  }
  return null
}

/**
 * Resolve a callback host and report whether any address it maps to sits in
 * private space. This is what closes the DNS half of the SSRF: without it a
 * caller-supplied name pointing at 169.254.169.254 passes the literal checks
 * above and gets fetched verbatim.
 *
 * Fails closed — a name that cannot be resolved is refused rather than fetched.
 *
 * Known residual gap: the connection is not pinned to the address that was
 * checked, so a resolver that returns a public address here and a private one
 * to the fetch (DNS rebinding) still wins the race. Closing that needs a custom
 * agent/socket, which global fetch does not expose. Operators who need a hard
 * guarantee should front the webhook with an egress allowlist. The status of the
 * callback response is deliberately not returned to the caller, so even a
 * successful rebind yields no oracle.
 */
export async function resolvedHostIsPrivate(rawUrl: string): Promise<string | null> {
  let hostname: string
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return 'killCallbackUrl is not a valid URL'
  }
  // Bracketed literals were already checked exactly by validateKillCallbackUrl.
  if (hostname.startsWith('[')) return null
  if (parseIpv4(hostname.replace(/\.$/, '')) !== null) return null

  let addresses: Array<{ address: string; family: number }>
  try {
    const { lookup } = await import('node:dns/promises')
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    return `killCallbackUrl host "${hostname}" could not be resolved`
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
 *
 * Fail-closed on the kill-callback URL: a policy naming a destination this
 * server must not POST to (non-http(s) scheme, embedded credentials, private /
 * loopback / link-local host) is rejected outright rather than stored, so the
 * SSRF is refused at configuration time instead of at breach time.
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

/**
 * POST the kill decision to the policy's circuit-breaker webhook.
 *
 * Failure handling is loud but non-fatal: an invalid URL, a host that resolves
 * into private space, a timeout (KILL_CALLBACK_TIMEOUT_MS), or a network/HTTP
 * failure is reported in the returned object (surfaced verbatim in the
 * otel_evaluate_spend result) and never throws. The breaker decision is
 * computed before this runs and is never altered or swallowed by it — a broken
 * webhook cannot turn a kill into an allow. Redirects are not followed: a 3xx
 * is reported as a failed callback rather than re-issued against a host that
 * never passed validation.
 *
 * The response status is deliberately NOT returned. The destination is
 * caller-supplied, so handing back a per-host status code would turn the
 * callback into a probe oracle for whatever the server can reach. Callers get
 * ok/failed and a generic reason only.
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

  // Names are only checkable once resolved, and only at fire time.
  const dnsError = await resolvedHostIsPrivate(policy.killCallbackUrl)
  if (dnsError) {
    return {
      attempted: false,
      ok: false,
      error: `Kill callback not invoked: ${dnsError}`,
    }
  }

  try {
    const response = await fetch(policy.killCallbackUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      // Do not follow redirects: a validated public URL must not be able to
      // 302 the POST into the private hosts validateKillCallbackUrl refuses.
      redirect: 'manual',
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

    // No status code: the destination is caller-supplied and echoing per-host
    // statuses back would make this a probe oracle for internal services.
    return {
      attempted: true,
      ok: response.ok,
      ...(response.ok ? {} : { error: 'Kill callback was rejected by the webhook' }),
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
    .superRefine((value, ctx) => {
      const urlError = validateKillCallbackUrl(value)
      if (urlError) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: urlError })
      }
    })
    .optional()
    .describe(
      'Webhook URL to invoke when circuit-breaker trips (kill action). ' +
        'Must be http(s), must not embed credentials, and must not point at a ' +
        'private, loopback or link-local host.'
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
          'no private/loopback/link-local hosts). Host names are resolved and ' +
          're-checked before the callback fires, and a host that resolves into ' +
          'private space is refused. The connection is not pinned to the checked ' +
          'address, so a rebinding resolver is still out of scope; the response ' +
          'status is never returned to the caller.',
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
