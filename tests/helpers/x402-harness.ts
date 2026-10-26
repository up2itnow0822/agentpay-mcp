/**
 * Test harness for the x402 paid path.
 *
 * Production makes the unpaid probe through the safe transport and hands a
 * 402 to `settle402AndRetry(probe, url, init, transport)`. Suites written
 * against the SDK's `fetch(url, init)` keep their mocks: the probe connector
 * answers 402, and the adapter routes `settle402AndRetry` to the mock fetch.
 *
 * If a suite has spied on `globalThis.fetch` (the session-credential path),
 * probes go to that spy instead so those expectations keep holding.
 */
import { vi } from 'vitest'
import { _setSafeTransportTestOverrides } from '../../src/utils/safe-fetch.js'
import { TEST_PUBLIC_ADDRESS } from '../setup/test-env.js'

export function install402ProbeConnector(): void {
  _setSafeTransportTestOverrides({
    resolver: async () => [{ address: TEST_PUBLIC_ADDRESS, family: 4 }],
    connector: async (url, init) => {
      if (vi.isMockFunction(globalThis.fetch)) {
        return globalThis.fetch(url.href, init)
      }
      return new Response(null, { status: 402 })
    },
  })
}

type LegacyClient = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  settle402AndRetry?: unknown
  [key: string]: unknown
}

/** Give a fetch-only SDK mock the settle402AndRetry surface production uses. */
export function withSettle<T extends LegacyClient>(client: T): T {
  if (typeof client.settle402AndRetry === 'function') return client
  return Object.assign(client, {
    settle402AndRetry: (_probe: Response, url: string, init?: RequestInit) =>
      client.fetch(url, init),
  })
}

/** Wrap a createX402Client mock implementation so its result is adapted. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function adaptX402Mock<F extends (...args: any[]) => any>(impl: F): F {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((...args: any[]) => withSettle(impl(...args))) as F
}
