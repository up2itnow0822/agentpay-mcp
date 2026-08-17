/**
 * Tests for OTel Budget Circuit-Breaker module
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * invokeKillCallback resolves the callback host before fetching, so every test
 * that fires a callback would otherwise depend on live DNS. Default the
 * resolver to an ordinary public address; the SSRF tests below override it.
 */
const dnsLookup = vi.hoisted(() =>
  vi.fn(async () => [{ address: '203.0.113.10', family: 4 }])
)
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup }))

import {
  registerPolicy,
  evaluateSpan,
  decisionToOTelEvent,
  getDecisionHistory,
  handleOTelEvaluateSpend,
  handleOTelRegisterPolicy,
  invokeKillCallback,
  listPolicies,
  resolvedHostIsPrivate,
  validateKillCallbackUrl,
  KILL_CALLBACK_TIMEOUT_MS,
  OTelRegisterPolicySchema,
  _resetOTelBudgetState,
} from '../src/tools/otel-budget.js'

const originalFetch = global.fetch

describe('OTel Budget Circuit-Breaker', () => {
  beforeEach(() => {
    _resetOTelBudgetState()
    vi.restoreAllMocks()
    dnsLookup.mockResolvedValue([{ address: '203.0.113.10', family: 4 }])
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
      })
    })
  })

  // ── Kill-callback SSRF hardening ─────────────────────────────────────────

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

  const killPolicy = (killCallbackUrl: string) => ({
    agentId: 'agent-001',
    maxSpendUsd: 1.0,
    windowMs: 0,
    breachAction: 'kill' as const,
    killCallbackUrl,
  })

  describe('kill callback URL validation', () => {
    it('rejects non-http(s) schemes at registration time', () => {
      expect(() => registerPolicy(killPolicy('ftp://198.51.100.7/kill'))).toThrow(
        /http: or https:/
      )
      expect(listPolicies()).toHaveLength(0)
    })

    it('rejects embedded credentials at registration time', () => {
      expect(() =>
        registerPolicy(killPolicy('https://user:secret@hooks.example.com/kill'))
      ).toThrow(/credentials/)
      expect(listPolicies()).toHaveLength(0)
    })

    it('rejects unparseable URLs at registration time', () => {
      expect(() => registerPolicy(killPolicy('not a url'))).toThrow(/not a valid URL/)
      expect(listPolicies()).toHaveLength(0)
    })

    it('leaves an existing policy intact when a re-registration is rejected', () => {
      registerPolicy(killPolicy('https://hooks.example.com/kill'))
      expect(() => registerPolicy(killPolicy('http://169.254.169.254/kill'))).toThrow()

      // Rejecting the bad URL must not have removed the live spend cap: that
      // would turn a hardening check into a fail-open budget bypass.
      expect(listPolicies()).toHaveLength(1)
      expect(listPolicies()[0].killCallbackUrl).toBe('https://hooks.example.com/kill')

      const decision = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 1.5,
        spanId: 'span-1',
      })
      expect(decision?.action).toBe('kill')
      expect(decision?.accumulatedSpendUsd).toBe(1.5)
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
        killPolicy('http://user:pw@169.254.169.254/latest/meta-data'),
        killDecision
      )

      expect(fetchMock).not.toHaveBeenCalled()
      expect(result).toEqual({
        attempted: false,
        ok: false,
        error: expect.stringMatching(/credentials/),
      })
    })

    it.each([
      ['http://169.254.169.254/latest/meta-data/', 'AWS/Azure metadata link-local'],
      ['http://metadata.google.internal/computeMetadata/v1/', 'GCP metadata name'],
      ['http://127.0.0.1:8080/admin', 'loopback dotted-quad'],
      ['http://localhost/internal', 'loopback name'],
      ['http://localhost./internal', 'loopback name with trailing dot'],
      ['http://127.0.0.1./kill', 'loopback literal with trailing dot'],
      ['http://2130706433/kill', 'decimal IPv4 for 127.0.0.1'],
      ['http://0177.0.0.1/kill', 'octal IPv4 for 127.0.0.1'],
      ['http://0x7f.0x0.0x0.0x1/kill', 'hex IPv4 for 127.0.0.1'],
      ['http://0xa9fea9fe/kill', 'hex IPv4 for the metadata service'],
      ['http://127.1/kill', 'short-form IPv4 for 127.0.0.1'],
      ['http://0.0.0.0/kill', 'this-network wildcard'],
      ['http://10.0.0.5/kill', 'RFC1918 10/8'],
      ['http://172.16.4.4/kill', 'RFC1918 172.16/12'],
      ['http://192.168.1.10/kill', 'RFC1918 192.168/16'],
      ['http://100.64.0.1/kill', 'CGNAT 100.64/10'],
      ['http://239.255.255.250/kill', 'multicast'],
      ['http://[::]/kill', 'IPv6 unspecified'],
      ['http://[::1]/kill', 'IPv6 loopback'],
      ['http://[0:0:0:0:0:0:0:1]/kill', 'uncompressed IPv6 loopback'],
      ['http://[fd00::1]/kill', 'IPv6 unique-local fc00::/7'],
      ['http://[fe80::1]/kill', 'IPv6 link-local fe80::/10'],
      ['http://[::ffff:127.0.0.1]/kill', 'IPv4-mapped loopback'],
      ['http://[::ffff:169.254.169.254]/kill', 'IPv4-mapped metadata service'],
      ['http://[::ffff:a9fe:a9fe]/kill', 'IPv4-mapped metadata service, hextet form'],
      ['http://[::a9fe:a9fe]/kill', 'IPv4-compatible metadata service'],
      ['http://[64:ff9b::7f00:1]/kill', 'NAT64-tunnelled loopback'],
      ['http://[64:ff9b::a9fe:a9fe]/kill', 'NAT64-tunnelled metadata service'],
      // Public IPv4 payload, so only the 64:ff9b:1::/48 prefix rule refuses it.
      ['http://[64:ff9b:1::cb00:7107]/kill', 'NAT64 local-use prefix'],
      ['http://[2002:7f00:1::]/kill', '6to4-tunnelled loopback'],
      ['http://[2002:a9fe:a9fe::]/kill', '6to4-tunnelled metadata service'],
      // Teredo stores the client IPv4 bit-inverted: ~169.254.169.254 = 5601:5601.
      ['http://[2001:0:0:0:0:0:5601:5601]/kill', 'Teredo carrying the metadata service'],
      ['https://console.svc.internal/kill', '.internal suffix'],
      ['https://printer.local/kill', '.local suffix'],
      ['https://svc.home.arpa/kill', '.home.arpa suffix'],
      ['https://app.localhost/kill', '.localhost suffix'],
      ['https://CONSOLE.SVC.INTERNAL./kill', 'uppercase suffix with trailing dot'],
    ])('refuses the internal destination %s (%s)', (url) => {
      expect(validateKillCallbackUrl(url)).toContain('not externally routable')

      expect(() => registerPolicy(killPolicy(url))).toThrow(/not externally routable/)
      expect(listPolicies()).toHaveLength(0)

      const parsed = OTelRegisterPolicySchema.safeParse({
        agentId: 'agent-001',
        maxSpendUsd: 5.0,
        breachAction: 'kill',
        killCallbackUrl: url,
      })
      expect(parsed.success).toBe(false)
    })

    it.each([
      'https://hooks.example.com/agent/kill',
      'http://hooks.example.com./agent/kill',
      'https://198.51.100.7/kill',
      'https://203.0.113.10:8443/kill',
      'http://[2606:4700:4700::1111]/kill',
      'http://[64:ff9b::cb00:7107]/kill',
      'http://[2002:cb00:7107::]/kill',
    ])('still accepts the public destination %s', (url) => {
      expect(validateKillCallbackUrl(url)).toBeNull()
      registerPolicy(killPolicy(url))
      expect(listPolicies()).toHaveLength(1)
    })

    it('does not follow redirects, so a public URL cannot bounce into a private host', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 302 })
      global.fetch = fetchMock as typeof global.fetch

      const result = await invokeKillCallback(
        killPolicy('https://hooks.example.com/agent/kill'),
        killDecision
      )

      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(init.redirect).toBe('manual')
      expect(result).toMatchObject({ attempted: true, ok: false })
      expect(result).not.toHaveProperty('status')
    })
  })

  describe('kill callback DNS resolution gate', () => {
    it('refuses a DNS name that resolves into private space', async () => {
      const fetchMock = vi.fn()
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])

      const result = await invokeKillCallback(
        killPolicy('https://rebind.example.com/kill'),
        killDecision
      )

      // The literal checks cannot see through a name, so without the fire-time
      // resolution this was a working SSRF probe from a payment server.
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({ attempted: false, ok: false })
      expect(result?.error).toContain('private')
    })

    it('refuses a name where only one of several addresses is private', async () => {
      const fetchMock = vi.fn()
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockResolvedValue([
        { address: '198.51.100.7', family: 4 },
        { address: '10.1.2.3', family: 4 },
      ])

      const result = await invokeKillCallback(
        killPolicy('https://split.example.com/kill'),
        killDecision
      )

      expect(fetchMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({ attempted: false, ok: false })
    })

    // Resolver answers are raw text, not URL-canonicalised literals, so these
    // forms only ever reach isPrivateIpv6 through this path.
    it.each([
      ['fd12:3456::1', 'unique-local'],
      ['::1', 'loopback'],
      // A dotted-quad tail survives here; new URL() would have compressed it.
      ['::ffff:169.254.169.254', 'IPv4-mapped metadata service, dotted-quad tail'],
      ['64:ff9b:1::cb00:7107', 'NAT64 local-use prefix'],
      ['not-an-address', 'unparseable — must fail closed, not be treated as public'],
    ])('refuses a name that resolves to %s (%s)', async (address) => {
      const fetchMock = vi.fn()
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockResolvedValue([{ address, family: 6 }])

      const result = await invokeKillCallback(
        killPolicy('https://v6.example.com/kill'),
        killDecision
      )

      expect(fetchMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({ attempted: false, ok: false })
    })

    // The dotted-quad tail must be understood, not merely refused as garbage:
    // a resolver that answers in that form for a public host still has to work.
    it.each([
      ['2606:4700:4700::1111', 'public IPv6'],
      ['::ffff:203.0.113.10', 'public IPv4-mapped, dotted-quad tail'],
    ])('accepts a name that resolves to %s (%s)', async (address) => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockResolvedValue([{ address, family: 6 }])

      const result = await invokeKillCallback(
        killPolicy('https://v6-public.example.com/kill'),
        killDecision
      )

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ attempted: true, ok: true })
    })

    it('fails closed when the callback host cannot be resolved', async () => {
      const fetchMock = vi.fn()
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockRejectedValue(new Error('ENOTFOUND'))

      const result = await invokeKillCallback(
        killPolicy('https://nx.example.com/kill'),
        killDecision
      )

      expect(fetchMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({ attempted: false, ok: false })
      expect(result?.error).toContain('could not be resolved')
    })

    it('fails closed when the callback host resolves to no addresses', async () => {
      const fetchMock = vi.fn()
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockResolvedValue([])

      const result = await invokeKillCallback(
        killPolicy('https://empty.example.com/kill'),
        killDecision
      )

      expect(fetchMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({ attempted: false, ok: false })
      expect(result?.error).toContain('no addresses')
    })

    it('fetches a name that resolves entirely into public space', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockResolvedValue([{ address: '198.51.100.7', family: 4 }])

      const result = await invokeKillCallback(
        killPolicy('https://hooks.example.com/kill'),
        killDecision
      )

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ attempted: true, ok: true })
    })

    it('does not resolve IP literals — the literal check already covered them', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockClear()

      expect(await resolvedHostIsPrivate('https://198.51.100.7/kill')).toBeNull()
      expect(await resolvedHostIsPrivate('http://[2606:4700:4700::1111]/kill')).toBeNull()
      expect(dnsLookup).not.toHaveBeenCalled()
    })
  })

  describe('kill callback timeout and failure isolation', () => {
    it('sends the kill callback with an abort timeout signal', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
      global.fetch = fetchMock as typeof global.fetch

      registerPolicy(killPolicy('https://hooks.example.com/kill'))

      await handleOTelEvaluateSpend({
        agentId: 'agent-001',
        costUsd: 1.5,
        spanId: 'span-1',
      })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it('aborts a kill callback that never responds once the timeout elapses', async () => {
      // Same wiring as production, with the deadline compressed so the test
      // does not have to wait KILL_CALLBACK_TIMEOUT_MS for a real hang.
      const realTimeout = AbortSignal.timeout.bind(AbortSignal)
      let requestedTimeoutMs: number | undefined
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        requestedTimeoutMs = ms
        return realTimeout(5)
      })

      let abortReason: unknown
      const fetchMock = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init.signal as AbortSignal
            signal.addEventListener('abort', () => {
              abortReason = signal.reason
              reject(signal.reason)
            })
          })
      )
      global.fetch = fetchMock as unknown as typeof global.fetch

      const result = await invokeKillCallback(
        killPolicy('https://hooks.example.com/kill'),
        killDecision
      )

      // A signal that never fires would leave this fetch — and the caller —
      // hanging forever, which is the failure the timeout exists to prevent.
      expect(requestedTimeoutMs).toBe(KILL_CALLBACK_TIMEOUT_MS)
      expect((abortReason as Error).name).toBe('TimeoutError')
      expect(result).toMatchObject({ attempted: true, ok: false })
      expect(result!.error).toBeTruthy()
    })

    it('reports a failed kill callback without failing budget evaluation', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValue(new Error('The operation was aborted due to timeout'))
      global.fetch = fetchMock as typeof global.fetch

      registerPolicy(killPolicy('https://hooks.example.com/kill'))

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

    it('keeps the breaker decision intact when the callback is refused outright', async () => {
      const fetchMock = vi.fn()
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockRejectedValue(new Error('ENOTFOUND'))

      registerPolicy(killPolicy('https://nx.example.com/kill'))

      const result = await handleOTelEvaluateSpend({
        agentId: 'agent-001',
        costUsd: 1.5,
        spanId: 'span-1',
      })

      expect(result.isError).toBeUndefined()
      const data = JSON.parse(result.content[0].text)
      expect(data.decision.action).toBe('kill')
      expect(data.decision.accumulatedSpendUsd).toBe(1.5)
      expect(data.otelEvent['agentpay.circuit_breaker_tripped']).toBe(true)
      expect(data.killCallback).toMatchObject({ attempted: false, ok: false })
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('never hands the caller a per-host status code', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof global.fetch

      registerPolicy(killPolicy('https://hooks.example.com/kill'))
      const result = await handleOTelEvaluateSpend({
        agentId: 'agent-001',
        costUsd: 5,
        spanId: 'span-oracle',
      })

      const data = JSON.parse(result.content[0].text)
      expect(data.killCallback.ok).toBe(false)
      expect(data.killCallback).not.toHaveProperty('status')
      expect(JSON.stringify(data)).not.toContain('403')
    })
  })
})
