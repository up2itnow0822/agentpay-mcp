/**
 * tokens.ts — lookup_token, add_custom_token, list_chain_tokens tools.
 *
 * Wraps agentwallet-sdk v6 TokenRegistry for MCP access.
 */
import { z } from 'zod'
import { getGlobalRegistry } from 'agentwallet-sdk'
import { textContent, formatError } from '../utils/format.js'

// ─── lookup_token ──────────────────────────────────────────────────────────

export const LookupTokenSchema = z.object({
  symbol: z.string().describe('Token symbol, e.g. "USDC"'),
  chainId: z.number().int().describe('Chain ID, e.g. 8453 for Base Mainnet'),
})

export type LookupTokenInput = z.infer<typeof LookupTokenSchema>

export const lookupTokenTool = {
  name: 'lookup_token',
  description:
    'Look up a token by symbol and chain ID from the global token registry. ' +
    'Returns the token address, decimals, and metadata if found.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      symbol: { type: 'string', description: 'Token symbol (e.g. "USDC", "WETH")' },
      chainId: { type: 'number', description: 'Chain ID (e.g. 8453 for Base Mainnet)' },
    },
    required: ['symbol', 'chainId'],
  },
}

export async function handleLookupToken(
  input: LookupTokenInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const registry = getGlobalRegistry()
    const token = registry.getToken(input.symbol.toUpperCase(), input.chainId)
    if (!token) {
      return {
        content: [
          textContent(
            JSON.stringify({ found: false, symbol: input.symbol, chainId: input.chainId })
          ),
        ],
      }
    }
    return {
      content: [textContent(JSON.stringify({ found: true, ...token }))],
    }
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'lookup_token'))],
      isError: true,
    }
  }
}

// ─── add_custom_token ──────────────────────────────────────────────────────

export const AddCustomTokenSchema = z.object({
  symbol: z.string().describe('Token symbol'),
  address: z.string().describe('Token contract address (0x-prefixed)'),
  decimals: z.number().int().min(0).max(18).describe('Token decimal precision'),
  chainId: z.number().int().describe('Chain ID where this token lives'),
  name: z.string().optional().describe('Human-readable token name (optional, defaults to symbol)'),
})

export type AddCustomTokenInput = z.infer<typeof AddCustomTokenSchema>

export const addCustomTokenTool = {
  name: 'add_custom_token',
  description:
    'Register a custom ERC-20 token in the global token registry so it can be used ' +
    'by send_token, get_balances, and swap_tokens. Refuses to overwrite an existing ' +
    'symbol+chain entry or to alias an already-registered contract with different ' +
    'decimals (including built-ins such as USDC) because a wrong decimals value ' +
    'would silently overpay on later transfers and swaps.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      symbol: { type: 'string', description: 'Token symbol' },
      address: { type: 'string', description: 'Token contract address (0x-prefixed)' },
      decimals: { type: 'number', description: 'Token decimal precision (0–18)' },
      chainId: { type: 'number', description: 'Chain ID' },
      name: { type: 'string', description: 'Human-readable name (optional)' },
    },
    required: ['symbol', 'address', 'decimals', 'chainId'],
  },
}

/** Existing or incoming token identity used to decide registration. */
export type CustomTokenIdentity = {
  symbol: string
  address: string
  decimals: number
  chainId: number
}

/**
 * Decide whether a custom token may be written into the process-global registry.
 *
 * send_token / swap_tokens convert human amounts with registry decimals
 * (`parseAmount("10", 18)` vs `parseAmount("10", 6)` is a 10^12 overpay for
 * USDC). Spend-policy scaling treats 1 whole token as 1 unit either way, so
 * a poisoned decimals value is not caught by budget checks. Refuse any
 * address or decimals change for an existing symbol+chain. Identical
 * re-registration is idempotent. A new symbol that reuses an existing
 * contract address with different decimals is also refused: send_token
 * of FAKEUSDC against USDC's address at 18 decimals overpays by 10^12.
 * Same-decimals aliases of an already-registered address are allowed.
 */
