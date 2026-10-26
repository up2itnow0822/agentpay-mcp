/**
 * tokens.ts — lookup_token, add_custom_token, list_chain_tokens tools.
 *
 * Wraps agentwallet-sdk v6 TokenRegistry for MCP access.
 *
 * Resource bounds (CWE-400 hardening)
 * -----------------------------------
 * The SDK's global TokenRegistry is process-wide and never evicts, so every
 * entry add_custom_token writes is retained for the life of the server. The
 * tool therefore:
 *   - bounds every caller-supplied field at the schema layer (symbol charset
 *     and length, name length and control characters, a real non-zero EVM
 *     address, and a chainId from CUSTOM_TOKEN_CHAIN_IDS);
 *   - tracks its own registrations in module-level Maps, giving O(1)
 *     duplicate/alias lookup instead of a linear registry scan per add;
 *   - enforces MAX_CUSTOM_TOKENS_PER_CHAIN and MAX_CUSTOM_TOKENS_TOTAL, failing
 *     closed (nothing registered) once either is reached.
 * list_chain_tokens is paginated (offset/limit, limit ≤ LIST_TOKENS_MAX_LIMIT)
 * and flattens caller-supplied symbol/name text with sanitizeUntrustedInline.
 */
import { z } from 'zod'
import { getGlobalRegistry } from 'agentwallet-sdk'
import { isAddress, zeroAddress } from 'viem'
import {
  textContent,
  formatError,
  noControlChars,
  sanitizeUntrustedInline,
} from '../utils/format.js'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

// ─── Bounds ────────────────────────────────────────────────────────────────

/**
 * Chains add_custom_token may register on.
 *
 * Mirrors the server's supported wallet chains (src/utils/client.ts CHAIN_MAP:
 * 8453 Base Mainnet, 84532 Base Sepolia). send_token, swap_tokens and
 * get_balances are bound to the configured CHAIN_ID (see
 * src/utils/wallet-chain.ts), which must be one of these, so a custom token on
 * any other chain could never be spent and would only grow the registry.
 * client.ts does not export its map, so the list is restated here; keep the
 * two in sync.
 */
export const CUSTOM_TOKEN_CHAIN_IDS = [8453, 84532] as const

/** Max custom tokens add_custom_token will retain per chain. */
export const MAX_CUSTOM_TOKENS_PER_CHAIN = 64
/**
 * Max custom tokens add_custom_token will retain across all chains.
 * Deliberately below MAX_CUSTOM_TOKENS_PER_CHAIN × CUSTOM_TOKEN_CHAIN_IDS.length
 * (128) so the global bound is a real constraint, not dead code.
 */
export const MAX_CUSTOM_TOKENS_TOTAL = 96

export const TOKEN_SYMBOL_MAX_LEN = 16
export const TOKEN_SYMBOL_PATTERN = /^[A-Za-z0-9._-]+$/
export const TOKEN_NAME_MAX_LEN = 64

export const LIST_TOKENS_DEFAULT_LIMIT = 50
export const LIST_TOKENS_MAX_LIMIT = 100

/** Lookup-symbol cap: looser than registration, but still bounded. */
const LOOKUP_SYMBOL_MAX_LEN = 32

// ─── Shared output shaping ─────────────────────────────────────────────────

type RegistryToken = {
  symbol: string
  address: string
  decimals: number
  chainId: number
  name?: string
  isNative?: boolean
}

/**
 * Render a registry entry for a tool result. Symbol and name can be
 * caller-supplied text (via add_custom_token), so they are flattened and capped.
 */
function presentToken(token: RegistryToken): Record<string, unknown> {
  return {
    symbol: sanitizeUntrustedInline(token.symbol, TOKEN_SYMBOL_MAX_LEN),
    name: sanitizeUntrustedInline(token.name ?? token.symbol, TOKEN_NAME_MAX_LEN),
    address: sanitizeUntrustedInline(token.address, 42),
    decimals: token.decimals,
    chainId: token.chainId,
    isNative: token.isNative === true,
  }
}

