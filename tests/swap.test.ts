/** swap_tokens disabled on SDK 7.0.0 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleSwapTokens, SWAP_DISABLED_MESSAGE } from '../src/tools/swap.js'
import { attachSwap } from 'agentwallet-sdk'
vi.mock('agentwallet-sdk', async (i) => ({ ...(await i()), attachSwap: vi.fn() }))
describe('swap_tokens', () => {
  beforeEach(() => vi.clearAllMocks())
  it('fails closed before signing', async () => {
    const r = await handleSwapTokens({ fromSymbol: 'USDC', toSymbol: 'WETH', amount: '1', chainId: 8453 })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toMatch(/disabled/i)
    expect(attachSwap).not.toHaveBeenCalled()
  })
  it('SWAP_DISABLED_MESSAGE names SDK 8', () => expect(SWAP_DISABLED_MESSAGE).toMatch(/8\.x/))
})