/**
 * Tests for OTel Budget Circuit-Breaker module
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  registerPolicy,
  evaluateSpan,
  decisionToOTelEvent,
  getDecisionHistory,
  handleOTelEvaluateSpend,
  handleOTelRegisterPolicy,
  invokeKillCallback,
  listPolicies,
  OTelRegisterPolicySchema,
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
