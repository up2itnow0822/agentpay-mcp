/**
 * Tests for verify_agent_identity and get_reputation tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock agentwallet-sdk ──────────────────────────────────────────────────

vi.mock('agentwallet-sdk', () => ({
  ERC8004Client: vi.fn(),
  ReputationClient: vi.fn(),
}))

// ─── Mock client utils ─────────────────────────────────────────────────────

vi.mock('../src/utils/client.js', () => ({
  getConfig: vi.fn(() => ({
    chainId: 8453,
    walletAddress: '0x1234567890123456789012345678901234567890',
  })),
}))

import { handleVerifyAgentIdentity, handleGetReputation } from '../src/tools/identity.js'
import { ERC8004Client, ReputationClient } from 'agentwallet-sdk'
import { getAddress } from 'viem'
import { UNTRUSTED_BODY_BEGIN } from '../src/utils/format.js'

const MockERC8004Client = vi.mocked(ERC8004Client)
const MockReputationClient = vi.mocked(ReputationClient)

const OWNER = '0x00000000000000000000000000000000000000A1'
const WALLET = '0x00000000000000000000000000000000000000b2'
const UNREGISTERED = '0x00000000000000000000000000000000000000C3'
const CLIENT_1 = '0x00000000000000000000000000000000000000d4'
const CLIENT_2 = '0x00000000000000000000000000000000000000E5'

const MOCK_IDENTITY = {
  agentId: 42n,
  owner: OWNER,
  agentWallet: WALLET,
  agentURI: 'data:application/json,{"type":"agent-registration"}',
  registrationFile: { type: 'agent-registration', name: 'TestAgent' },
  modelMetadata: null,
}

describe('verify_agent_identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns identity when agent is registered', async () => {
    const mockLookupAgentByOwner = vi.fn().mockResolvedValue(MOCK_IDENTITY)
    MockERC8004Client.mockImplementation(function() {
      return { lookupAgentByOwner: mockLookupAgentByOwner }
    } as any)

    const result = await handleVerifyAgentIdentity({
      agentAddress: OWNER,
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.found).toBe(true)
    expect(data.agentId).toBe('42')
    expect(data.owner).toBe(getAddress(OWNER))
    expect(data.agentWallet).toBe(getAddress(WALLET))
    expect(data.ownerMatchesQuery).toBe(true)
    // Registry free text is NOT in the trusted summary...
    expect(data.agentURI).toBeUndefined()
    expect(data.registrationFile).toBeUndefined()
    expect(data.untrustedMetadata).toBe(true)
    // ...it is in the fenced second block.
    expect(result.content).toHaveLength(2)
    expect(result.content[1].text).toContain(UNTRUSTED_BODY_BEGIN)
    expect(result.content[1].text).toContain('TestAgent')
    expect(data.chain).toBe('base')
    expect(MockERC8004Client).toHaveBeenCalledWith({ chain: 'base' })
  })

  it('returns found=false when agent not registered', async () => {
    MockERC8004Client.mockImplementation(function() {
      return { lookupAgentByOwner: vi.fn().mockResolvedValue(null) }
    } as any)

    const result = await handleVerifyAgentIdentity({
      agentAddress: UNREGISTERED,
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.found).toBe(false)
    expect(data.agentAddress).toBe(getAddress(UNREGISTERED))
  })

  it('returns error when ERC8004Client call fails', async () => {
    MockERC8004Client.mockImplementation(function() {
      return { lookupAgentByOwner: vi.fn().mockRejectedValue(new Error('RPC timeout')) }
    } as any)

    const result = await handleVerifyAgentIdentity({
      agentAddress: OWNER,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('verify_agent_identity failed')
    expect(result.content[0].text).toContain('RPC timeout')
  })
})

describe('get_reputation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns reputation score for registered agent', async () => {
    MockERC8004Client.mockImplementation(function() {
      return { lookupAgentByOwner: vi.fn().mockResolvedValue(MOCK_IDENTITY) }
    } as any)
    MockReputationClient.mockImplementation(function() {
      return {
        getAgentReputation: vi.fn().mockResolvedValue({
          count: 10n,
          totalScore: 85n,
          avgCategory: 3,
          clients: [CLIENT_1, CLIENT_2],
        }),
      }
    } as any)

    const result = await handleGetReputation({
      agentAddress: OWNER,
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.found).toBe(true)
    expect(data.agentId).toBe('42')
    expect(data.reputation.count).toBe('10')
    expect(data.reputation.totalScore).toBe('85')
    expect(data.reputation.avgCategory).toBe(3)
    expect(data.reputation.clients).toEqual([getAddress(CLIENT_1), getAddress(CLIENT_2)])
    expect(data.reputation.clientCount).toBe(2)
    // Every reputation field validated, so there is no untrusted block.
    expect(data.untrustedMetadata).toBe(false)
    expect(result.content).toHaveLength(1)
  })

  it('returns found=false when identity not registered', async () => {
    MockERC8004Client.mockImplementation(function() {
      return { lookupAgentByOwner: vi.fn().mockResolvedValue(null) }
    } as any)

    const result = await handleGetReputation({
      agentAddress: UNREGISTERED,
    })

    expect(result.isError).toBeUndefined()
    const data = JSON.parse(result.content[0].text)
    expect(data.found).toBe(false)
    expect(MockReputationClient).not.toHaveBeenCalled()
  })

  it('returns error when reputation query fails', async () => {
    MockERC8004Client.mockImplementation(function() {
      return { lookupAgentByOwner: vi.fn().mockResolvedValue(MOCK_IDENTITY) }
    } as any)
    MockReputationClient.mockImplementation(function() {
      return { getAgentReputation: vi.fn().mockRejectedValue(new Error('Reputation contract not found')) }
    } as any)

    const result = await handleGetReputation({
      agentAddress: OWNER,
    })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('get_reputation failed')
    expect(result.content[0].text).toContain('Reputation contract not found')
  })
})
