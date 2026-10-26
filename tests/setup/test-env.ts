/**
 * Global test environment.
 *
 * - Most suites exercise payment handlers without an operator spend policy;
 *   production defaults to deny in that case, so the suite opts into the
 *   documented on-chain-limits-only mode. Suites that test the default-deny
 *   contract delete this variable locally.
 * - The safe transport's network edges (DNS + socket I/O) are substituted so
 *   unit tests never touch the network and existing `globalThis.fetch` spies
 *   keep working. All destination validation still runs. The real pinned
 *   node:http connector is covered end to end in tests/safe-fetch.test.ts.
 */
import { beforeEach } from 'vitest'
import { _setSafeTransportTestOverrides } from '../../src/utils/safe-fetch.js'

/** A public (non-reserved) address so DNS validation passes in unit tests. */
export const TEST_PUBLIC_ADDRESS = '93.184.215.14'

export function installDefaultTransportOverrides(): void {
  _setSafeTransportTestOverrides({
    resolver: async () => [{ address: TEST_PUBLIC_ADDRESS, family: 4 }],
    connector: (url, init) => globalThis.fetch(url.href, init),
  })
}

process.env.AGENTPAY_ALLOW_UNPOLICED_SPEND = '1'
installDefaultTransportOverrides()

beforeEach(() => {
  process.env.AGENTPAY_ALLOW_UNPOLICED_SPEND = '1'
  installDefaultTransportOverrides()
})
