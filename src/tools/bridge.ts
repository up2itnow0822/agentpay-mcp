/**
 * bridge.ts — bridge_usdc tool.
 *
 * Route A (MCP 5.0.0): the MCP handler is DISABLED — schema retained, no
 * on-chain CCTP execution via the tool surface. Execution logic lives in
 * `handleBridgeUsdcExecution` (see bridge-usdc-execution.ts) for tests and a
 * future re-enable.
 */
import { z } from 'zod'
import { textContent, formatError } from '../utils/format.js'
import {
  DefiniteSpendFailure,
  IDEMPOTENCY_KEY_JSON_SCHEMA,
  IdempotencyKeyZodSchema,
} from '../utils/spend-intent.js'

export { handleBridgeUsdcExecution } from './bridge-usdc-execution.js'

// Supported CCTP V2 chain names
const SUPPORTED_CHAINS = [
  'base', 'ethereum', 'optimism', 'arbitrum', 'polygon',
  'avalanche', 'linea', 'unichain', 'sonic', 'worldchain',
] as const

// ─── Schema ────────────────────────────────────────────────────────────────

export const BridgeUsdcSchema = z.object({
  fromChain: z
    .enum(SUPPORTED_CHAINS)
    .describe('Source chain name (e.g. "base", "ethereum", "arbitrum")'),
  toChain: z
    .enum(SUPPORTED_CHAINS)
    .describe('Destination chain name (e.g. "polygon", "optimism")'),
  amount: z
    .string()
    .describe('Amount of USDC to bridge in human-readable units, e.g. "100" for 100 USDC'),
  idempotencyKey: IdempotencyKeyZodSchema.optional()
    .describe(
      'Caller-supplied idempotency key. Distinct keys allow two equal bridges; ' +
        'the same key replays the original bridge; reusing it with a different ' +
        'payload is refused. MCP retries without a key still collapse on the ' +
        'settled payload for five minutes.'
    ),
})

export type BridgeUsdcInput = z.infer<typeof BridgeUsdcSchema>

// ─── Tool definition ───────────────────────────────────────────────────────

export const bridgeUsdcTool = {
  name: 'bridge_usdc',
  description:
    'Bridge USDC across chains using Circle\'s CCTP V2 protocol. ' +
    'DISABLED in AgentPay MCP 5.0.0 (route A): the tool is registered for schema ' +
    'compatibility and returns a disabled error without any on-chain bridge. ' +
    'Supported chains when re-enabled: base, ethereum, optimism, arbitrum, polygon, ' +
    'avalanche, linea, unichain, sonic, worldchain.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      fromChain: {
        type: 'string',
        enum: [...SUPPORTED_CHAINS],
        description: 'Source chain name',
      },
      toChain: {
        type: 'string',
        enum: [...SUPPORTED_CHAINS],
        description: 'Destination chain name',
      },
      amount: {
        type: 'string',
        description: 'Amount of USDC to bridge (human-readable, e.g. "100")',
      },
      idempotencyKey: {
        ...IDEMPOTENCY_KEY_JSON_SCHEMA,
        description:
          'Optional idempotency key (1-128 non-whitespace chars). Distinct keys allow two equal bridges.',
      },
    },
    required: ['fromChain', 'toChain', 'amount'],
  },
}

// ─── Handler ───────────────────────────────────────────────────────────────

/** MCP tool surface: route A disabled (no on-chain call). */
export async function handleBridgeUsdc(
  _input: BridgeUsdcInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    throw new DefiniteSpendFailure(
      'bridge_usdc is disabled in AgentPay MCP 5.0.0 (route A). ' +
        'The tool keeps its schema for compatibility; no on-chain CCTP bridge is performed.'
    )
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'bridge_usdc'))],
      isError: true,
    }
  }
}