export function decideCustomTokenRegistration(
  existingBySymbol: CustomTokenIdentity | undefined,
  incoming: CustomTokenIdentity,
  existingByAddress?: CustomTokenIdentity
): 'register' | 'idempotent' {
  if (existingBySymbol) {
    const sameAddress =
      existingBySymbol.address.toLowerCase() === incoming.address.toLowerCase()
    const sameDecimals = existingBySymbol.decimals === incoming.decimals
    if (sameAddress && sameDecimals) return 'idempotent'

    const symbol = incoming.symbol.toUpperCase()
    throw new Error(
      `Token "${symbol}" is already registered on chain ${incoming.chainId} ` +
        `at ${existingBySymbol.address} with ${existingBySymbol.decimals} decimals. ` +
        `add_custom_token refuses to overwrite address or decimals because ` +
        `send_token and swap_tokens convert human amounts using registry decimals ` +
        `(changing USDC from 6 to 18 would overpay by 10^12). ` +
        `Restart the server to clear in-process custom entries.`
    )
  }

  if (existingByAddress) {
    const sameDecimals = existingByAddress.decimals === incoming.decimals
    if (sameDecimals) return 'register'

    const existingSymbol = existingByAddress.symbol.toUpperCase()
    const incomingSymbol = incoming.symbol.toUpperCase()
    throw new Error(
      `Address ${existingByAddress.address} is already registered on chain ` +
        `${incoming.chainId} as "${existingSymbol}" with ` +
        `${existingByAddress.decimals} decimals. ` +
        `add_custom_token refuses to register "${incomingSymbol}" against ` +
        `the same contract with ${incoming.decimals} decimals because ` +
        `send_token and swap_tokens convert human amounts using registry decimals ` +
        `(a FAKEUSDC alias of USDC at 18 decimals would overpay by 10^12). ` +
        `A different symbol does not bypass the decimals lock.`
    )
  }

  return 'register'
}

function asIdentity(
  token:
    | {
        symbol: string
        address: string
        decimals: number
        chainId: number
      }
    | undefined
): CustomTokenIdentity | undefined {
  if (!token) return undefined
  return {
    symbol: token.symbol,
    address: token.address,
    decimals: token.decimals,
    chainId: token.chainId,
  }
}

export async function handleAddCustomToken(
  input: AddCustomTokenInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const registry = getGlobalRegistry()
    const symbol = input.symbol.toUpperCase()
    const incoming: CustomTokenIdentity = {
      symbol,
      address: input.address,
      decimals: input.decimals,
      chainId: input.chainId,
    }
    const existing = registry.getToken(symbol, input.chainId)
    const listed = registry.listTokens(input.chainId)
    const tokensOnChain = Array.isArray(listed) ? listed : []
    const existingByAddressToken = tokensOnChain.find(
      (token) => token.address.toLowerCase() === incoming.address.toLowerCase()
    )
    const existingByAddress =
      existingByAddressToken &&
      existingByAddressToken.symbol.toUpperCase() !== symbol
        ? asIdentity(existingByAddressToken)
        : undefined
    const decision = decideCustomTokenRegistration(
      asIdentity(existing),
      incoming,
      existingByAddress
    )

    if (decision === 'register') {
      registry.addToken({
        symbol,
        address: input.address as `0x${string}`,
        decimals: input.decimals,
        chainId: input.chainId,
        name: input.name ?? input.symbol,
      })
    }

    const token = registry.getToken(symbol, input.chainId)
    return {
      content: [
        textContent(
          JSON.stringify({
            success: true,
            idempotent: decision === 'idempotent',
            token,
          })
        ),
      ],
    }
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'add_custom_token'))],
      isError: true,
    }
  }
}

// ─── list_chain_tokens ─────────────────────────────────────────────────────

export const ListChainTokensSchema = z.object({
  chainId: z.number().int().describe('Chain ID to list tokens for, e.g. 8453'),
})

export type ListChainTokensInput = z.infer<typeof ListChainTokensSchema>

export const listChainTokensTool = {
  name: 'list_chain_tokens',
  description:
    'List all tokens registered for a given chain ID in the global token registry.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      chainId: { type: 'number', description: 'Chain ID (e.g. 8453 for Base Mainnet)' },
    },
    required: ['chainId'],
  },
}

export async function handleListChainTokens(
  input: ListChainTokensInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const registry = getGlobalRegistry()
    const tokens = registry.listTokens(input.chainId)
    return {
      content: [
        textContent(
          JSON.stringify({ chainId: input.chainId, count: tokens.length, tokens })
        ),
      ],
    }
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'list_chain_tokens'))],
      isError: true,
    }
  }
}
