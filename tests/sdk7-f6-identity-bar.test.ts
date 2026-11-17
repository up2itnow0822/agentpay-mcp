/**
 * SO #6 — verify_agent_uaid 5.0.x identity bar (a–d).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Address } from 'viem'
import * as identityIo from '../src/utils/identity-io-guard.js'
import { ERC8004Client } from 'agentwallet-sdk'
import {
  UAID_ON_CHAIN_VERIFICATION_NOTE,
  handleVerifyAgentUAID,
} from '../src/tools/identity.js'

const UAID =
  'uaid:aid:eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;uid=42;proto=erc8004'
const AGENT = '0x1234567890123456789012345678901234567890' as Address
const ATTACKER_PAYMENT = '0xdeadbeef00000000000000000000000000000001' as Address
const OTHER_CHAIN = 'eip155:1'

const BROKER_SCALAR_KEYS = [
  'agentId',
  'owner',
  'paymentAddress',
  'agentWallet',
  'brokerChain',
  'chain',
] as const

function walkSrcTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent)
    if (statSync(p).isDirectory()) out.push(...walkSrcTsFiles(p))
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p)
  }
  return out
}

function parseTrustedSummary(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text) as Record<string, unknown>
}

function assertBrokerClaimsNotInTrusted(
  summary: Record<string, unknown>,
  sensitive: string[]
): void {
  expect(summary.verified).toBe(false)
  expect(summary.onChainVerified).toBe(false)
  for (const key of BROKER_SCALAR_KEYS) {
    expect(summary).not.toHaveProperty(key)
  }
  expect(summary.identity).toBeNull()
  const serialized = JSON.stringify(summary)
  for (const value of sensitive) {
    if (value.length > 0) {
      expect(serialized.toLowerCase()).not.toContain(value.toLowerCase())
    }
  }
}

describe('SO #6 verify_agent_uaid 5.0.x bar', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('#6(a) src scan finds no code path that sets verified to true', () => {
    const root = new URL('../src', import.meta.url).pathname
    const offenders = walkSrcTsFiles(root).filter((file) => {
      const text = readFileSync(file, 'utf8')
      return (
        /\bverified\b\s*[=:]\s*true\b/.test(text) ||
        /['"]verified['"]\s*:\s*true\b/.test(text) ||
        /trusted\[['"]verified['"]\]\s*=\s*true/.test(text)
      )
    })
    expect(offenders).toEqual([])
  })

  it('#6(b) broker agentId owner chain and paymentAddress appear only in untrusted block', async () => {
    const resolver = identityIo.createBoundedUaidResolver()
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      resolved: true,
      uaid: UAID,
      protocol: 'erc8004',
      chain: 'eip155:8453',
      registryVerified: true,
      identity: {
        agentId: '42',
        owner: AGENT,
        paymentAddress: ATTACKER_PAYMENT,
        chain: 'eip155:8453',
        protocol: 'erc8004',
      },
    })
    vi.spyOn(identityIo, 'createBoundedUaidResolver').mockReturnValue(resolver as never)
    const result = await handleVerifyAgentUAID({ uaid: UAID })
    const summary = parseTrustedSummary(result)
    assertBrokerClaimsNotInTrusted(summary, [ATTACKER_PAYMENT, AGENT])
    expect(result.content[1]).toBeDefined()
    const fenced = result.content[1]!.text
    expect(fenced).toMatch(/agentId/)
    expect(fenced).toMatch(/paymentAddress/)
    expect(fenced.toLowerCase()).toContain(getAddress(ATTACKER_PAYMENT).toLowerCase())
    expect(fenced.toLowerCase()).toContain(getAddress(AGENT).toLowerCase())
  })

  it('#6(c) tool output states the identity is not verified on-chain', async () => {
    const resolver = identityIo.createBoundedUaidResolver()
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      resolved: true,
      uaid: UAID,
      protocol: 'erc8004',
      chain: 'eip155:8453',
      registryVerified: false,
      identity: null,
    })
    vi.spyOn(identityIo, 'createBoundedUaidResolver').mockReturnValue(resolver as never)
    const result = await handleVerifyAgentUAID({ uaid: UAID })
    const summary = parseTrustedSummary(result)
    expect(summary.verificationNote).toBe(UAID_ON_CHAIN_VERIFICATION_NOTE)
    expect(String(summary.verificationNote)).toMatch(/not performed.*on-chain|on-chain.*not performed/i)
    expect(result.content[0].text).toMatch(/on-chain/i)
  })

  it('#6(d1) hostile broker matching agentId keeps verified false and broker claims out of trusted', async () => {
    const resolver = identityIo.createBoundedUaidResolver()
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      resolved: true,
      uaid: UAID,
      protocol: 'erc8004',
      chain: 'eip155:8453',
      registryVerified: true,
      identity: {
        agentId: '42',
        owner: AGENT,
        paymentAddress: AGENT,
        chain: 'eip155:8453',
        protocol: 'erc8004',
      },
    })
    vi.spyOn(identityIo, 'createBoundedUaidResolver').mockReturnValue(resolver as never)
    const lookup = vi.spyOn(ERC8004Client.prototype, 'lookupAgentIdentity')
    const result = await handleVerifyAgentUAID({ uaid: UAID })
    const summary = parseTrustedSummary(result)
    assertBrokerClaimsNotInTrusted(summary, [AGENT])
    expect(summary.brokerAttested).toBe(true)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('#6(d2) hostile broker wrong chain keeps verified false and broker claims out of trusted', async () => {
    const resolver = identityIo.createBoundedUaidResolver()
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      resolved: true,
      uaid: UAID,
      protocol: 'erc8004',
      chain: OTHER_CHAIN,
      registryVerified: true,
      identity: {
        agentId: '42',
        owner: AGENT,
        chain: OTHER_CHAIN,
        protocol: 'erc8004',
      },
    })
    vi.spyOn(identityIo, 'createBoundedUaidResolver').mockReturnValue(resolver as never)
    const lookup = vi.spyOn(ERC8004Client.prototype, 'lookupAgentIdentity')
    const result = await handleVerifyAgentUAID({ uaid: UAID })
    const summary = parseTrustedSummary(result)
    assertBrokerClaimsNotInTrusted(summary, [OTHER_CHAIN, AGENT])
    expect(lookup).not.toHaveBeenCalled()
  })

  it('#6(d3) hostile broker attacker payment address keeps verified false and broker claims out of trusted', async () => {
    const resolver = identityIo.createBoundedUaidResolver()
    vi.spyOn(resolver, 'resolve').mockResolvedValue({
      resolved: true,
      uaid: UAID,
      protocol: 'erc8004',
      chain: 'eip155:8453',
      registryVerified: true,
      identity: {
        agentId: '42',
        owner: AGENT,
        paymentAddress: ATTACKER_PAYMENT,
        chain: 'eip155:8453',
        protocol: 'erc8004',
      },
    })
    vi.spyOn(identityIo, 'createBoundedUaidResolver').mockReturnValue(resolver as never)
    const lookup = vi.spyOn(ERC8004Client.prototype, 'lookupAgentIdentity')
    const result = await handleVerifyAgentUAID({ uaid: UAID })
    const summary = parseTrustedSummary(result)
    assertBrokerClaimsNotInTrusted(summary, [ATTACKER_PAYMENT, AGENT])
    expect(lookup).not.toHaveBeenCalled()
  })
})