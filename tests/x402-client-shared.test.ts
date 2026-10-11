import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifySpendError, isEvmTxHash } from 'agentwallet-sdk'
import { requireSettlementHash } from '../src/utils/spend-intent.js'

const x402Source = readFileSync(new URL('../src/tools/x402.ts', import.meta.url), 'utf8')
const sessionSource = readFileSync(new URL('../src/tools/session.ts', import.meta.url), 'utf8')
const clientSource = readFileSync(new URL('../src/utils/x402-client.ts', import.meta.url), 'utf8')
const budgetSource = readFileSync(new URL('../src/tools/budget.ts', import.meta.url), 'utf8')
const spendIntentSource = readFileSync(new URL('../src/utils/spend-intent.ts', import.meta.url), 'utf8')

describe('shared x402 client and SDK outcomes', () => {
  it('uses one AgentPay x402 factory from both paid-fetch tools', () => {
    expect(clientSource).toContain('export function createAgentPayX402Client')
    expect(clientSource).toContain('createX402Client(wallet')
    expect(clientSource).toContain('reserveSpendPolicy')
    expect(clientSource).toContain('commitSpendReservation')
    expect(clientSource).toContain('releaseSpendReservation')
    expect(x402Source).toContain("from '../utils/x402-client.js'")
    expect(x402Source).toContain('createAgentPayX402Client')
    expect(x402Source).not.toContain('createX402Client(')
    expect(sessionSource).toContain("from '../utils/x402-client.js'")
    expect(sessionSource).toContain('createAgentPayX402Client')
    expect(sessionSource).not.toContain('createX402Client(')
  })

  it('reserves, commits, and releases through the SDK SpendingPolicy surface', () => {
    expect(budgetSource).toContain('policy.reserve(')
    expect(budgetSource).toContain('policy.commit(')
    expect(budgetSource).toContain('policy.release(')
    expect(budgetSource).toContain('policy.lock(')
    expect(budgetSource).toContain('policy.applyOutcome(')
    expect(budgetSource).not.toContain('spendWindow')
  })

  it('classifies settlement hashes and spend errors with the SDK helpers', () => {
    expect(spendIntentSource).toContain('classifySpendError')
    expect(spendIntentSource).toContain('isEvmTxHash')
    expect(isEvmTxHash(`0x${'ab'.repeat(32)}`)).toBe(true)
    expect(isEvmTxHash('pending')).toBe(false)
    expect(requireSettlementHash(`0x${'ab'.repeat(32)}`, 'send_token')).toBe(
      `0x${'ab'.repeat(32)}`
    )
    expect(classifySpendError(new Error('quote rpc timeout')).status).toBe(
      'hold-unknown'
    )
    expect(classifySpendError(new Error('merchant not on allowlist')).status).toBe(
      'released'
    )
  })
})
