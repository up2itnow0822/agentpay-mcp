/**
 * Tests for OTel Budget Circuit-Breaker module
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  registerPolicy,
  evaluateSpan,
  decisionToOTelEvent,
  getDecisionHistory,
  handleOTelBudgetStatus,
  handleOTelEvaluateSpend,
  handleOTelRegisterPolicy,
  invokeKillCallback,
  listPolicies,
  MAX_DECISION_HISTORY,
  MAX_LEDGER_ENTRIES,
  MAX_SEEN_SPANS,
  OTelRegisterPolicySchema,
  _getOTelBudgetStoreSizes,
  _resetOTelBudgetState,
} from '../src/tools/otel-budget.js'

const originalFetch = global.fetch

describe('OTel Budget Circuit-Breaker', () => {
  beforeEach(() => {
    _resetOTelBudgetState()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  describe('registerPolicy', () => {
    it('registers an agent-level policy', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 10.0,
        windowMs: 0,
        breachAction: 'block',
      })
      expect(listPolicies()).toHaveLength(1)
      expect(listPolicies()[0].agentId).toBe('agent-001')
    })

    it('registers a task-level policy', () => {
      registerPolicy({
        agentId: 'agent-001',
        taskId: 'task-research',
        maxSpendUsd: 2.0,
        windowMs: 3600000,
        breachAction: 'kill',
      })
      const policies = listPolicies()
      expect(policies).toHaveLength(1)
      expect(policies[0].taskId).toBe('task-research')
    })
  })

  describe('evaluateSpan', () => {
    it('returns null for spans without agent ID', () => {
      const result = evaluateSpan({ 'agentcore.cost.usd': 0.5 })
      expect(result).toBeNull()
    })

    it('returns null for zero-cost spans', () => {
      const result = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 0,
      })
      expect(result).toBeNull()
    })

    it('allows spend within budget', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 10.0,
        windowMs: 0,
        breachAction: 'block',
      })

      const decision = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 1.0,
        spanId: 'span-1',
        traceId: 'trace-1',
      })

      expect(decision).not.toBeNull()
      expect(decision!.action).toBe('allow')
      expect(decision!.accumulatedSpendUsd).toBe(1.0)
      expect(decision!.remainingUsd).toBe(9.0)
    })

    it('warns at 90% utilization', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 10.0,
        windowMs: 0,
        breachAction: 'block',
      })

      // Spend 9.1 to cross 90%
      evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 9.1,
        spanId: 'span-1',
      })

      const decision = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 0.01,
        spanId: 'span-2',
      })

      expect(decision!.action).toBe('warn')
      expect(decision!.utilizationPct).toBeGreaterThanOrEqual(90)
    })

    it('blocks when budget exceeded with block policy', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 5.0,
        windowMs: 0,
        breachAction: 'block',
      })

      evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 5.0,
        spanId: 'span-1',
      })

      const decision = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 0.5,
        spanId: 'span-2',
      })

      expect(decision!.action).toBe('block')
      expect(decision!.accumulatedSpendUsd).toBe(5.5)
    })

    it('kills when budget exceeded with kill policy', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 5.0,
        windowMs: 0,
        breachAction: 'kill',
      })

      evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 6.0,
        spanId: 'span-1',
      })

      const decision = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 0.1,
        spanId: 'span-2',
      })

      expect(decision!.action).toBe('kill')
    })

    it('prefers task-level policy over agent-level', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 100.0,
        windowMs: 0,
        breachAction: 'block',
      })
      registerPolicy({
        agentId: 'agent-001',
        taskId: 'expensive-task',
        maxSpendUsd: 2.0,
        windowMs: 0,
        breachAction: 'kill',
      })

      evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.task.id': 'expensive-task',
        'agentcore.cost.usd': 2.5,
        spanId: 'span-1',
      })

      const decision = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.task.id': 'expensive-task',
        'agentcore.cost.usd': 0.1,
        spanId: 'span-2',
      })

      expect(decision!.action).toBe('kill')
    })

    it('aggregates spend across tasks when using an agent-level policy', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 5.0,
        windowMs: 0,
        breachAction: 'block',
      })

      evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.task.id': 'task-a',
        'agentcore.cost.usd': 3.0,
        spanId: 'span-1',
      })

      const decision = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.task.id': 'task-b',
        'agentcore.cost.usd': 2.5,
        spanId: 'span-2',
      })

      expect(decision).not.toBeNull()
      expect(decision!.action).toBe('block')
      expect(decision!.accumulatedSpendUsd).toBe(5.5)
    })

    it('reads gen_ai.usage.cost as fallback', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 10.0,
        windowMs: 0,
        breachAction: 'block',
      })

      const decision = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'gen_ai.usage.cost': 3.0,
        spanId: 'span-1',
      })

      expect(decision!.action).toBe('allow')
      expect(decision!.accumulatedSpendUsd).toBe(3.0)
    })
  })

  describe('span deduplication', () => {
    const bigBudget = {
      agentId: 'agent-001',
      maxSpendUsd: 1_000_000,
      windowMs: 0,
      breachAction: 'block' as const,
    }

    it('counts a re-delivered span only once', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 10.0,
        windowMs: 0,
        breachAction: 'block',
      })

      const span = {
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 4.0,
        spanId: 'span-1',
        traceId: 'trace-1',
      }

      const first = evaluateSpan(span)!
      const redelivered = evaluateSpan(span)!

      expect(first.accumulatedSpendUsd).toBe(4.0)
      expect(first.duplicateSpan).toBe(false)
      expect(redelivered.accumulatedSpendUsd).toBe(4.0)
      expect(redelivered.duplicateSpan).toBe(true)
      expect(redelivered.remainingUsd).toBe(6.0)
      expect(redelivered.action).toBe('allow')
    })

    it('counts distinct spans in the same trace separately', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 10.0,
        windowMs: 0,
        breachAction: 'block',
      })

      evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 4.0,
        spanId: 'span-1',
        traceId: 'trace-1',
      })
      const second = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 4.0,
        spanId: 'span-2',
        traceId: 'trace-1',
      })!

      expect(second.duplicateSpan).toBe(false)
      expect(second.accumulatedSpendUsd).toBe(8.0)
    })

    it('does not collapse the same spanId reported by different agents', () => {
      registerPolicy(bigBudget)
      registerPolicy({ ...bigBudget, agentId: 'agent-002' })

      const a = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 2.0,
        spanId: 'span-1',
      })!
      const b = evaluateSpan({
        'agentcore.agent.id': 'agent-002',
        'agentcore.cost.usd': 3.0,
        spanId: 'span-1',
      })!

      expect(a.accumulatedSpendUsd).toBe(2.0)
      expect(b.duplicateSpan).toBe(false)
      expect(b.accumulatedSpendUsd).toBe(3.0)
    })

    it('counts spans with no spanId every time — an unidentified span is never deduped', () => {
      registerPolicy(bigBudget)

      evaluateSpan({ 'agentcore.agent.id': 'agent-001', 'agentcore.cost.usd': 1.0 })
      const second = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 1.0,
      })!

      expect(second.duplicateSpan).toBe(false)
      expect(second.accumulatedSpendUsd).toBe(2.0)
    })

    it('does not trip the circuit breaker when a client retries the same span', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
      global.fetch = fetchMock as typeof global.fetch

      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 10.0,
        windowMs: 0,
        breachAction: 'kill',
        killCallbackUrl: 'https://example.com/kill',
      })

      const call = { agentId: 'agent-001', costUsd: 6.0, spanId: 'span-1', traceId: 'trace-1' }
      await handleOTelEvaluateSpend(call)
      const retry = await handleOTelEvaluateSpend(call)

      const data = JSON.parse(retry.content[0].text)
      expect(data.decision.accumulatedSpendUsd).toBe(6.0)
      expect(data.decision.action).toBe('allow')
      expect(data.decision.duplicateSpan).toBe(true)
      expect(data.otelEvent['agentpay.duplicate_span']).toBe(true)
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('re-counts a re-delivery that arrives after its identity is evicted', () => {
      registerPolicy(bigBudget)

      for (let i = 0; i < MAX_SEEN_SPANS; i++) {
        evaluateSpan({
          'agentcore.agent.id': 'agent-001',
          'agentcore.cost.usd': 1.0,
          spanId: `span-${i}`,
        })
      }

      // Exactly at the horizon: nothing has been evicted yet.
      const atHorizon = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 1.0,
        spanId: 'span-0',
      })!
      expect(atHorizon.duplicateSpan).toBe(true)
      expect(atHorizon.accumulatedSpendUsd).toBe(MAX_SEEN_SPANS)

      // One span past the horizon evicts the oldest identity (span-0)...
      const overflow = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 1.0,
        spanId: 'span-overflow',
      })!
      expect(overflow.duplicateSpan).toBe(false)
      expect(overflow.accumulatedSpendUsd).toBe(MAX_SEEN_SPANS + 1)

      // ...so its re-delivery is counted again: over-counting is the
      // fail-safe direction for a spend breaker.
      const lateRedelivery = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 1.0,
        spanId: 'span-0',
      })!
      expect(lateRedelivery.duplicateSpan).toBe(false)
      expect(lateRedelivery.accumulatedSpendUsd).toBe(MAX_SEEN_SPANS + 2)

      // Identities still inside the horizon keep deduping.
      const stillDeduped = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 1.0,
        spanId: 'span-overflow',
      })!
      expect(stillDeduped.duplicateSpan).toBe(true)
      expect(stillDeduped.accumulatedSpendUsd).toBe(MAX_SEEN_SPANS + 2)
    })
  })

  describe('bounded spend ledger and decision log', () => {
    const HOUR_MS = 60 * 60 * 1000
    const DAY_MS = 24 * HOUR_MS
    const T0 = Date.parse('2026-01-01T00:00:00Z')

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(T0)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    const span = (costUsd: number, spanId: string) => ({
      'agentcore.agent.id': 'agent-001',
      'agentcore.cost.usd': costUsd,
      spanId,
    })

    it('never retires a record the active rolling window still reaches', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 10.0,
        windowMs: 7 * DAY_MS,
        breachAction: 'block',
      })

      evaluateSpan(span(4.0, 'span-1'))

      // Six days on: older than the 24h retention floor, but the policy's
      // 7-day window still reaches it, so it must stay in the ledger.
      vi.setSystemTime(T0 + 6 * DAY_MS)
      const decision = evaluateSpan(span(4.0, 'span-2'))!

      const sizes = _getOTelBudgetStoreSizes()
      expect(sizes.ledger).toBe(2)
      expect(sizes.archivedScopes).toBe(0)
      expect(decision.accumulatedSpendUsd).toBe(8.0)
    })

    it('preserves lifetime totals across eviction', async () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 5.0,
        windowMs: 0,
        breachAction: 'block',
      })

      evaluateSpan(span(3.0, 'span-1'))

      // Past the retention floor, and a lifetime budget has no rolling window
      // to protect the record — so it is retired into the archive.
      vi.setSystemTime(T0 + 25 * HOUR_MS)
      const decision = evaluateSpan(span(3.0, 'span-2'))!

      const sizes = _getOTelBudgetStoreSizes()
      expect(sizes.ledger).toBe(1)
      expect(sizes.archivedScopes).toBe(1)

      // The retired dollars still count: a lifetime budget cannot be reset by
      // eviction.
      expect(decision.accumulatedSpendUsd).toBe(6.0)
      expect(decision.action).toBe('block')

      const status = await handleOTelBudgetStatus({
        agentId: 'agent-001',
        includeHistory: false,
        historyLimit: 20,
      })
      const data = JSON.parse(status.content[0].text)
      expect(data.totalAccumulatedUsd).toBe(6.0)
      expect(data.policies[0].accumulatedSpendUsd).toBe(6.0)
    })

    it('does not add retired spend back into a window that no longer reaches it', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 5.0,
        windowMs: HOUR_MS,
        breachAction: 'block',
      })

      evaluateSpan(span(3.0, 'span-1'))

      vi.setSystemTime(T0 + 25 * HOUR_MS)
      const decision = evaluateSpan(span(3.0, 'span-2'))!

      expect(_getOTelBudgetStoreSizes().archivedScopes).toBe(1)
      // The archived span is a day outside the one-hour window: counting it
      // would wrongly block an agent that is inside its rolling budget.
      expect(decision.accumulatedSpendUsd).toBe(3.0)
      expect(decision.action).toBe('allow')
    })

    it('bounds every store under sustained load', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 1_000_000,
        windowMs: 0,
        breachAction: 'block',
      })

      const spans = MAX_LEDGER_ENTRIES + 2_000
      let last = null
      for (let i = 0; i < spans; i++) {
        last = evaluateSpan(span(1.0, `span-${i}`))
      }

      const sizes = _getOTelBudgetStoreSizes()
      expect(sizes.ledger).toBe(MAX_LEDGER_ENTRIES)
      expect(sizes.decisions).toBe(MAX_DECISION_HISTORY)
      expect(sizes.seenSpans).toBe(MAX_SEEN_SPANS)
      expect(sizes.archivedScopes).toBe(1)

      // Bounded, and still not a dollar short.
      expect(last!.accumulatedSpendUsd).toBe(spans)
    })

    it('counts every dollar when the hard ceiling retires in-window records', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 1_000_000,
        windowMs: 7 * DAY_MS,
        breachAction: 'block',
      })

      // The clock is frozen, so nothing ages out: only the MAX_LEDGER_ENTRIES
      // ceiling can retire these, and every retired record is inside the
      // policy's 7-day window.
      const spans = MAX_LEDGER_ENTRIES + 500
      let last = null
      for (let i = 0; i < spans; i++) {
        last = evaluateSpan(span(1.0, `span-${i}`))
      }

      const sizes = _getOTelBudgetStoreSizes()
      expect(sizes.ledger).toBe(MAX_LEDGER_ENTRIES)
      expect(sizes.archivedScopes).toBe(1)
      expect(last!.accumulatedSpendUsd).toBe(spans)
    })
  })

  describe('decisionToOTelEvent', () => {
    it('produces correct OTel event attributes', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 10.0,
        windowMs: 0,
        breachAction: 'kill',
      })

      const decision = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 11.0,
        spanId: 'span-1',
      })!

      // Second span triggers the kill
      const killDecision = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 0.1,
        spanId: 'span-2',
      })!

      const event = decisionToOTelEvent(killDecision)

      expect(event['event.name']).toBe('agentpay.budget.decision')
      expect(event['agentpay.action']).toBe('kill')
      expect(event['agentpay.circuit_breaker_tripped']).toBe(true)
      expect(event['agentpay.agent_id']).toBe('agent-001')
    })
  })

  describe('getDecisionHistory', () => {
    it('returns recent decisions', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 100.0,
        windowMs: 0,
        breachAction: 'block',
      })

      for (let i = 0; i < 5; i++) {
        evaluateSpan({
          'agentcore.agent.id': 'agent-001',
          'agentcore.cost.usd': 1.0,
          spanId: `span-${i}`,
        })
      }

      const history = getDecisionHistory('agent-001')
      expect(history).toHaveLength(5)
    })

    it('respects limit parameter', () => {
      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 100.0,
        windowMs: 0,
        breachAction: 'block',
      })

      for (let i = 0; i < 10; i++) {
        evaluateSpan({
          'agentcore.agent.id': 'agent-001',
          'agentcore.cost.usd': 1.0,
          spanId: `span-${i}`,
        })
      }

      const history = getDecisionHistory('agent-001', 3)
      expect(history).toHaveLength(3)
    })
  })

  describe('handleOTelEvaluateSpend', () => {
    it('invokes kill callback when kill policy trips', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
      global.fetch = fetchMock as typeof global.fetch

      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 1.0,
        windowMs: 0,
        breachAction: 'kill',
        killCallbackUrl: 'https://example.com/kill',
      })

      const result = await handleOTelEvaluateSpend({
        agentId: 'agent-001',
        costUsd: 1.5,
        spanId: 'span-1',
      })

      const data = JSON.parse(result.content[0].text)
      expect(fetchMock).toHaveBeenCalledWith(
        'https://example.com/kill',
        expect.objectContaining({ method: 'POST' })
      )
      expect(data.decision.action).toBe('kill')
      expect(data.killCallback).toEqual({
        attempted: true,
        ok: true,
        status: 204,
      })
    })
  })

  describe('kill callback URL validation', () => {
    const killDecision = {
      agentId: 'agent-001',
      action: 'kill' as const,
      accumulatedSpendUsd: 2,
      budgetLimitUsd: 1,
      remainingUsd: 0,
      utilizationPct: 200,
      reason: 'Budget exceeded',
      timestamp: Date.now(),
    }

    it('rejects non-http(s) schemes at registration time', () => {
      expect(() =>
        registerPolicy({
          agentId: 'agent-001',
          maxSpendUsd: 5.0,
          windowMs: 0,
          breachAction: 'kill',
          killCallbackUrl: 'ftp://198.51.100.7/kill',
        })
      ).toThrow(/http: or https:/)
      expect(listPolicies()).toHaveLength(0)
    })

    it('rejects embedded credentials at registration time', () => {
      expect(() =>
        registerPolicy({
          agentId: 'agent-001',
          maxSpendUsd: 5.0,
          windowMs: 0,
          breachAction: 'kill',
          killCallbackUrl: 'https://user:secret@example.com/kill',
        })
      ).toThrow(/credentials/)
      expect(listPolicies()).toHaveLength(0)
    })

    it('rejects unparseable URLs at registration time', () => {
      expect(() =>
        registerPolicy({
          agentId: 'agent-001',
          maxSpendUsd: 5.0,
          windowMs: 0,
          breachAction: 'kill',
          killCallbackUrl: 'not a url',
        })
      ).toThrow(/not a valid URL/)
    })

    it('rejects an invalid killCallbackUrl in the tool input schema', () => {
      const parsed = OTelRegisterPolicySchema.safeParse({
        agentId: 'agent-001',
        maxSpendUsd: 5.0,
        breachAction: 'kill',
        killCallbackUrl: 'file:///etc/passwd',
      })
      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        expect(parsed.error.issues[0].message).toMatch(/http: or https:/)
      }
    })

    it('returns a tool error instead of registering a policy with a bad callback URL', async () => {
      const result = await handleOTelRegisterPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 5.0,
        windowMs: 0,
        breachAction: 'kill',
        killCallbackUrl: 'ftp://198.51.100.7/kill',
      })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toMatch(/http: or https:/)
      expect(listPolicies()).toHaveLength(0)
    })

    it('refuses to fire the callback for an invalid URL and never fetches', async () => {
      const fetchMock = vi.fn()
      global.fetch = fetchMock as typeof global.fetch

      const result = await invokeKillCallback(
        {
          agentId: 'agent-001',
          maxSpendUsd: 1.0,
          windowMs: 0,
          breachAction: 'kill',
          killCallbackUrl: 'http://user:pw@169.254.169.254/latest/meta-data',
        },
        killDecision
      )

      expect(fetchMock).not.toHaveBeenCalled()
      expect(result).toEqual({
        attempted: false,
        ok: false,
        error: expect.stringMatching(/credentials/),
      })
    })
  })

  describe('kill callback timeout and failure isolation', () => {
    it('sends the kill callback with an abort timeout signal', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
      global.fetch = fetchMock as typeof global.fetch

      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 1.0,
        windowMs: 0,
        breachAction: 'kill',
        killCallbackUrl: 'https://example.com/kill',
      })

      await handleOTelEvaluateSpend({
        agentId: 'agent-001',
        costUsd: 1.5,
        spanId: 'span-1',
      })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('reports a failed kill callback without failing budget evaluation', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValue(new Error('The operation was aborted due to timeout'))
      global.fetch = fetchMock as typeof global.fetch

      registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 1.0,
        windowMs: 0,
        breachAction: 'kill',
        killCallbackUrl: 'https://example.com/kill',
      })

      const result = await handleOTelEvaluateSpend({
        agentId: 'agent-001',
        costUsd: 1.5,
        spanId: 'span-1',
      })

      expect(result.isError).toBeUndefined()
      const data = JSON.parse(result.content[0].text)
      expect(data.decision.action).toBe('kill')
      expect(data.killCallback).toEqual({
        attempted: true,
        ok: false,
        error: expect.stringContaining('timeout'),
      })
    })
  })
})