// ─── lookup_token ──────────────────────────────────────────────────────────

export const LookupTokenSchema = z.object({
  symbol: noControlChars(z.string().min(1).max(LOOKUP_SYMBOL_MAX_LEN)).describe(
    'Token symbol, e.g. "USDC"'
  ),
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
      symbol: {
        type: 'string',
        description: 'Token symbol (e.g. "USDC", "WETH")',
        minLength: 1,
        maxLength: LOOKUP_SYMBOL_MAX_LEN,
      },
      chainId: { type: 'integer', description: 'Chain ID (e.g. 8453 for Base Mainnet)' },
    },
    required: ['symbol', 'chainId'],
  },
}

export async function handleLookupToken(input: LookupTokenInput): Promise<ToolResult> {
  try {
    const registry = getGlobalRegistry()
    const token = registry.getToken(input.symbol.toUpperCase(), input.chainId)
    if (!token) {
      return {
        content: [
          textContent(
            JSON.stringify({
              found: false,
              symbol: sanitizeUntrustedInline(input.symbol, LOOKUP_SYMBOL_MAX_LEN),
              chainId: input.chainId,
            })
          ),
        ],
      }
    }
    return {
      content: [textContent(JSON.stringify({ found: true, ...presentToken(token) }))],
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
  symbol: z
    .string()
    .min(1)
    .max(TOKEN_SYMBOL_MAX_LEN)
    .regex(TOKEN_SYMBOL_PATTERN, 'symbol may contain only letters, digits, ".", "_" and "-"')
    .describe('Token symbol (1–16 chars: letters, digits, ".", "_", "-")'),
  address: z
    .string()
    .refine((v) => isAddress(v), {
      message: 'address must be a valid 0x-prefixed 20-byte EVM address (EIP-55 checksum if mixed case)',
    })
    .refine((v) => v.toLowerCase() !== zeroAddress, {
      message: 'address must not be the zero address',
    })
    .describe('Token contract address (0x-prefixed)'),
  decimals: z.number().int().min(0).max(18).describe('Token decimal precision'),
  chainId: z
    .number()
    .int()
    .refine((v) => (CUSTOM_TOKEN_CHAIN_IDS as readonly number[]).includes(v), {
      message: `chainId must be one of the supported chains: ${CUSTOM_TOKEN_CHAIN_IDS.join(', ')}`,
    })
    .describe('Chain ID where this token lives (8453 Base Mainnet or 84532 Base Sepolia)'),
  name: noControlChars(z.string().min(1).max(TOKEN_NAME_MAX_LEN))
    .optional()
    .describe('Human-readable token name (optional, defaults to symbol)'),
})

export type AddCustomTokenInput = z.infer<typeof AddCustomTokenSchema>

export const addCustomTokenTool = {
  name: 'add_custom_token',
  description:
    'Register a custom ERC-20 token in the global token registry so it can be used ' +
    'by send_token, get_balances, and swap_tokens. Refuses to overwrite an existing ' +
    'symbol+chain entry or to alias an already-registered contract with different ' +
    'decimals (including built-ins such as USDC) because a wrong decimals value ' +
    'would silently overpay on later transfers and swaps. Only supported chains ' +
    `(${CUSTOM_TOKEN_CHAIN_IDS.join(', ')}) are accepted, and the server retains at most ` +
    `${MAX_CUSTOM_TOKENS_PER_CHAIN} custom tokens per chain and ${MAX_CUSTOM_TOKENS_TOTAL} ` +
    'in total until restart.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      symbol: {
        type: 'string',
        description: 'Token symbol (letters, digits, ".", "_", "-")',
        minLength: 1,
        maxLength: TOKEN_SYMBOL_MAX_LEN,
        pattern: '^[A-Za-z0-9._-]+$',
      },
      address: {
        type: 'string',
        description: 'Token contract address (0x-prefixed, non-zero)',
        pattern: '^0x[0-9a-fA-F]{40}$',
      },
      decimals: {
        type: 'integer',
        description: 'Token decimal precision (0–18)',
        minimum: 0,
        maximum: 18,
      },
      chainId: {
        type: 'integer',
        description: 'Chain ID (8453 Base Mainnet, 84532 Base Sepolia)',
        enum: [...CUSTOM_TOKEN_CHAIN_IDS],
      },
      name: {
        type: 'string',
        description: 'Human-readable name (optional, no control characters)',
        minLength: 1,
        maxLength: TOKEN_NAME_MAX_LEN,
      },
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

function asIdentity(token: RegistryToken | undefined): CustomTokenIdentity | undefined {
  if (!token) return undefined
  return {
    symbol: token.symbol,
    address: token.address,
    decimals: token.decimals,
    chainId: token.chainId,
  }
}

// ─── Custom-registration tracking (quota + O(1) alias index) ───────────────

/** Custom registrations made through this tool, keyed `${chainId}:${SYMBOL}`. */
const customBySymbol = new Map<string, CustomTokenIdentity>()
/** Custom registrations made through this tool, keyed `${chainId}:${addressLower}`. */
const customByAddress = new Map<string, CustomTokenIdentity>()
/** Count of custom registrations per chain. */
const customCountByChain = new Map<number, number>()
/**
 * Snapshot of the registry's pre-existing (built-in) entries per chain, keyed
 * `${chainId}:${addressLower}`. Taken once per chain on first use; the only
 * in-tree writer of the global registry is this tool, so later entries are
 * all in customByAddress.
 */
const builtinAddressIndex = new Map<number, Map<string, CustomTokenIdentity>>()

function addressKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`
}

function builtinIndexFor(
  chainId: number,
  registry: ReturnType<typeof getGlobalRegistry>
): Map<string, CustomTokenIdentity> {
  let index = builtinAddressIndex.get(chainId)
  if (index) return index
  index = new Map()
  const listed = registry.listTokens(chainId)
  for (const token of Array.isArray(listed) ? listed : []) {
    const key = addressKey(chainId, token.address)
    if (!index.has(key)) index.set(key, asIdentity(token)!)
  }
  builtinAddressIndex.set(chainId, index)
  return index
}

/** Current custom-token usage, for diagnostics and tests. */
export function getCustomTokenQuotaUsage(): { total: number; byChain: Record<number, number> } {
  return {
    total: customBySymbol.size,
    byChain: Object.fromEntries(customCountByChain),
  }
}

/**
 * Test-only: forget tracked custom registrations and the built-in snapshot.
 * Does NOT remove entries from the SDK's global registry.
 */
export function _resetCustomTokenQuota(): void {
  customBySymbol.clear()
  customByAddress.clear()
  customCountByChain.clear()
  builtinAddressIndex.clear()
}

function assertQuotaAvailable(chainId: number): void {
  const onChain = customCountByChain.get(chainId) ?? 0
  if (onChain >= MAX_CUSTOM_TOKENS_PER_CHAIN) {
    throw new Error(
      `Custom token limit reached for chain ${chainId} ` +
        `(${MAX_CUSTOM_TOKENS_PER_CHAIN} per chain). Nothing was registered. ` +
        `Restart the server to clear in-process custom entries.`
    )
  }
  if (customBySymbol.size >= MAX_CUSTOM_TOKENS_TOTAL) {
    throw new Error(
      `Custom token limit reached (${MAX_CUSTOM_TOKENS_TOTAL} total across all chains). ` +
        `Nothing was registered. Restart the server to clear in-process custom entries.`
    )
  }
}

export async function handleAddCustomToken(input: AddCustomTokenInput): Promise<ToolResult> {
  try {
    // Re-assert the schema invariants: handlers can be called directly
    // (tests, embedders) without going through the dispatcher's zod parse.
    const checked = AddCustomTokenSchema.parse(input)

    const registry = getGlobalRegistry()
    const symbol = checked.symbol.toUpperCase()
    const incoming: CustomTokenIdentity = {
      symbol,
      address: checked.address,
      decimals: checked.decimals,
      chainId: checked.chainId,
    }
    const existing = registry.getToken(symbol, checked.chainId)

    const aKey = addressKey(checked.chainId, checked.address)
    const byAddress =
      customByAddress.get(aKey) ?? builtinIndexFor(checked.chainId, registry).get(aKey)
    const existingByAddress =
      byAddress && byAddress.symbol.toUpperCase() !== symbol ? byAddress : undefined

    const decision = decideCustomTokenRegistration(
      asIdentity(existing),
      incoming,
      existingByAddress
    )

    if (decision === 'register') {
      assertQuotaAvailable(checked.chainId)
      registry.addToken({
        symbol,
        address: checked.address as `0x${string}`,
        decimals: checked.decimals,
        chainId: checked.chainId,
        name: checked.name ?? checked.symbol,
      })
      // Record only after the registry write succeeded.
      const sKey = `${checked.chainId}:${symbol}`
      if (!customBySymbol.has(sKey)) {
        customCountByChain.set(
          checked.chainId,
          (customCountByChain.get(checked.chainId) ?? 0) + 1
        )
      }
      customBySymbol.set(sKey, incoming)
      if (!customByAddress.has(aKey)) customByAddress.set(aKey, incoming)
    }

    const token = registry.getToken(symbol, checked.chainId)
    return {
      content: [
        textContent(
          JSON.stringify({
            success: true,
            idempotent: decision === 'idempotent',
            token: token ? presentToken(token) : null,
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
  chainId: z.number().int().min(1).describe('Chain ID to list tokens for, e.g. 8453'),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Number of tokens to skip (default 0)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(LIST_TOKENS_MAX_LIMIT)
    .optional()
    .describe(
      `Max tokens to return (default ${LIST_TOKENS_DEFAULT_LIMIT}, max ${LIST_TOKENS_MAX_LIMIT})`
    ),
})

export type ListChainTokensInput = z.infer<typeof ListChainTokensSchema>

export const listChainTokensTool = {
  name: 'list_chain_tokens',
  description:
    'List tokens registered for a given chain ID in the global token registry, ' +
    `paginated (offset/limit; limit defaults to ${LIST_TOKENS_DEFAULT_LIMIT}, max ` +
    `${LIST_TOKENS_MAX_LIMIT}). Returns total and nextOffset (null on the last page).`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      chainId: {
        type: 'integer',
        description: 'Chain ID (e.g. 8453 for Base Mainnet)',
        minimum: 1,
      },
      offset: {
        type: 'integer',
        description: 'Number of tokens to skip (default 0)',
        minimum: 0,
      },
      limit: {
        type: 'integer',
        description: `Max tokens to return (default ${LIST_TOKENS_DEFAULT_LIMIT})`,
        minimum: 1,
        maximum: LIST_TOKENS_MAX_LIMIT,
      },
    },
    required: ['chainId'],
  },
}

export async function handleListChainTokens(input: ListChainTokensInput): Promise<ToolResult> {
  try {
    // Clamp even when called directly without the zod parse.
    const rawOffset = Number.isSafeInteger(input.offset) ? (input.offset as number) : 0
    const offset = Math.max(0, rawOffset)
    const rawLimit = Number.isSafeInteger(input.limit)
      ? (input.limit as number)
      : LIST_TOKENS_DEFAULT_LIMIT
    const limit = Math.min(LIST_TOKENS_MAX_LIMIT, Math.max(1, rawLimit))

    const registry = getGlobalRegistry()
    const listed = registry.listTokens(input.chainId)
    const all = Array.isArray(listed) ? listed : []
    const page = all.slice(offset, offset + limit)
    const end = offset + page.length
    return {
      content: [
        textContent(
          JSON.stringify({
            chainId: input.chainId,
            total: all.length,
            offset,
            limit,
            count: page.length,
            nextOffset: end < all.length ? end : null,
            tokens: page.map(presentToken),
          })
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
