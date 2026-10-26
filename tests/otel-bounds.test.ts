/**
 * F9 — the kill callback connects only to the address set it validated.
 * F10 — OTel state is bounded and replayed spans are counted once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  OTEL_LIMITS,
  _otelStateSizes,
  _resetOTelBudgetState,
  evaluateSpan,
  getDecisionHistory,
  handleOTelRegisterPolicy,
  invokeKillCallback,
  registerPolicy,
  type BudgetDecision,
} from '../src/tools/otel-budget.js'
import { _setSafeTransportTestOverrides } from '../src/utils/safe-fetch.js'
import { installDefaultTransportOverrides } from './setup/test-env.js'

const KILL: BudgetDecision = {
  agentId: 'a',
  action: 'kill',
  accumulatedSpendUsd: 2,
  budgetLimitUsd: 1,
  remainingUsd: 0,
  utilizationPct: 200,
  reason: 'over',
  timestamp: 0,
}

beforeEach(() => {
  _resetOTelBudgetState()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  installDefaultTransportOverrides()
})

describe('kill callback pinning (F9)', () => {
  it('resolves once and hands the connector only the validated addresses', async () => {
    const resolver = vi
      .fn()
      .mockResolvedValueOnce([{ address: '93.184.215.14', family: 4 }])
      .mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
    const connector = vi.fn(async () => new Response(null, { status: 204 }))
    _setSafeTransportTestOverrides({ resolver, connector })

    const result = await invokeKillCallback(
      { agentId: 'a', maxSpendUsd: 1, windowMs: 0, breachAction: 'kill', killCallbackUrl: 'https://hooks.example.com/kill' },
      KILL
    )
    expect(result).toEqual({ attempted: true, ok: true })
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(connector).toHaveBeenCalledTimes(1)
    const pinned = (connector.mock.calls[0] as unknown[])[2]
    expect(pinned).toEqual([{ address: '93.184.215.14', family: 4 }])
  })

  it('never connects when any answer is private (mixed answer rebinding set-up)', async () => {
    const connector = vi.fn()
    _setSafeTransportTestOverrides({
      resolver: async () => [
        { address: '93.184.215.14', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      connector,
    })
    const result = await invokeKillCallback(
      { agentId: 'a', maxSpendUsd: 1, windowMs: 0, breachAction: 'kill', killCallbackUrl: 'https://hooks.example.com/kill' },
      KILL
    )
    expect(result).toMatchObject({ attempted: false, ok: false })
    expect(connector).not.toHaveBeenCalled()
  })
})

describe('bounded OTel state (F10)', () => {
  it('rejects oversized identifiers and caps the number of policies', () => {
    expect(() =>
      registerPolicy({ agentId: 'x'.repeat(129), maxSpendUsd: 1, windowMs: 0, breachAction: 'block' })
    ).toThrow(/agentId/)
    for (let i = 0; i < OTEL_LIMITS.maxPolicies; i++) {
      registerPolicy({ agentId: `agent-${i}`, maxSpendUsd: 1, windowMs: 0, breachAction: 'block' })
    }
    expect(() =>
      registerPolicy({ agentId: 'one-more', maxSpendUsd: 1, windowMs: 0, breachAction: 'block' })
    ).toThrow(/At most/)
    // Updating an existing key is still allowed at capacity.
    expect(() =>
      registerPolicy({ agentId: 'agent-0', maxSpendUsd: 2, windowMs: 0, breachAction: 'block' })
    ).not.toThrow()
  })

  it('counts a replayed (trace, span) once', () => {
    registerPolicy({ agentId: 'r', maxSpendUsd: 10, windowMs: 0, breachAction: 'block' })
    const span = { 'agentcore.agent.id': 'r', 'agentcore.cost.usd': 4, traceId: 't1', spanId: 's1' }
    evaluateSpan(span)
    const replay = evaluateSpan(span)
    const replay2 = evaluateSpan(span)
    expect(replay!.accumulatedSpendUsd).toBe(4)
    expect(replay2!.action).toBe('allow')
    expect(_otelStateSizes().records).toBe(1)
  })

  it('compacts per-task history without under-counting windowed spend', () => {
    registerPolicy({ agentId: 'busy', maxSpendUsd: 1e9, windowMs: 60_000, breachAction: 'block' })
    const n = OTEL_LIMITS.maxRecordsPerTask * 3
    let last: BudgetDecision | null = null
    for (let i = 0; i < n; i++) {
      last = evaluateSpan({ 'agentcore.agent.id': 'busy', 'agentcore.cost.usd': 1 })
    }
    expect(_otelStateSizes().records).toBeLessThanOrEqual(OTEL_LIMITS.maxRecordsPerTask)
    expect(last!.accumulatedSpendUsd).toBe(n)
  })

  it('fails closed (block) for new agents beyond the tracked-agent limit', () => {
    for (let i = 0; i < OTEL_LIMITS.maxAgents; i++) {
      evaluateSpan({ 'agentcore.agent.id': `a${i}`, 'agentcore.cost.usd': 0.01 })
    }
    const refused = evaluateSpan({ 'agentcore.agent.id': 'newcomer', 'agentcore.cost.usd': 0.01 })
    expect(refused!.action).toBe('block')
    expect(_otelStateSizes().agents).toBe(OTEL_LIMITS.maxAgents)
  })

  it('caps decision history and the history limit', () => {
    registerPolicy({ agentId: 'h', maxSpendUsd: 1e9, windowMs: 0, breachAction: 'block' })
    for (let i = 0; i < OTEL_LIMITS.maxDecisions + 50; i++) {
      evaluateSpan({ 'agentcore.agent.id': 'h', 'agentcore.cost.usd': 1 })
    }
    expect(_otelStateSizes().decisions).toBe(OTEL_LIMITS.maxDecisions)
    expect(getDecisionHistory('h', 1_000_000)).toHaveLength(OTEL_LIMITS.maxHistoryLimit)
  })

  it('rejects an over-long window at registration', async () => {
    const result = await handleOTelRegisterPolicy({
      agentId: 'w',
      maxSpendUsd: 1,
      windowMs: OTEL_LIMITS.maxWindowMs + 1,
      breachAction: 'block',
    })
    expect(result.isError).toBe(true)
  })
})
