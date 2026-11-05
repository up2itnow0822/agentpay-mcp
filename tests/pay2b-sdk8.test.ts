/**
 * pay-2b (agentwallet-sdk 8) security-officer conditions:
 *   C1 unverified opt-out rejected, C3 no secrets in config errors,
 *   C4 queued never paid, C6 structural broadcast flag (addendum 4a829f99).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  loadConfig,
  loadDeploymentIdentity,
  describeWalletIdentity,
  _resetSingletons,
} from '../src/utils/client.js'
import {
  runClassifiedSpend,
  DefiniteSpendFailure,
  BroadcastOutcomeUnknownError,
  QueuedSpendError,
  requireExecutedTransfer,
  requireExecutedCall,
} from '../src/utils/spend-intent.js'

const IDENTITY = {
  AGENT_WALLET_FACTORY: '0x7777777777777777777777777777777777777777',
  AGENT_WALLET_TOKEN_CONTRACT: '0x8888888888888888888888888888888888888888',
  AGENT_WALLET_TOKEN_ID: '1',
}
const SECRET_KEY = '0x' + '5e'.repeat(32)
const SECRET_RPC = 'https://base.example/v2/rpc-secret-api-key-9f3c'
const KEYS = ['AGENT_PRIVATE_KEY', 'AGENT_WALLET_ADDRESS', 'CHAIN_ID', 'RPC_URL', 'AGENT_WALLET_ALLOW_UNVERIFIED', 'AGENT_WALLET_CODE_HASH', ...Object.keys(IDENTITY)]
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  _resetSingletons()
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetSingletons()
})

describe('C1: AGENT_WALLET_ALLOW_UNVERIFIED is rejected for any non-empty value', () => {
  it.each(['true', 'TRUE', '1', ' true ', 'false', 'no', ' ', '\t'])('rejects %j', (value) => {
    expect(() => loadDeploymentIdentity({ ...IDENTITY, AGENT_WALLET_ALLOW_UNVERIFIED: value })).toThrow(
      /AGENT_WALLET_ALLOW_UNVERIFIED is not supported/
    )
  })
  it('ignores it only when empty', () => {
    expect(loadDeploymentIdentity({ ...IDENTITY, AGENT_WALLET_ALLOW_UNVERIFIED: '' }).deployment.tokenId).toBe(1n)
  })
  it('requires a deployment identity (fail closed), even with a code hash alone', () => {
    expect(() => loadDeploymentIdentity({})).toThrow(/Deployment identity required/)
    expect(() => loadDeploymentIdentity({ AGENT_WALLET_CODE_HASH: '0x' + '12'.repeat(32) })).toThrow(/Deployment identity required/)
  })
  it('rejects a partial identity', () => {
    expect(() => loadDeploymentIdentity({ AGENT_WALLET_FACTORY: IDENTITY.AGENT_WALLET_FACTORY })).toThrow()
  })
})

describe('C2/C3: identity line and config errors carry no secrets', () => {
  it('loadConfig error text never contains the private key or RPC URL', () => {
    process.env['AGENT_WALLET_ADDRESS'] = '0x1234567890123456789012345678901234567890'
    process.env['RPC_URL'] = SECRET_RPC
    const errors: string[] = []
    const attempt = () => { try { _resetSingletons(); loadConfig() } catch (e) { errors.push((e as Error).message) } }
    process.env['AGENT_PRIVATE_KEY'] = SECRET_KEY.slice(0, 40) // malformed key
    attempt()
    process.env['AGENT_PRIVATE_KEY'] = SECRET_KEY // valid key, no identity
    attempt()
    Object.assign(process.env, IDENTITY, { AGENT_WALLET_ALLOW_UNVERIFIED: 'true' })
    attempt()
    process.env['AGENT_WALLET_ALLOW_UNVERIFIED'] = ''
    process.env['AGENT_WALLET_TOKEN_ID'] = 'not-a-number'
    attempt()
    process.env['CHAIN_ID'] = 'tvm:-3'
    attempt()
    expect(errors.length).toBe(5)
    for (const m of errors) {
      expect(m).not.toContain(SECRET_KEY.slice(2, 40))
      expect(m).not.toContain('rpc-secret-api-key')
    }
  })
  it('startup identity line names identity only, never key or RPC', () => {
    Object.assign(process.env, IDENTITY, {
      AGENT_PRIVATE_KEY: SECRET_KEY,
      AGENT_WALLET_ADDRESS: '0x1234567890123456789012345678901234567890',
      RPC_URL: SECRET_RPC,
    })
    const line = describeWalletIdentity(loadConfig())
    expect(line).toContain('factory=0x7777777777777777777777777777777777777777')
    expect(line).toContain('tokenContract=0x8888888888888888888888888888888888888888')
    expect(line).toContain('tokenId=1')
    expect(line).toContain('codeHash=NOT SET')
    expect(line).not.toContain(SECRET_KEY.slice(2))
    expect(line).not.toContain('rpc-secret-api-key')
  })
})

describe('C6: structural broadcast flag (SO addendum 4a829f99)', () => {
  function fakeClient() {
    const sent: unknown[] = []
    return { sent, client: { writeContract: async (a: unknown) => { sent.push(a); return '0x' + 'aa'.repeat(32) } } }
  }

  it('(a) a generic error before the flag is a definite failure (releases)', async () => {
    const { client, sent } = fakeClient()
    await expect(runClassifiedSpend(client, async () => { throw new Error('rpc down') })).rejects.toBeInstanceOf(DefiniteSpendFailure)
    expect(sent).toHaveLength(0)
  })

  it('(b) any error after the flag never releases and exactly one tx was sent', async () => {
    for (const make of [
      () => new Error('rpc timeout'),
      () => new Error('execution reverted'),
      () => new DefiniteSpendFailure('claims to be definite'),
    ]) {
      const { client, sent } = fakeClient()
      const err = await runClassifiedSpend(client, async () => {
        await client.writeContract({})
        throw make()
      }).catch((e: unknown) => e)
      expect(err).not.toBeInstanceOf(DefiniteSpendFailure)
      expect(sent).toHaveLength(1)
    }
    const { client } = fakeClient()
    const wrapped = await runClassifiedSpend(client, async () => {
      await client.writeContract({})
      throw new DefiniteSpendFailure('x')
    }).catch((e: unknown) => e)
    expect(wrapped).toBeInstanceOf(BroadcastOutcomeUnknownError)
    expect((wrapped as BroadcastOutcomeUnknownError).retryable).toBe(false)
  })

  it('(c) the SDK 8 object return never releases and is never retryable', async () => {
    for (const result of [
      { status: 'queued', txHash: '0x' + 'bb'.repeat(32), pendingTxId: 9n },
      { status: 'unknown' },
      '0x' + 'cc'.repeat(32), // SDK 7 string shape is no longer accepted as paid
    ]) {
      const { client, sent } = fakeClient()
      const err = await runClassifiedSpend(client, async () => {
        await client.writeContract({})
        return requireExecutedTransfer(result, 'send_token')
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(DefiniteSpendFailure)
      expect(sent).toHaveLength(1)
    }
  })
})

describe('C4: queued results are never paid', () => {
  it('transfer: executed -> hash, queued -> QueuedSpendError (not definite)', () => {
    expect(requireExecutedTransfer({ status: 'executed', txHash: '0x01' }, 't')).toBe('0x01')
    const e = (() => { try { requireExecutedTransfer({ status: 'queued', pendingTxId: 3n }, 't') } catch (x) { return x } })()
    expect(e).toBeInstanceOf(QueuedSpendError)
    expect(e).not.toBeInstanceOf(DefiniteSpendFailure)
    expect((e as QueuedSpendError).retryable).toBe(false)
    expect((e as Error).message).toContain('not paid')
  })
  it('agentExecute: executed:false is queued, not paid', () => {
    expect(requireExecutedCall({ executed: true, txHash: '0x02' }, 'p')).toBe('0x02')
    expect(() => requireExecutedCall({ executed: false, txHash: '0x03', pendingTxId: 1n }, 'p')).toThrow(QueuedSpendError)
  })
})

describe('C3: formatError redacts RPC endpoints and key material', async () => {
  const { formatError, redactSecrets } = await import('../src/utils/format.js')
  const env = { RPC_URL: 'https://base.example/v2/SECRET_RPC_TOKEN', AGENT_PRIVATE_KEY: '0x' + 'ab'.repeat(32) }
  it('masks the viem URL field, the configured RPC_URL and the key', () => {
    const text = redactSecrets(
      `HTTP request failed.\nURL: ${env.RPC_URL}\nDetails: ${env.RPC_URL} ${env.AGENT_PRIVATE_KEY} private key ${'cd'.repeat(32)}`,
      env
    )
    expect(text).not.toContain('SECRET_RPC_TOKEN')
    expect(text).not.toContain('ab'.repeat(32))
    expect(text).not.toContain('cd'.repeat(32))
  })
  it('applies inside formatError', () => {
    const out = formatError(new Error('HTTP request failed.\nURL: https://rpc.example/v2/SECRET_RPC_TOKEN'), 'send_payment')
    expect(out).not.toContain('SECRET_RPC_TOKEN')
  })
})
