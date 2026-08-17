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
  vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
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
  KILL_CALLBACK_ALLOWLIST_ENV,
  KILL_CALLBACK_GENERIC_FAILURE,
  OTelRegisterPolicySchema,
  _resetOTelBudgetState,
} from '../src/tools/otel-budget.js'

const originalFetch = global.fetch

describe('OTel Budget Circuit-Breaker', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    _resetOTelBudgetState()
    vi.restoreAllMocks()
    dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
    delete process.env[KILL_CALLBACK_ALLOWLIST_ENV]
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    global.fetch = originalFetch
    delete process.env[KILL_CALLBACK_ALLOWLIST_ENV]
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
    it.each([
      ['ftp://93.184.216.7/kill', /http: or https:/],
      ['https://user:secret@hooks.example.com/kill', /credentials/],
      ['not a url', /not a valid URL/],
    ])('drops the refused callback URL %s but keeps the cap', (url, reason) => {
      const result = registerPolicy(killPolicy(url))

      // The URL is refused — but the spend cap the caller asked for must
      // survive. Refusing the whole policy would leave the agent uncapped,
      // which is a worse outcome than the SSRF being refused.
      expect(result.killCallbackWarning).toMatch(reason)
      expect(listPolicies()).toHaveLength(1)
      expect(listPolicies()[0].maxSpendUsd).toBe(1.0)
      expect(listPolicies()[0].killCallbackUrl).toBeUndefined()
    })

    it('still fires kill at the configured limit when the callback was refused', async () => {
      const fetchMock = vi.fn()
      global.fetch = fetchMock as typeof global.fetch

      // The exact case that was silently uncapped: a first-time registration
      // whose kill webhook points into private space.
      const result = registerPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 1.0,
        windowMs: 0,
        breachAction: 'kill',
        killCallbackUrl: 'http://10.0.0.5:8080/kill',
      })
      expect(result.killCallbackWarning).toMatch(/not externally routable/)

      const decision = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 500,
        spanId: 'span-1',
      })

      expect(decision?.action).toBe('kill')
      expect(decision?.budgetLimitUsd).toBe(1.0)
      expect(decision?.accumulatedSpendUsd).toBe(500)
      expect(decision?.reason).toMatch(/Budget exceeded/)

      // ...and the refused destination is still never contacted.
      const policy = listPolicies()[0]
      expect(await invokeKillCallback(policy, decision!)).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('keeps the cap in force when a re-registration carries a bad callback URL', () => {
      registerPolicy(killPolicy('https://hooks.example.com/kill'))
      const result = registerPolicy(killPolicy('http://169.254.169.254/kill'))

      expect(result.killCallbackWarning).toBeTruthy()
      expect(listPolicies()).toHaveLength(1)
      expect(listPolicies()[0].maxSpendUsd).toBe(1.0)
      expect(listPolicies()[0].killCallbackUrl).toBeUndefined()

      const decision = evaluateSpan({
        'agentcore.agent.id': 'agent-001',
        'agentcore.cost.usd': 1.5,
        spanId: 'span-1',
      })
      expect(decision?.action).toBe('kill')
      expect(decision?.accumulatedSpendUsd).toBe(1.5)
    })

    it('accepts an invalid killCallbackUrl in the tool input schema', () => {
      // Schema-level rejection would fail the whole call and leave the agent
      // with no cap at all; the URL is dropped downstream instead.
      const parsed = OTelRegisterPolicySchema.safeParse({
        agentId: 'agent-001',
        maxSpendUsd: 5.0,
        breachAction: 'kill',
        killCallbackUrl: 'file:///etc/passwd',
      })
      expect(parsed.success).toBe(true)
    })

    it('registers the cap and warns instead of erroring on a bad callback URL', async () => {
      const result = await handleOTelRegisterPolicy({
        agentId: 'agent-001',
        maxSpendUsd: 5.0,
        windowMs: 0,
        breachAction: 'kill',
        killCallbackUrl: 'ftp://93.184.216.7/kill',
      })

      expect(result.isError).toBeUndefined()
      const data = JSON.parse(result.content[0].text)
      expect(data.success).toBe(true)
      expect(data.killCallbackWarning).toMatch(/http: or https:/)
      // The rejected URL must not be echoed back as though it were in force.
      expect(data.policy.killCallbackUrl).toBeUndefined()

      expect(listPolicies()).toHaveLength(1)
      expect(listPolicies()[0].maxSpendUsd).toBe(5.0)
      expect(listPolicies()[0].killCallbackUrl).toBeUndefined()
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
      // A run of trailing dots survives the WHATWG parser verbatim. Stripping
      // only one left a name that matched neither the exact-host set, nor the
      // suffix list, nor the allowlist — i.e. the whole name layer was bypassed.
      ['http://metadata.google.internal../kill', 'GCP metadata name, two trailing dots'],
      ['http://localhost.../internal', 'loopback name, three trailing dots'],
      ['http://127.0.0.1../kill', 'loopback literal with two trailing dots'],
      ['https://console.svc.internal../kill', '.internal suffix with two trailing dots'],
      ['https://a..b.example.com/kill', 'interior empty label'],
      ['https://.example.com/kill', 'leading empty label'],
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
      // The remaining IANA "Globally Reachable: False" IPv4 entries. The IPv6
      // side already refused its documentation and benchmarking equivalents
      // (2001:db8::/32, 3fff::/20, 2001:2::/48), so these were an asymmetry.
      ['http://192.0.0.1/kill', 'IETF protocol assignments 192.0.0.0/24'],
      ['http://192.0.0.170/kill', 'NAT64 discovery inside 192.0.0.0/24'],
      ['http://192.0.2.5/kill', 'documentation TEST-NET-1 192.0.2.0/24'],
      ['http://198.18.0.1/kill', 'benchmarking 198.18.0.0/15, lower half'],
      ['http://198.19.255.254/kill', 'benchmarking 198.18.0.0/15, upper half'],
      ['http://198.51.100.7/kill', 'documentation TEST-NET-2 198.51.100.0/24'],
      ['http://203.0.113.10/kill', 'documentation TEST-NET-3 203.0.113.0/24'],
      // Already covered by the `a >= 224` rule; pinned so a later narrowing of
      // that rule cannot silently reopen them.
      ['http://240.0.0.1/kill', 'reserved 240.0.0.0/4'],
      ['http://255.255.255.255/kill', 'limited broadcast'],
      // Tunnelled forms of the same ranges must not slip past either.
      ['http://[::ffff:203.0.113.10]/kill', 'IPv4-mapped TEST-NET-3'],
      ['http://[64:ff9b::c000:205]/kill', 'NAT64-tunnelled 192.0.2.5'],
      ['http://[2002:c612:1::]/kill', '6to4-tunnelled 198.18.0.1'],
      ['http://[::]/kill', 'IPv6 unspecified'],
      ['http://[::1]/kill', 'IPv6 loopback'],
      ['http://[0:0:0:0:0:0:0:1]/kill', 'uncompressed IPv6 loopback'],
      ['http://[fd00::1]/kill', 'IPv6 unique-local fc00::/7'],
      ['http://[fe80::1]/kill', 'IPv6 link-local fe80::/10'],
      // A bracketed literal gets no DNS backstop — resolvedHostIsPrivate returns
      // early for one — so validateKillCallbackUrl is the only gate for these.
      ['http://[ff02::1]/kill', 'IPv6 all-nodes multicast on the local link'],
      ['http://[ff02::2]/kill', 'IPv6 all-routers multicast'],
      ['http://[ff05::1:3]/kill', 'IPv6 site-local multicast DHCP servers'],
      ['http://[fec0::1]/kill', 'IPv6 deprecated site-local fec0::/10'],
      ['http://[100::1]/kill', 'IPv6 discard-only 100::/64'],
      ['http://[2001:db8::1]/kill', 'IPv6 documentation 2001:db8::/32'],
      ['http://[3fff:0:0:0:0:0:0:1]/kill', 'IPv6 documentation 3fff::/20'],
      ['http://[2001:2::1]/kill', 'IPv6 benchmarking 2001:2::/48'],
      ['http://[2001:20::1]/kill', 'IPv6 ORCHIDv2 2001:20::/28'],
      ['http://[2001:2f::1]/kill', 'IPv6 ORCHIDv2 upper edge 2001:2f::'],
      ['http://[5f00::1]/kill', 'IPv6 SRv6 SIDs 5f00::/16'],
      ['http://[::ffff:127.0.0.1]/kill', 'IPv4-mapped loopback'],
      ['http://[::ffff:169.254.169.254]/kill', 'IPv4-mapped metadata service'],
      ['http://[::ffff:a9fe:a9fe]/kill', 'IPv4-mapped metadata service, hextet form'],
      ['http://[::a9fe:a9fe]/kill', 'IPv4-compatible metadata service'],
      ['http://[64:ff9b::7f00:1]/kill', 'NAT64-tunnelled loopback'],
      ['http://[64:ff9b::a9fe:a9fe]/kill', 'NAT64-tunnelled metadata service'],
      // Public IPv4 payload, so only the 64:ff9b:1::/48 prefix rule refuses it.
      ['http://[64:ff9b:1::5db8:d807]/kill', 'NAT64 local-use prefix'],
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

      // The destination is refused; the policy's spend cap is not.
      const result = registerPolicy(killPolicy(url))
      expect(result.killCallbackWarning).toMatch(/not externally routable/)
      expect(listPolicies()).toHaveLength(1)
      expect(listPolicies()[0].maxSpendUsd).toBe(1.0)
      expect(listPolicies()[0].killCallbackUrl).toBeUndefined()
    })

    it.each([
      'https://hooks.example.com/agent/kill',
      'http://hooks.example.com./agent/kill',
      'https://93.184.216.7/kill',
      'https://93.184.216.34:8443/kill',
      // Neighbours of the newly-refused IPv4 ranges that are ordinary global
      // unicast. The new rules are /15 and /24 wide and must not creep: 192.0.1
      // and 192.0.3 bracket 192.0.0/24 and 192.0.2/24, 198.17 and 198.20
      // bracket 198.18/15, and 198.51.101 / 203.0.114 sit next to the two
      // remaining documentation blocks.
      'https://192.0.1.1/kill',
      'https://192.0.3.1/kill',
      'https://198.17.255.254/kill',
      'https://198.20.0.1/kill',
      'https://198.51.101.7/kill',
      'https://203.0.114.10/kill',
      // IANA marks AS112 and AMT globally reachable, so they stay accepted
      // even though they are special-purpose registrations.
      'https://192.31.196.1/kill',
      'https://192.52.193.1/kill',
      'https://192.175.48.1/kill',
      'http://[2606:4700:4700::1111]/kill',
      'http://[64:ff9b::5db8:d807]/kill',
      'http://[2002:5db8:d807::]/kill',
      // Neighbours of the newly-refused ranges that are ordinary global unicast
      // and must stay reachable: 2001:4860 is not 2001:db8/2001:2/2001:20 and
      // must not be swept up by the protocol-assignment rules, 3ffe is outside
      // 3fff::/20, and 5f01 is outside 5f00::/16.
      'http://[2001:4860:4860::8888]/kill',
      'http://[2001:db9::1]/kill',
      'http://[2001:30::1]/kill',
      'http://[3ffe::1]/kill',
      'http://[5f01::1]/kill',
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
      // The caller is not told *why*: see the indistinguishability test below.
      expect(result?.error).toBe(KILL_CALLBACK_GENERIC_FAILURE)
    })

    it('refuses a name where only one of several addresses is private', async () => {
      const fetchMock = vi.fn()
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockResolvedValue([
        { address: '93.184.216.7', family: 4 },
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
      ['64:ff9b:1::5db8:d807', 'NAT64 local-use prefix'],
      ['ff02::1', 'all-nodes multicast'],
      ['fec0::1', 'deprecated site-local'],
      // The DNS gate shares isPrivateIpv4 with the literal check, so the
      // special-purpose IPv4 ranges have to be refused here too — a name is
      // the easy way to reach one of them.
      ['198.18.0.1', 'benchmarking 198.18.0.0/15'],
      ['192.0.2.5', 'documentation TEST-NET-1'],
      ['198.51.100.7', 'documentation TEST-NET-2'],
      ['203.0.113.10', 'documentation TEST-NET-3'],
      ['192.0.0.170', 'IETF protocol assignments 192.0.0.0/24'],
      ['2001:db8::1', 'documentation'],
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
      ['::ffff:93.184.216.34', 'public IPv4-mapped, dotted-quad tail'],
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
      expect(result?.error).toBe(KILL_CALLBACK_GENERIC_FAILURE)
      // The detail an operator needs goes to the server log, not the caller.
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('could not be resolved')
      )
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
      expect(result?.error).toBe(KILL_CALLBACK_GENERIC_FAILURE)
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('no addresses')
      )
    })

    it('fetches a name that resolves entirely into public space', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockResolvedValue([{ address: '93.184.216.7', family: 4 }])

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

      expect(await resolvedHostIsPrivate('https://93.184.216.7/kill')).toBeNull()
      expect(await resolvedHostIsPrivate('http://[2606:4700:4700::1111]/kill')).toBeNull()
      expect(dnsLookup).not.toHaveBeenCalled()
    })
  })

  describe('kill callback failure logging', () => {
    // The webhook path and query are routinely the credential — a signed
    // delivery path, a ?token= capability. Server logs are shipped, indexed and
    // read by more people than the webhook's owner, so writing the full URL
    // there discloses it. Only the origin is needed to identify the webhook.
    const secretUrl =
      'https://hooks.example.com:8443/agent/kill/s3cr3t-delivery-token?sig=abc123&tenant=acme'

    const logsFor = async (arrange: () => void): Promise<string> => {
      arrange()
      await invokeKillCallback(killPolicy(secretUrl), killDecision)
      const logged = consoleError.mock.calls.map((call) => String(call[0])).join('\n')
      expect(logged).not.toBe('')
      return logged
    }

    it.each([
      [
        'a transport failure',
        () => {
          global.fetch = vi
            .fn()
            .mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof global.fetch
        },
      ],
      [
        'an HTTP error status',
        () => {
          global.fetch = vi
            .fn()
            .mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof global.fetch
        },
      ],
      [
        'a DNS-gate refusal',
        () => {
          global.fetch = vi.fn() as unknown as typeof global.fetch
          dnsLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
        },
      ],
    ])('redacts the callback path and query when logging %s', async (_case, arrange) => {
      const logged = await logsFor(arrange)

      expect(logged).not.toContain('s3cr3t-delivery-token')
      expect(logged).not.toContain('sig=abc123')
      expect(logged).not.toContain('tenant=acme')
      // The operator still gets enough to tell which webhook failed.
      expect(logged).toContain('https://hooks.example.com:8443')
    })
  })

  describe('kill callback deadline', () => {
    it('applies the callback deadline to DNS resolution, not just the fetch', async () => {
      // The lookup used to be awaited with no deadline of its own — the abort
      // signal was created afterwards, for the fetch only — so a resolver that
      // accepted the query and never answered held span evaluation open
      // indefinitely, well past KILL_CALLBACK_TIMEOUT_MS.
      const realTimeout = AbortSignal.timeout.bind(AbortSignal)
      let requestedTimeoutMs: number | undefined
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        requestedTimeoutMs = ms
        return realTimeout(5)
      })

      const fetchMock = vi.fn()
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockImplementation(() => new Promise(() => {}))

      const result = await invokeKillCallback(
        killPolicy('https://blackhole-resolver.example.com/kill'),
        killDecision
      )

      expect(requestedTimeoutMs).toBe(KILL_CALLBACK_TIMEOUT_MS)
      // Refused before the wire, so the DNS gate's contract still holds.
      expect(fetchMock).not.toHaveBeenCalled()
      expect(result).toEqual({
        attempted: false,
        ok: false,
        error: KILL_CALLBACK_GENERIC_FAILURE,
      })
      // The caller gets the same generic string as every other DNS refusal;
      // the operator's log is where the deadline shows up.
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('kill-callback deadline')
      )
    })

    it('spends one deadline across the whole path, not one per leg', async () => {
      const realTimeout = AbortSignal.timeout.bind(AbortSignal)
      const timeoutSpy = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation(() => realTimeout(KILL_CALLBACK_TIMEOUT_MS))

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
      global.fetch = fetchMock as typeof global.fetch

      await invokeKillCallback(killPolicy('https://hooks.example.com/kill'), killDecision)

      // One signal, created once, shared by the lookup and the POST.
      expect(timeoutSpy).toHaveBeenCalledTimes(1)
      const init = fetchMock.mock.calls[0][1] as RequestInit
      expect(init.signal).toBe(timeoutSpy.mock.results[0].value)
    })

    it('does not resolve or fetch at all when the decision is not a kill', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
      const fetchMock = vi.fn()
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockClear()

      const result = await invokeKillCallback(killPolicy('https://hooks.example.com/kill'), {
        ...killDecision,
        action: 'block',
      })

      expect(result).toBeNull()
      expect(timeoutSpy).not.toHaveBeenCalled()
      expect(dnsLookup).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
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
        error: KILL_CALLBACK_GENERIC_FAILURE,
      })
      // The timeout detail reaches the operator's log, not the caller.
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('timeout'))
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

  // ── The caller must not be able to read the internal network off the
  //    failure reason. Withholding only the HTTP status left a working
  //    port/service scanner and a DNS enumerator behind; these pin the
  //    remaining channels shut.
  describe('kill callback failure indistinguishability', () => {
    const failureFor = async (arrange: () => void): Promise<string | undefined> => {
      arrange()
      const result = await invokeKillCallback(
        killPolicy('https://probe.example.com/kill'),
        killDecision
      )
      expect(result).toMatchObject({ ok: false })
      return result?.error
    }

    it('returns one identical reason for every transport and HTTP outcome', async () => {
      const reasons = [
        // Open port, speaks HTTP, refuses.
        await failureFor(() => {
          global.fetch = vi
            .fn()
            .mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof global.fetch
        }),
        // Closed port / no route.
        await failureFor(() => {
          global.fetch = vi
            .fn()
            .mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof global.fetch
        }),
        // Open TCP port that never speaks HTTP.
        await failureFor(() => {
          global.fetch = vi
            .fn()
            .mockRejectedValue(
              new Error('The operation was aborted due to timeout')
            ) as unknown as typeof global.fetch
        }),
      ]

      // All four target states (these three plus ok=true) must collapse to two
      // observations: delivered, or not. Anything finer is a service scanner.
      expect(new Set(reasons)).toEqual(new Set([KILL_CALLBACK_GENERIC_FAILURE]))
    })

    it('returns one identical reason for every DNS-gate refusal', async () => {
      const fetchMock = vi.fn()
      global.fetch = fetchMock as typeof global.fetch

      const reasons = [
        // Name exists and maps into private space.
        await failureFor(() => {
          dnsLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }])
        }),
        // Name does not exist in the server's DNS view.
        await failureFor(() => {
          dnsLookup.mockRejectedValue(new Error('ENOTFOUND'))
        }),
        // Name exists but has no address records.
        await failureFor(() => {
          dnsLookup.mockResolvedValue([])
        }),
      ]

      expect(fetchMock).not.toHaveBeenCalled()
      // Distinct strings here would let a caller enumerate internal DNS and
      // learn which names map into RFC1918 space.
      expect(new Set(reasons)).toEqual(new Set([KILL_CALLBACK_GENERIC_FAILURE]))
    })

    // The docstring on invokeKillCallback used to claim the caller sees
    // "exactly one bit — ok". It sees two: `attempted` separates a refusal that
    // never left the process from a delivery that failed on the wire. This pins
    // the contract the docstring now describes, including the deliberately
    // accepted DNS oracle: attempted=false means only "no usable public address
    // from this server", with the three DNS states collapsed into one answer.
    it('exposes attempted as a second bit, and collapses the DNS states within it', async () => {
      const dnsRefusals = [
        // Resolves into private space.
        await (async () => {
          global.fetch = vi.fn() as unknown as typeof global.fetch
          dnsLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }])
          return invokeKillCallback(killPolicy('https://a.example.com/kill'), killDecision)
        })(),
        // Does not resolve.
        await (async () => {
          global.fetch = vi.fn() as unknown as typeof global.fetch
          dnsLookup.mockRejectedValue(new Error('ENOTFOUND'))
          return invokeKillCallback(killPolicy('https://b.example.com/kill'), killDecision)
        })(),
        // Resolves to nothing.
        await (async () => {
          global.fetch = vi.fn() as unknown as typeof global.fetch
          dnsLookup.mockResolvedValue([])
          return invokeKillCallback(killPolicy('https://c.example.com/kill'), killDecision)
        })(),
      ]

      // All three DNS states are one observation, and it is attempted=false.
      for (const refusal of dnsRefusals) {
        expect(refusal).toEqual({
          attempted: false,
          ok: false,
          error: KILL_CALLBACK_GENERIC_FAILURE,
        })
      }

      // A destination that passed the gate and then failed on the wire is
      // attempted=true with the same error string — the reason does not
      // distinguish them, but `attempted` does, and that is the whole leak.
      dnsLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
      global.fetch = vi
        .fn()
        .mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof global.fetch
      expect(
        await invokeKillCallback(killPolicy('https://d.example.com/kill'), killDecision)
      ).toEqual({
        attempted: true,
        ok: false,
        error: KILL_CALLBACK_GENERIC_FAILURE,
      })
    })

    it('does not leak the host or address into the reason string', async () => {
      dnsLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }])
      const result = await invokeKillCallback(
        killPolicy('https://rebind.example.com/kill'),
        killDecision
      )
      expect(result?.error).not.toContain('169.254')
      expect(result?.error).not.toContain('rebind.example.com')
    })
  })

  describe('kill callback operator allowlist', () => {
    it('permits an opted-in private host end to end', async () => {
      process.env[KILL_CALLBACK_ALLOWLIST_ENV] = 'orchestrator.svc.internal, 10.0.0.5'

      // A kill webhook on a private orchestrator is an ordinary in-VPC
      // deployment; without an opt-in there was no way to keep it working.
      expect(validateKillCallbackUrl('http://10.0.0.5:8080/kill')).toBeNull()
      expect(
        validateKillCallbackUrl('https://orchestrator.svc.internal/kill')
      ).toBeNull()

      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 })
      global.fetch = fetchMock as typeof global.fetch
      dnsLookup.mockResolvedValue([{ address: '10.9.9.9', family: 4 }])

      const { killCallbackWarning } = registerPolicy(
        killPolicy('https://orchestrator.svc.internal/kill')
      )
      expect(killCallbackWarning).toBeUndefined()
      expect(listPolicies()[0].killCallbackUrl).toBe(
        'https://orchestrator.svc.internal/kill'
      )

      const result = await invokeKillCallback(listPolicies()[0], killDecision)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ attempted: true, ok: true })
    })

    it('waives only the private-space rule, never scheme or credentials', () => {
      process.env[KILL_CALLBACK_ALLOWLIST_ENV] = 'localhost,169.254.169.254'

      expect(validateKillCallbackUrl('ftp://localhost/kill')).toMatch(
        /http: or https:/
      )
      expect(
        validateKillCallbackUrl('http://user:pw@169.254.169.254/latest/meta-data')
      ).toMatch(/credentials/)
    })

    it('is empty by default, so private destinations stay refused', () => {
      expect(process.env[KILL_CALLBACK_ALLOWLIST_ENV]).toBeUndefined()
      expect(validateKillCallbackUrl('http://10.0.0.5:8080/kill')).toContain(
        'not externally routable'
      )
    })

    it('does not let a dot-padded spelling claim an allowlist entry', () => {
      process.env[KILL_CALLBACK_ALLOWLIST_ENV] = 'orchestrator.svc.internal,10.0.0.5'

      // The waiver is the operator's, and it applies to the host the operator
      // wrote down. A name carrying an empty label is not that host and is not
      // resolvable either, so it is refused before the allowlist is consulted —
      // rather than being normalised into the allowlisted spelling.
      expect(
        validateKillCallbackUrl('https://orchestrator.svc.internal../kill')
      ).toContain('not externally routable')
      expect(validateKillCallbackUrl('http://10.0.0.5../kill')).toContain(
        'not externally routable'
      )

      // The exact host the operator opted in still works, trailing root dot
      // included.
      expect(
        validateKillCallbackUrl('https://orchestrator.svc.internal./kill')
      ).toBeNull()
    })

    it('does not let an unrelated host ride along on an allowlist entry', () => {
      process.env[KILL_CALLBACK_ALLOWLIST_ENV] = 'orchestrator.svc.internal'

      // Suffix/substring near-misses must not match.
      expect(
        validateKillCallbackUrl('https://evil-orchestrator.svc.internal/kill')
      ).toContain('not externally routable')
      expect(
        validateKillCallbackUrl('https://a.orchestrator.svc.internal/kill')
      ).toContain('not externally routable')
    })
  })
})
